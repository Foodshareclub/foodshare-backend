/**
 * Unified Subscription API v1
 *
 * Consolidates sync-subscription + subscription-cron into a single API.
 *
 * Routes:
 * - GET  /             - Check current subscription status (JWT auth)
 * - POST /sync         - Sync subscription after purchase (JWT auth)
 * - POST /cron         - Run cron tasks: DLQ, metrics, cleanup, health report (cron auth)
 * - GET  /cron         - Run cron tasks (GET compat for cron triggers)
 * - GET  /health       - Health check (no auth)
 *
 * @module api-v1-subscription
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, created, type HandlerContext } from "../_shared/api-handler.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { ValidationError, AppError, ForbiddenError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { sendDLQAlert, sendTelegramAlert } from "../_shared/telegram-alerts.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "1.0.0";

// =============================================================================
// Schemas
// =============================================================================

const syncSubscriptionSchema = z.object({
  platform: z.enum(["apple", "google_play", "stripe"]).default("apple"),
  originalTransactionId: z.string().min(1, "originalTransactionId is required"),
  transactionId: z.string().min(1, "transactionId is required"),
  productId: z.string().min(1, "productId is required"),
  bundleId: z.string().min(1, "bundleId is required"),
  purchaseDate: z.number().int().positive(),
  originalPurchaseDate: z.number().int().positive().optional(),
  expiresDate: z.number().int().positive().optional(),
  environment: z.enum(["Production", "Sandbox"]).default("Production"),
  appAccountToken: z.string().uuid().optional(),
  status: z
    .enum(["active", "expired", "in_grace_period", "in_billing_retry", "revoked"])
    .default("active"),
  autoRenewStatus: z.boolean().default(true),
  autoRenewProductId: z.string().optional(),
});

type SyncSubscriptionBody = z.infer<typeof syncSubscriptionSchema>;

// =============================================================================
// Service Role Client (for cron tasks)
// =============================================================================

function getServiceRoleClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// =============================================================================
// Cron Auth
// =============================================================================

function verifyCronAuth(request: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = request.headers.get("X-Cron-Secret");
  if (authHeader && cronSecret && authHeader === cronSecret) return true;

  const bearerToken = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearerToken && cronSecret && bearerToken === cronSecret) return true;
  if (bearerToken === serviceRoleKey) return true;

  // Supabase cron header
  if (request.headers.get("x-supabase-cron") === "true") return true;

  return false;
}

// =============================================================================
// Sync Handlers (from sync-subscription)
// =============================================================================

async function handleSyncSubscription(
  ctx: HandlerContext<SyncSubscriptionBody>,
): Promise<Response> {
  const { body, userId, supabase } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  logger.info("Syncing subscription", {
    userId,
    platform: body.platform,
    originalTransactionId: body.originalTransactionId,
    productId: body.productId,
    status: body.status,
    environment: body.environment,
  });

  if (body.appAccountToken && body.appAccountToken !== userId) {
    logger.warn("App account token mismatch", {
      expected: userId,
      received: body.appAccountToken,
    });
  }

  const { data: subscriptionId, error: upsertError } = await supabase.rpc(
    "billing.upsert_subscription",
    {
      p_user_id: userId,
      p_platform: body.platform,
      p_original_transaction_id: body.originalTransactionId,
      p_product_id: body.productId,
      p_bundle_id: body.bundleId,
      p_status: body.status,
      p_purchase_date: new Date(body.purchaseDate).toISOString(),
      p_original_purchase_date: body.originalPurchaseDate
        ? new Date(body.originalPurchaseDate).toISOString()
        : new Date(body.purchaseDate).toISOString(),
      p_expires_date: body.expiresDate ? new Date(body.expiresDate).toISOString() : null,
      p_auto_renew_status: body.autoRenewStatus,
      p_auto_renew_product_id: body.autoRenewProductId || null,
      p_environment: body.environment,
      p_app_account_token: body.appAccountToken || userId,
    },
  );

  if (upsertError) {
    logger.error("Failed to sync subscription", new Error(upsertError.message), {
      userId,
      originalTransactionId: body.originalTransactionId,
    });
    throw new AppError("Failed to sync subscription", "SUBSCRIPTION_SYNC_FAILED", 500);
  }

  logger.info("Subscription synced successfully", {
    userId,
    subscriptionId,
    originalTransactionId: body.originalTransactionId,
    status: body.status,
  });

  const { data: subscription, error: fetchError } = await supabase.rpc(
    "billing.get_user_subscription",
    { p_user_id: userId },
  );

  if (fetchError) {
    logger.warn("Failed to fetch subscription after sync", {
      error: fetchError.message,
      userId,
    });
  }

  return created(
    {
      subscription_id: subscriptionId,
      synced: true,
      subscription: subscription || {
        subscription_id: subscriptionId,
        platform: body.platform,
        product_id: body.productId,
        status: body.status,
        expires_date: body.expiresDate ? new Date(body.expiresDate).toISOString() : null,
        auto_renew_status: body.autoRenewStatus,
        is_active: body.status === "active" || body.status === "in_grace_period",
        environment: body.environment,
      },
    },
    ctx,
  );
}

async function handleCheckSubscription(ctx: HandlerContext): Promise<Response> {
  const { userId, supabase } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const { data: subscription, error } = await supabase.rpc(
    "billing.get_user_subscription",
    { p_user_id: userId },
  );

  if (error) {
    logger.error("Failed to get subscription", new Error(error.message), { userId });
    throw new AppError("Failed to get subscription status", "SUBSCRIPTION_FETCH_FAILED", 500);
  }

  const { data: isPremium } = await supabase.rpc("billing.is_user_premium", {
    p_user_id: userId,
  });

  return ok({ is_premium: isPremium ?? false, subscription: subscription || null }, ctx);
}

// =============================================================================
// Cron Handlers (from subscription-cron)
// =============================================================================

interface CronResult {
  dlq: { processed: number; expired: number; pending: number };
  metrics: { updated: boolean; date: string };
  cleanup: { deleted: number } | null;
  healthReport: boolean;
}

async function processDLQ(
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<{ processed: number; expired: number; pending: number }> {
  try {
    const { data, error } = await supabase.rpc("billing_process_dlq");

    if (error) {
      logger.error("Failed to process DLQ", new Error(error.message));
      return { processed: 0, expired: 0, pending: 0 };
    }

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
    logger.error("DLQ processing failed", error instanceof Error ? error : new Error(String(error)));
    return { processed: 0, expired: 0, pending: 0 };
  }
}

async function updateDailyMetrics(
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<{ updated: boolean; date: string }> {
  const now = new Date();
  const hour = now.getUTCHours();
  const date = now.toISOString().split("T")[0];

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
    logger.error("Metrics update failed", error instanceof Error ? error : new Error(String(error)));
    return { updated: false, date };
  }
}

async function cleanupOldEvents(
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<{ deleted: number } | null> {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

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
    logger.error("Cleanup failed", error instanceof Error ? error : new Error(String(error)));
    return { deleted: 0 };
  }
}

async function sendHealthReport(
  supabase: ReturnType<typeof getServiceRoleClient>,
): Promise<boolean> {
  const now = new Date();
  const hour = now.getUTCHours();

  if (hour !== 8) {
    return false;
  }

  try {
    const { data: health } = await supabase
      .from("subscription_health")
      .select("*")
      .schema("billing");

    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const { data: metrics } = await supabase
      .from("subscription_metrics")
      .select("*")
      .eq("metric_date", yesterday)
      .schema("billing");

    const { data: dlq } = await supabase
      .from("dlq_summary")
      .select("*")
      .schema("billing");

    await sendTelegramAlert(
      "low",
      "Daily Subscription Health Report",
      {
        Date: yesterday,
        "Active Subscriptions":
          health?.reduce(
            (sum: number, h: { active_count: number }) => sum + h.active_count,
            0,
          ) || 0,
        "New Yesterday":
          metrics?.reduce(
            (sum: number, m: { new_subscriptions: number }) => sum + m.new_subscriptions,
            0,
          ) || 0,
        "Churned Yesterday":
          metrics?.reduce(
            (sum: number, m: { churned_subscriptions: number }) =>
              sum + m.churned_subscriptions,
            0,
          ) || 0,
        "DLQ Pending":
          dlq?.reduce((sum: number, d: { pending: number }) => sum + d.pending, 0) || 0,
      },
      { throttleKey: "health-report:daily" },
    );

    return true;
  } catch (error) {
    logger.error(
      "Health report failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  }
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // GET /health
  if (path.endsWith("/health")) {
    return ok({ status: "ok", version: VERSION }, ctx);
  }

  // GET /cron — trigger cron tasks (for cron triggers)
  if (path.endsWith("/cron")) {
    return runCronTasks(ctx);
  }

  // GET / — check subscription status (requires auth)
  return handleCheckSubscription(ctx);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // POST /cron — run cron tasks (cron auth)
  if (path.endsWith("/cron")) {
    return runCronTasks(ctx);
  }

  // POST /sync — sync subscription (JWT auth, validated body)
  return handleSyncSubscription(ctx as HandlerContext<SyncSubscriptionBody>);
}

async function runCronTasks(ctx: HandlerContext): Promise<Response> {
  if (!verifyCronAuth(ctx.request)) {
    logger.warn("Unauthorized cron request", {
      ip: ctx.request.headers.get("x-forwarded-for"),
    });
    throw new ForbiddenError("Unauthorized cron request");
  }

  const startTime = performance.now();
  const supabase = getServiceRoleClient();

  const [dlqResult, metricsResult, cleanupResult, healthResult] = await Promise.all([
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

  logger.info("Cron completed", { ...result, durationMs });

  return ok({ ...result, durationMs }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-subscription",
  version: VERSION,
  requireAuth: false, // Auth handled per-route (JWT for sync/status, cron auth for cron)
  csrf: false, // Mobile clients + cron
  rateLimit: {
    limit: 30,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGet,
    },
    POST: {
      handler: handlePost,
    },
  },
});
