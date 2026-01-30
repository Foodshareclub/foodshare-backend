/**
 * Subscription Cron Handler
 *
 * Scheduled tasks for subscription management:
 * - Process Dead Letter Queue (DLQ) for failed events
 * - Update daily subscription metrics
 * - Clean up old events
 * - Send periodic health reports
 *
 * Should be called every 5 minutes via external cron (GitHub Actions, cron-job.org, etc.)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { sendDLQAlert, sendTelegramAlert } from "../_shared/telegram-alerts.ts";

const VERSION = "1.1.0";
const SERVICE = "subscription-cron";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

interface CronResult {
  dlq: {
    processed: number;
    expired: number;
    pending: number;
  };
  metrics: {
    updated: boolean;
    date: string;
  };
  cleanup: {
    deleted: number;
  } | null;
  healthReport: boolean;
}

function getServiceRoleClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Verify the cron request is authorized
 */
function verifyCronAuth(req: Request): boolean {
  // Check for cron secret in headers
  const authHeader = req.headers.get("X-Cron-Secret");
  if (authHeader && CRON_SECRET && authHeader === CRON_SECRET) {
    return true;
  }

  // Also accept Authorization Bearer token
  const bearerToken = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearerToken && CRON_SECRET && bearerToken === CRON_SECRET) {
    return true;
  }

  // Check for Supabase service role key (for internal calls)
  if (bearerToken === SUPABASE_SERVICE_ROLE_KEY) {
    return true;
  }

  return false;
}

/**
 * Process Dead Letter Queue
 */
async function processDLQ(
  supabase: ReturnType<typeof getServiceRoleClient>
): Promise<{ processed: number; expired: number; pending: number }> {
  try {
    // Call the DLQ processor function (using public wrapper)
    const { data, error } = await supabase.rpc("billing_process_dlq");

    if (error) {
      logger.error("Failed to process DLQ", new Error(error.message));
      return { processed: 0, expired: 0, pending: 0 };
    }

    // Get current pending count
    const { count } = await supabase
      .from("subscription_events_dlq")
      .select("*", { count: "exact", head: true })
      .is("resolved_at", null)
      .schema("billing");

    const result = {
      processed: data?.processed || 0,
      expired: data?.expired || 0,
      pending: count || 0,
    };

    // Alert if DLQ is growing
    if (result.pending > 20) {
      const { data: breakdown } = await supabase
        .from("subscription_events_dlq")
        .select("platform")
        .is("resolved_at", null)
        .schema("billing");

      const platformCounts: Record<string, number> = {};
      breakdown?.forEach((row: { platform: string }) => {
        platformCounts[row.platform] = (platformCounts[row.platform] || 0) + 1;
      });

      await sendDLQAlert(result.pending, platformCounts);
    }

    logger.info("DLQ processed", result);
    return result;
  } catch (error) {
    logger.error(
      "DLQ processing failed",
      error instanceof Error ? error : new Error(String(error))
    );
    return { processed: 0, expired: 0, pending: 0 };
  }
}

/**
 * Update daily metrics (only at midnight UTC)
 */
async function updateDailyMetrics(
  supabase: ReturnType<typeof getServiceRoleClient>
): Promise<{ updated: boolean; date: string }> {
  const now = new Date();
  const hour = now.getUTCHours();
  const date = now.toISOString().split("T")[0];

  // Only update at midnight UTC (0-1 hour window)
  if (hour !== 0) {
    return { updated: false, date };
  }

  try {
    const { data, error } = await supabase.rpc("billing_update_daily_metrics", {
      p_date: date,
    });

    if (error) {
      logger.error("Failed to update metrics", new Error(error.message));
      return { updated: false, date };
    }

    logger.info("Daily metrics updated", { date, data });
    return { updated: true, date };
  } catch (error) {
    logger.error(
      "Metrics update failed",
      error instanceof Error ? error : new Error(String(error))
    );
    return { updated: false, date };
  }
}

/**
 * Cleanup old events (only on Sundays at midnight)
 */
