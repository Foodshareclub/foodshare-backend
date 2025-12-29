/**
 * Process Automation Queue Edge Function
 *
 * Processes pending emails from the email_automation_queue table.
 * Designed to be called by a cron job (e.g., every 5 minutes).
 *
 * Actions:
 * - Fetches pending emails that are due
 * - Sends emails via the email edge function
 * - Updates queue status and enrollment progress
 */

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@^2.47.10";

const VERSION = "1.0.0";

// ============================================================================
// Supabase Client
// ============================================================================

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !key) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}

// ============================================================================
// CORS Helpers
// ============================================================================

function getPermissiveCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

function handleCorsPrelight(): Response {
  return new Response("ok", { headers: getPermissiveCorsHeaders(), status: 204 });
}

// ============================================================================
// Types
// ============================================================================

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

interface Payload {
  batchSize?: number;
  concurrency?: number;
  dryRun?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function createResponse(
  data: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
  requestId: string
): Response {
  return new Response(JSON.stringify({ ...data, requestId, version: VERSION }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      "X-Version": VERSION,
    },
  });
}

// ============================================================================
// Email Template Resolver
// ============================================================================

async function resolveEmailContent(
  supabase: ReturnType<typeof getSupabaseClient>,
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
      // Replace variables in template
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

// ============================================================================
// Send Email via Edge Function
// ============================================================================

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

// ============================================================================
// Process Single Queue Item
// ============================================================================

async function processQueueItem(
  supabase: ReturnType<typeof getSupabaseClient>,
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
      // Mark as failed - no valid email content
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

    // Send email via edge function
    const result = await sendEmailViaEdgeFunction(
      emailContent.to,
      emailContent.subject,
      emailContent.html
    );

    if (result.success) {
      // Call the database function to mark as sent and advance enrollment
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
      // Mark as failed or pending retry
      const maxAttempts = 3;
      const newStatus = item.attempts + 1 >= maxAttempts ? "failed" : "pending";

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

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight();
  }

  const corsHeaders = getPermissiveCorsHeaders();
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    const payload: Payload = req.method === "POST" ? await req.json() : {};
    const batchSize = payload.batchSize || 20;
    const concurrency = payload.concurrency || 3;
    const dryRun = payload.dryRun || false;

    const supabase = getSupabaseClient();

    // Fetch pending queue items that are due
    const now = new Date().toISOString();
    const { data: queueItems, error: fetchError } = await supabase
      .from("email_automation_queue")
      .select("*")
      .eq("status", "pending")
      .lte("scheduled_for", now)
      .order("scheduled_for", { ascending: true })
      .limit(batchSize);

    if (fetchError) {
      return createResponse(
        {
          success: false,
          error: `Failed to fetch queue: ${fetchError.message}`,
        },
        500,
        corsHeaders,
        requestId
      );
    }

    if (!queueItems?.length) {
      return createResponse(
        {
          success: true,
          message: "No pending automation emails to process",
          processed: 0,
          durationMs: Math.round(performance.now() - startTime),
        },
        200,
        corsHeaders,
        requestId
      );
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

    return createResponse(
      {
        success: true,
        message: dryRun ? "Dry run completed" : "Automation queue processed",
        dryRun,
        processed: results.length,
        successful: successful.length,
        failed: failed.length,
        avgLatencyMs:
          results.length > 0
            ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length)
            : 0,
        byProvider,
        errors: failed.map((f) => ({ id: f.id, error: f.error })),
        durationMs: Math.round(performance.now() - startTime),
      },
      200,
      corsHeaders,
      requestId
    );
  } catch (error) {
    console.error("[process-automation-queue] Error:", error);

    return createResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        durationMs: Math.round(performance.now() - startTime),
      },
      500,
      corsHeaders,
      requestId
    );
  }
});
