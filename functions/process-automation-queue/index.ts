/**
 * Process Automation Queue Edge Function
 *
 * Processes pending emails from the email_automation_queue table.
 * Designed to be called by a cron job (e.g., every 5 minutes).
 *
 * Features:
 * - Batch processing with concurrency control
 * - Email template resolution
 * - Retry logic for failed sends
 * - Performance tracking
 *
 * Usage:
 * POST /process-automation-queue
 * { "batchSize": 20, "concurrency": 3, "dryRun": false }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  defaultBatchSize: 20,
  defaultConcurrency: 3,
  maxAttempts: 3,
};

// =============================================================================
// Request Schema
// =============================================================================

const processQueueSchema = z.object({
  batchSize: z.number().optional(),
  concurrency: z.number().optional(),
  dryRun: z.boolean().optional(),
}).optional();

type ProcessQueueRequest = z.infer<typeof processQueueSchema>;

// =============================================================================
// Types
// =============================================================================

interface AutomationQueueItem {
  id: string;
  enrollment_id: string;
  flow_id: string;
  profile_id: string;
  step_index: number;
  scheduled_for: string;
  status: string;
  attempts: number;
  email_data: {
    subject?: string;
    html?: string;
    text?: string;
    template_slug?: string;
    to?: string;
  };
}

interface ProcessResult {
  id: string;
  success: boolean;
  provider?: string;
  messageId?: string;
  error?: string;
  latencyMs: number;
}

interface ProcessQueueResponse {
  success: boolean;
  message: string;
  dryRun: boolean;
  processed: number;
  successful: number;
  failed: number;
  avgLatencyMs: number;
  byProvider: Record<string, { success: number; failed: number }>;
  errors: { id: string; error?: string }[];
  durationMs: number;
}

// =============================================================================
// Email Resolution
// =============================================================================

async function resolveEmailContent(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  emailData: AutomationQueueItem["email_data"],
  profileId: string
): Promise<{ subject: string; html: string; to: string } | null> {
  // Get profile email
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, first_name, nickname")
    .eq("id", profileId)
    .single();

  if (!profile?.email) {
    return null;
  }

  // If template_slug is provided, fetch template
  if (emailData.template_slug) {
    const { data: template } = await supabase
      .from("email_templates")
      .select("subject, html_content")
      .eq("slug", emailData.template_slug)
      .eq("is_active", true)
      .single();

    if (template) {
      const name = profile.first_name || profile.nickname || "there";
      const subject = template.subject.replace(/\{\{name\}\}/g, name);
      const html = template.html_content
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{email\}\}/g, profile.email);

      return { subject, html, to: profile.email };
    }
  }

  // Use direct email data
  if (emailData.subject && emailData.html) {
    const name = profile.first_name || profile.nickname || "there";
    const subject = emailData.subject.replace(/\{\{name\}\}/g, name);
    const html = emailData.html
      .replace(/\{\{name\}\}/g, name)
      .replace(/\{\{email\}\}/g, profile.email);

    return { subject, html, to: profile.email };
  }

  return null;
}

// =============================================================================
// Email Sending
// =============================================================================

async function sendEmailViaEdgeFunction(
  to: string,
  subject: string,
  html: string,
  provider: string = "resend"
): Promise<{ success: boolean; provider?: string; messageId?: string; error?: string }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return { success: false, error: "Missing Supabase configuration" };
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        action: "send",
        to,
        subject,
        html,
        provider,
      }),
    });

    const result = await response.json();
    return {
      success: result.success === true,
      provider: result.provider,
      messageId: result.messageId,
      error: result.message || result.error,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to call email function",
    };
  }
}

// =============================================================================
// Queue Item Processing
// =============================================================================

async function processQueueItem(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  item: AutomationQueueItem,
  dryRun: boolean
): Promise<ProcessResult> {
  const startTime = performance.now();

  try {
    // Mark as processing
    if (!dryRun) {
      await supabase
        .from("email_automation_queue")
        .update({
          status: "processing",
          attempts: item.attempts + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
    }

    // Resolve email content
    const emailContent = await resolveEmailContent(supabase, item.email_data, item.profile_id);

    if (!emailContent) {
      if (!dryRun) {
        await supabase
          .from("email_automation_queue")
          .update({
            status: "failed",
            error_message: "Could not resolve email content or recipient",
            updated_at: new Date().toISOString(),
          })
          .eq("id", item.id);
      }

      return {
        id: item.id,
        success: false,
        error: "Could not resolve email content or recipient",
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    if (dryRun) {
      return {
        id: item.id,
        success: true,
        provider: "dry_run",
        messageId: "dry_run_" + item.id,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }

    // Send email
    const result = await sendEmailViaEdgeFunction(
      emailContent.to,
      emailContent.subject,
      emailContent.html
    );

    if (result.success) {
      await supabase.rpc("mark_automation_email_sent", {
        p_queue_id: item.id,
        p_provider: result.provider || "unknown",
        p_message_id: result.messageId || "",
      });

      return {
        id: item.id,
        success: true,
        provider: result.provider,
        messageId: result.messageId,
        latencyMs: Math.round(performance.now() - startTime),
      };
    } else {
      const newStatus = item.attempts + 1 >= CONFIG.maxAttempts ? "failed" : "pending";

      await supabase
        .from("email_automation_queue")
        .update({
          status: newStatus,
          error_message: result.error || "Unknown error",
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);

      return {
        id: item.id,
        success: false,
        error: result.error,
        latencyMs: Math.round(performance.now() - startTime),
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (!dryRun) {
      await supabase
        .from("email_automation_queue")
        .update({
          status: "failed",
          error_message: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
    }

    return {
      id: item.id,
      success: false,
      error: errorMessage,
      latencyMs: Math.round(performance.now() - startTime),
    };
  }
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleProcessQueue(
  ctx: HandlerContext<ProcessQueueRequest>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const startTime = performance.now();

  const batchSize = body?.batchSize || CONFIG.defaultBatchSize;
  const concurrency = body?.concurrency || CONFIG.defaultConcurrency;
  const dryRun = body?.dryRun || false;

  logger.info("Processing automation queue", {
    batchSize,
    concurrency,
    dryRun,
    requestId: requestCtx?.requestId,
  });

  // Fetch pending queue items
  const now = new Date().toISOString();
  const { data: queueItems, error: fetchError } = await supabase
    .from("email_automation_queue")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", now)
    .order("scheduled_for", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    logger.error("Failed to fetch queue", { error: fetchError.message });
    return new Response(
      JSON.stringify({
        success: false,
        error: `Failed to fetch queue: ${fetchError.message}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!queueItems?.length) {
    const response: ProcessQueueResponse = {
      success: true,
      message: "No pending automation emails to process",
      dryRun,
      processed: 0,
      successful: 0,
      failed: 0,
      avgLatencyMs: 0,
      byProvider: {},
      errors: [],
      durationMs: Math.round(performance.now() - startTime),
    };

    return ok(response, ctx);
  }

  // Process in chunks for concurrency control
  const results: ProcessResult[] = [];
  for (let i = 0; i < queueItems.length; i += concurrency) {
    const chunk = queueItems.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((item) => processQueueItem(supabase, item as AutomationQueueItem, dryRun))
    );
    results.push(...chunkResults);
  }

  // Summarize results
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const byProvider: Record<string, { success: number; failed: number }> = {};
  for (const r of results) {
    const provider = r.provider || "unknown";
    if (!byProvider[provider]) byProvider[provider] = { success: 0, failed: 0 };
    if (r.success) byProvider[provider].success++;
    else byProvider[provider].failed++;
  }

  const avgLatencyMs = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length)
    : 0;

  logger.info("Queue processing complete", {
    processed: results.length,
    successful: successful.length,
    failed: failed.length,
    dryRun,
    durationMs: Math.round(performance.now() - startTime),
  });

  const response: ProcessQueueResponse = {
    success: true,
    message: dryRun ? "Dry run completed" : "Automation queue processed",
    dryRun,
    processed: results.length,
    successful: successful.length,
    failed: failed.length,
    avgLatencyMs,
    byProvider,
    errors: failed.map((f) => ({ id: f.id, error: f.error })),
    durationMs: Math.round(performance.now() - startTime),
  };

  return ok(response, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "process-automation-queue",
  version: CONFIG.version,
  requireAuth: false, // Cron job - service-level
  routes: {
    POST: {
      schema: processQueueSchema,
      handler: handleProcessQueue,
    },
    GET: {
      handler: handleProcessQueue, // Also support GET for cron
    },
  },
});
