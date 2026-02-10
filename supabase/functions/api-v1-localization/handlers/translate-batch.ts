/**
 * Batch Translation Handler
 *
 * Queues content for translation to all supported locales.
 * Called by backfill handlers when content needs translation.
 *
 * Features:
 * - Queue-based architecture (reliable, no fire-and-forget issues)
 * - Stores tasks in translation_queue table
 * - Processed by separate cron job (process-queue)
 * - Deduplicates by content/field/locale
 *
 * Usage:
 * POST /localization/translate-batch
 * {
 *   "content_type": "post" | "challenge" | "forum_post",
 *   "content_id": "uuid",
 *   "fields": [
 *     { "name": "title", "text": "Fresh organic apples" },
 *     { "name": "description", "text": "Picked from my garden..." }
 *   ]
 * }
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";

// Top 5 priority locales for batch translation
const TARGET_LOCALES = ["ru", "es", "de", "fr", "pt"];

interface Field {
  name: string;
  text: string;
}

interface BatchTranslateRequest {
  content_type: "post" | "challenge" | "forum_post";
  content_id: string;
  fields: Field[];
}

interface BatchTranslateResponse {
  accepted: boolean;
  queued: number;
  content_type: string;
  content_id: string;
  fields_count: number;
  locales_count: number;
  total_translations: number;
}

export default async function translateBatchHandler(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
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
    const body: BatchTranslateRequest = await req.json();
    const { content_type, content_id, fields } = body;

    // Validate input
    if (!content_type || !["post", "challenge", "forum_post"].includes(content_type)) {
      return new Response(JSON.stringify({
        success: false,
        error: "Invalid content_type. Must be 'post', 'challenge', or 'forum_post'.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!content_id) {
      return new Response(JSON.stringify({
        success: false,
        error: "content_id is required.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "fields array is required and must not be empty.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client
    const supabase = getSupabaseClient();

    // Build queue items for all field/locale combinations
    const queueItems: Array<{
      content_type: string;
      content_id: string;
      field_name: string;
      source_text: string;
      target_locale: string;
      status: string;
    }> = [];

    for (const field of fields) {
      // Skip empty text
      if (!field.text || field.text.trim().length === 0) {
        continue;
      }

      for (const locale of TARGET_LOCALES) {
        queueItems.push({
          content_type,
          content_id,
          field_name: field.name,
          source_text: field.text,
          target_locale: locale,
          status: "pending",
        });
      }
    }

    // Insert into queue (upsert to handle duplicates)
    let queuedCount = 0;
    if (queueItems.length > 0) {
      const { error, count } = await supabase
        .from("translation_queue")
        .upsert(queueItems, {
          onConflict: "content_type,field_name,source_text,target_locale",
          ignoreDuplicates: true,
          count: "exact",
        });

      if (error) {
        logger.error("Failed to queue translations", error);
        return new Response(JSON.stringify({
          success: false,
          error: `Failed to queue translations: ${error.message}`,
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      queuedCount = count || queueItems.length;
    }

    const response: BatchTranslateResponse = {
      accepted: true,
      queued: queuedCount,
      content_type,
      content_id,
      fields_count: fields.length,
      locales_count: TARGET_LOCALES.length,
      total_translations: queueItems.length,
    };

    logger.info("Batch translation queued", response);

    return new Response(JSON.stringify(response), {
      status: 202, // Accepted
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error("Batch translation error", error as Error);
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message,
    }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
