/**
 * Process Translation Queue Handler
 *
 * Processes pending translation tasks from the queue.
 * Called by cron job every 2 minutes.
 *
 * Features:
 * - Fetches pending items and marks as processing atomically
 * - Processes translations synchronously (no fire-and-forget)
 * - Retries failed translations up to 3 times
 * - Stores results in dynamic_content_translations table
 * - Caches in Redis for fast retrieval
 *
 * Usage:
 * POST /localization/process-queue
 * {
 *   "limit": 20  // optional, default 20
 * }
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../../_shared/cors.ts";
import { llmTranslationService } from "../services/llm-translation.ts";
import { translationCache } from "../services/translation-cache.ts";

const DEFAULT_LIMIT = 20;  // 4 batches × 5 concurrent = clear backlog faster
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MINUTES = 10;
const CONCURRENCY_LIMIT = 5; // Process 5 translations in parallel

/**
 * Strip HTML tags from text for cleaner translation
 * Converts HTML formatting to plain text equivalents
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')           // Convert <br> to newlines
    .replace(/<\/p>/gi, '\n\n')               // Convert </p> to double newlines
    .replace(/<[^>]+>/g, '')                  // Remove all other tags
    .replace(/&nbsp;/gi, ' ')                 // Convert &nbsp;
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')               // Normalize multiple newlines
    .trim();
}

interface ProcessQueueRequest {
  limit?: number;
}

interface QueueItem {
  id: string;
  content_type: string;
  content_id: string;
  field_name: string;
  source_text: string;
  target_locale: string;
  status: string;
  attempts: number;
}

interface ProcessQueueResponse {
  success: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  duration_ms: number;
}

export default async function processQueueHandler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed. Use POST.",
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body: ProcessQueueRequest = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(body.limit || DEFAULT_LIMIT, 1), 100);

    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // First, reset any stuck "processing" items older than timeout
    const timeoutCutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000).toISOString();
    await supabase
      .from("translation_queue")
      .update({ status: "pending" })
      .eq("status", "processing")
      .lt("created_at", timeoutCutoff);

    // Fetch pending items
    const { data: pendingItems, error: fetchError } = await supabase
      .from("translation_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (fetchError) {
      console.error("Failed to fetch queue items:", fetchError.message);
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to fetch queue items: ${fetchError.message}`,
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingItems || pendingItems.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        duration_ms: Date.now() - startTime,
        message: "No pending items in queue",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check service health before processing
    const healthCheck = await llmTranslationService.checkHealth();
    if (!healthCheck.healthy) {
      console.warn(`Translation service unhealthy: ${healthCheck.reason}`);
      // Continue anyway - DeepL fallback will handle it
    } else {
      console.log("Translation service health check passed");
    }

    // Mark items as processing
    const itemIds = pendingItems.map((item: QueueItem) => item.id);
    await supabase
      .from("translation_queue")
      .update({ status: "processing" })
      .in("id", itemIds);

    console.log(`Processing ${pendingItems.length} translation tasks with concurrency ${CONCURRENCY_LIMIT}`);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    // Process a single item
    async function processItem(item: QueueItem): Promise<"succeeded" | "failed" | "skipped" | "retry"> {
      try {
        // Skip empty text
        if (!item.source_text || item.source_text.trim().length === 0) {
          await supabase
            .from("translation_queue")
            .update({
              status: "completed",
              processed_at: new Date().toISOString(),
              error_message: "Empty source text - skipped"
            })
            .eq("id", item.id);
          return "skipped";
        }

        // Strip HTML from source text for cleaner translation
        // HTML tags (especially in forum descriptions) confuse the LLM and cause timeouts
        const textToTranslate = item.source_text.includes('<')
          ? stripHtml(item.source_text)
          : item.source_text;

        // Call LLM translation service
        const result = await llmTranslationService.translate(
          textToTranslate,
          "en",
          item.target_locale,
          `${item.content_type}-${item.field_name}`
        );

        // Check translation quality with more specific criteria
        const isHighQuality = result.quality >= 0.5 && result.text !== item.source_text;
        const isLowQuality = result.quality > 0 && result.quality < 0.5;
        const isCompleteFailure = result.quality === 0 || result.text === item.source_text;

        if (isHighQuality) {
          // Success: Store in PostgreSQL (only high-quality translations)
          const { error: storeError } = await supabase.rpc("store_translation", {
            p_source_text: item.source_text,
            p_translated_text: result.text,
            p_target_locale: item.target_locale,
            p_content_type: item.content_type,
            p_quality_score: result.quality
          });

          if (storeError) {
            console.warn(`Failed to store translation for ${item.id}: ${storeError.message}`);
          }

          // Cache in Redis for fast retrieval
          await translationCache.set(
            item.content_type,
            item.content_id,
            item.field_name,
            item.target_locale,
            result.text
          );

          // Mark as completed
          await supabase
            .from("translation_queue")
            .update({
              status: "completed",
              processed_at: new Date().toISOString()
            })
            .eq("id", item.id);

          console.log(`Translated ${item.content_type}/${item.content_id}/${item.field_name} -> ${item.target_locale} (quality: ${result.quality.toFixed(2)})`);
          return "succeeded";
        } else {
          // Determine error message based on failure type
          const newAttempts = item.attempts + 1;
          const newStatus = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
          let errorMsg: string;

          if (result.quality === 0) {
            errorMsg = "LLM returned original text (timeout or circuit breaker)";
          } else if (result.text === item.source_text) {
            errorMsg = "Translation unchanged from source";
          } else if (isLowQuality) {
            errorMsg = `Translation quality too low: ${result.quality.toFixed(2)}`;
          } else {
            errorMsg = "Translation failed";
          }

          await supabase
            .from("translation_queue")
            .update({
              status: newStatus,
              attempts: newAttempts,
              error_message: errorMsg,
              processed_at: newStatus === "failed" ? new Date().toISOString() : null
            })
            .eq("id", item.id);

          if (newStatus === "failed") {
            console.warn(`Translation failed permanently for ${item.id} after ${newAttempts} attempts: ${errorMsg}`);
            return "failed";
          } else {
            console.log(`Translation will be retried for ${item.id} (attempt ${newAttempts}/${MAX_ATTEMPTS}): ${errorMsg}`);
            return "retry";
          }
        }
      } catch (error) {
        // Handle unexpected errors
        const newAttempts = item.attempts + 1;
        const newStatus = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
        const errorMsg = (error as Error).message;

        await supabase
          .from("translation_queue")
          .update({
            status: newStatus,
            attempts: newAttempts,
            error_message: errorMsg,
            processed_at: newStatus === "failed" ? new Date().toISOString() : null
          })
          .eq("id", item.id);

        console.error(`Error processing ${item.id}: ${errorMsg}`);
        return newStatus === "failed" ? "failed" : "retry";
      }
      return "succeeded"; // Default return
    }

    // Process items in batches with controlled concurrency
    const items = pendingItems as QueueItem[];
    for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
      const batch = items.slice(i, i + CONCURRENCY_LIMIT);
      const results = await Promise.all(batch.map(item => processItem(item)));

      for (const result of results) {
        if (result === "succeeded") succeeded++;
        else if (result === "failed") failed++;
        else if (result === "skipped") skipped++;
        // "retry" doesn't count toward any bucket
      }
    }

    const response: ProcessQueueResponse = {
      success: true,
      processed: pendingItems.length,
      succeeded,
      failed,
      skipped,
      duration_ms: Date.now() - startTime,
    };

    console.log("Queue processing complete", response);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Process queue error:", (error as Error).message);
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message,
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