async function cleanupOldEvents(
  supabase: ReturnType<typeof getServiceRoleClient>
): Promise<{ deleted: number } | null> {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  // Only run on Sundays at midnight UTC
  if (day !== 0 || hour !== 0) {
    return null;
  }

  try {
    const { data, error } = await supabase.rpc("billing_cleanup_old_events", {
      p_retention_days: 90,
    });

    if (error) {
      logger.error("Failed to cleanup events", new Error(error.message));
      return { deleted: 0 };
    }

    const result = {
      deleted: (data?.deleted_events || 0) + (data?.deleted_dlq || 0),
    };

    logger.info("Old events cleaned up", data);
    return result;
  } catch (error) {
    logger.error(
      "Cleanup failed",
      error instanceof Error ? error : new Error(String(error))
    );
    return { deleted: 0 };
  }
}

/**
 * Send daily health report (once per day at 8am UTC)
 */
async function sendHealthReport(
  supabase: ReturnType<typeof getServiceRoleClient>
): Promise<boolean> {
  const now = new Date();
  const hour = now.getUTCHours();

  // Only send at 8am UTC
  if (hour !== 8) {
    return false;
  }

  try {
    // Get subscription health
    const { data: health } = await supabase
      .from("subscription_health")
      .select("*")
      .schema("billing");

    // Get yesterday's metrics
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const { data: metrics } = await supabase
      .from("subscription_metrics")
      .select("*")
      .eq("metric_date", yesterday)
      .schema("billing");

    // Get DLQ summary
    const { data: dlq } = await supabase
      .from("dlq_summary")
      .select("*")
      .schema("billing");

    await sendTelegramAlert(
      "low",
      "Daily Subscription Health Report",
      {
        Date: yesterday,
        "Active Subscriptions": health?.reduce(
          (sum: number, h: { active_count: number }) => sum + h.active_count,
          0
        ) || 0,
        "New Yesterday": metrics?.reduce(
          (sum: number, m: { new_subscriptions: number }) => sum + m.new_subscriptions,
          0
        ) || 0,
        "Churned Yesterday": metrics?.reduce(
          (sum: number, m: { churned_subscriptions: number }) => sum + m.churned_subscriptions,
          0
        ) || 0,
        "DLQ Pending": dlq?.reduce(
          (sum: number, d: { pending: number }) => sum + d.pending,
          0
        ) || 0,
      },
      { throttleKey: "health-report:daily" }
    );

    return true;
  } catch (error) {
    logger.error(
      "Health report failed",
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}

/**
 * Main handler
 */
async function handleCron(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeadersWithMobile(req);
  const startTime = performance.now();

  // Verify authorization
  if (!verifyCronAuth(req)) {
    logger.warn("Unauthorized cron request", {
      ip: req.headers.get("x-forwarded-for"),
    });
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = getServiceRoleClient();

  try {
    // Run all cron tasks
    const [dlqResult, metricsResult, cleanupResult, healthResult] =
      await Promise.all([
        processDLQ(supabase),
        updateDailyMetrics(supabase),
        cleanupOldEvents(supabase),
        sendHealthReport(supabase),
      ]);

    const result: CronResult = {
      dlq: dlqResult,
      metrics: metricsResult,
      cleanup: cleanupResult,
      healthReport: healthResult,
    };

    const durationMs = Math.round(performance.now() - startTime);

    logger.info("Cron completed", {
      ...result,
      durationMs,
    });

    return new Response(
      JSON.stringify({
        success: true,
        service: SERVICE,
        version: VERSION,
        timestamp: new Date().toISOString(),
        durationMs,
        result,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Cron failed", err);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        service: SERVICE,
        version: VERSION,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Health check handler
 */
function handleHealth(req: Request): Response {
  const corsHeaders = getCorsHeadersWithMobile(req);

  return new Response(
    JSON.stringify({
      status: "healthy",
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleMobileCorsPrelight(req);
  }

  // Health check
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return handleHealth(req);
  }

  // Main cron handler (POST only)
  if (req.method === "POST") {
    return handleCron(req);
  }

  // Default: run cron for GET requests too (for easy testing)
  if (req.method === "GET") {
    return handleCron(req);
  }

  return new Response("Method not allowed", { status: 405 });
});
