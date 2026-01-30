/**
 * Unified Subscription Webhook - Production Grade
 *
 * Cross-platform webhook handler for subscription lifecycle events:
 * - Apple App Store (iOS)
 * - Google Play (Android)
 * - Stripe (Web)
 *
 * Features:
 * - Circuit breaker protection for database operations
 * - Retry with exponential backoff for transient failures
 * - Request deduplication to prevent double processing
 * - Comprehensive error tracking and alerting
 * - Performance monitoring with percentile metrics
 * - Rate limiting for webhook spam protection
 * - Structured logging with full request context
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { AppError } from "../_shared/errors.ts";
import { buildSuccessResponse, buildErrorResponse } from "../_shared/response-adapter.ts";
import { trackError, getErrorStats } from "../_shared/error-tracking.ts";
import { measureAsync, PerformanceTimer, getMetricsSummary, getHealthMetrics } from "../_shared/performance.ts";
import { withCircuitBreaker, getAllCircuitStatuses, isCircuitHealthy, configureCircuit } from "../_shared/circuit-breaker.ts";
import {
  PlatformHandler,
  SubscriptionEvent,
  SubscriptionPlatform,
  shouldUpdateSubscription,
} from "../_shared/subscriptions/types.ts";

// Import platform handlers
import { appleHandler } from "./handlers/apple.ts";
import { googlePlayHandler } from "./handlers/google-play.ts";
import { stripeHandler } from "./handlers/stripe.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "2.1.0";
const SERVICE = "subscription-webhook";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
};

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // per window

// Deduplication cache
const DEDUP_TTL_MS = 300000; // 5 minutes

// Platform handlers in priority order
const handlers: PlatformHandler[] = [
  appleHandler,
  stripeHandler,      // Check Stripe before Google (has distinct header)
  googlePlayHandler,
];

// =============================================================================
// Metrics & State
// =============================================================================

interface WebhookMetrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsError: number;
  requestsDuplicate: number;
  requestsRateLimited: number;
  byPlatform: Record<SubscriptionPlatform, { success: number; error: number }>;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastProcessedAt: string | null;
}

const metrics: WebhookMetrics = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsError: 0,
  requestsDuplicate: 0,
  requestsRateLimited: 0,
  byPlatform: {
    apple: { success: 0, error: 0 },
    google_play: { success: 0, error: 0 },
    stripe: { success: 0, error: 0 },
  },
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  lastProcessedAt: null,
};

// Recent latencies for percentile calculation
const latencyBuffer: number[] = [];
const LATENCY_BUFFER_SIZE = 100;

// Deduplication cache: eventId -> timestamp
const dedupCache = new Map<string, number>();

// Rate limiting: IP -> { count, windowStart }
const rateLimitCache = new Map<string, { count: number; windowStart: number }>();

// =============================================================================
// Initialize Circuit Breakers
// =============================================================================

configureCircuit("subscription-db", {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  successThreshold: 2,
  onStateChange: (service, from, to, state) => {
    logger.warn("Circuit breaker state change", {
      service,
      from,
      to,
      failures: state.failures,
      totalFailures: state.totalFailures,
    });
  },
});

// =============================================================================
// Utility Functions
// =============================================================================

function updateLatencyMetrics(latencyMs: number): void {
  latencyBuffer.push(latencyMs);
  if (latencyBuffer.length > LATENCY_BUFFER_SIZE) {
    latencyBuffer.shift();
  }

  // Calculate average
  metrics.avgLatencyMs = Math.round(
    latencyBuffer.reduce((a, b) => a + b, 0) / latencyBuffer.length
  );

  // Calculate p95
  if (latencyBuffer.length >= 20) {
    const sorted = [...latencyBuffer].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    metrics.p95LatencyMs = sorted[p95Index];
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === RETRY_CONFIG.maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
      const jitter = Math.random() * baseDelay * 0.1;
      const delay = Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelayMs);

      logger.warn(`Retrying ${operationName}`, {
        attempt: attempt + 1,
        maxRetries: RETRY_CONFIG.maxRetries,
        delayMs: Math.round(delay),
        error: lastError.message,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const existing = rateLimitCache.get(clientIp);

  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitCache.set(clientIp, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  existing.count++;
  return true;
}

function checkDedup(eventId: string): boolean {
  const now = Date.now();

  // Clean old entries
  for (const [key, timestamp] of dedupCache.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) {
      dedupCache.delete(key);
    }
  }

  if (dedupCache.has(eventId)) {
    return false; // Duplicate
  }

  dedupCache.set(eventId, now);
  return true;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// =============================================================================
// Supabase Client
// =============================================================================

function getServiceRoleClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// =============================================================================
// Database Operations (with Circuit Breaker & Retry)
// =============================================================================

async function recordEvent(
  supabase: ReturnType<typeof getServiceRoleClient>,
  event: SubscriptionEvent
): Promise<{ eventId: string; alreadyProcessed: boolean }> {
  return await withCircuitBreaker("subscription-db", async () => {
    return await retryWithBackoff(async () => {
      return await measureAsync("db.record_event", async () => {
        const { data, error } = await supabase.rpc("billing_record_subscription_event", {
          p_notification_uuid: event.eventId,
          p_platform: event.platform,
          p_notification_type: event.rawEventType,
          p_subtype: event.rawSubtype || null,
          p_original_transaction_id: event.subscription.originalTransactionId,
          p_signed_payload: event.rawPayload,
          p_decoded_payload: {
            platform: event.platform,
            eventType: event.eventType,
            subscription: event.subscription,
            environment: event.environment,
          },
          p_signed_date: event.eventTime.toISOString(),
        });

        if (error) {
          throw new Error(`Failed to record event: ${error.message}`);
        }

        return {
          eventId: data?.event_id || event.eventId,
          alreadyProcessed: data?.already_processed || false,
        };
      }, { platform: event.platform, eventType: event.eventType });
    }, "recordEvent");
  });
}

async function findUserForTransaction(
  supabase: ReturnType<typeof getServiceRoleClient>,
  appAccountToken: string | undefined,
  originalTransactionId: string
): Promise<string | null> {
  return await withCircuitBreaker("subscription-db", async () => {
    return await measureAsync("db.find_user", async () => {
      const { data, error } = await supabase.rpc("billing_find_user_for_transaction", {
        p_app_account_token: appAccountToken || null,
        p_original_transaction_id: originalTransactionId,
      });

      if (error) {
        logger.error("Failed to find user for transaction", new Error(error.message));
        return null;
      }

      return data;
    }, { originalTransactionId });
  });
}

async function upsertSubscription(
  supabase: ReturnType<typeof getServiceRoleClient>,
  userId: string,
  event: SubscriptionEvent
): Promise<string> {
  return await withCircuitBreaker("subscription-db", async () => {
    return await retryWithBackoff(async () => {
      return await measureAsync("db.upsert_subscription", async () => {
        const sub = event.subscription;

        const { data, error } = await supabase.rpc("billing_upsert_subscription", {
          p_user_id: userId,
          p_platform: event.platform,
          p_original_transaction_id: sub.originalTransactionId,
          p_product_id: sub.productId,
          p_bundle_id: sub.bundleId,
          p_status: sub.status,
          p_purchase_date: sub.purchaseDate?.toISOString() || null,
          p_original_purchase_date: sub.originalPurchaseDate?.toISOString() || null,
          p_expires_date: sub.expiresDate?.toISOString() || null,
          p_auto_renew_status: sub.autoRenewEnabled,
          p_auto_renew_product_id: sub.autoRenewProductId || null,
          p_environment: event.environment === "production" ? "Production" : "Sandbox",
          p_app_account_token: sub.appUserId || null,
        });

        if (error) {
          throw new Error(`Failed to upsert subscription: ${error.message}`);
        }

        return data;
      }, { userId, platform: event.platform, status: event.subscription.status });
    }, "upsertSubscription");
  });
}

async function markEventProcessed(
  supabase: ReturnType<typeof getServiceRoleClient>,
  eventId: string,
  subscriptionId: string | null,
  error: string | null
): Promise<void> {
  try {
    await withCircuitBreaker("subscription-db", async () => {
      await supabase.rpc("billing_mark_event_processed", {
        p_event_id: eventId,
        p_subscription_id: subscriptionId,
        p_error: error,
      });
    });
  } catch (err) {
    // Non-critical - log but don't fail the webhook
    logger.warn("Failed to mark event as processed", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// Webhook Handler
// =============================================================================

async function handleWebhook(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeadersWithMobile(req);
  const timer = new PerformanceTimer("webhook_request");
  const requestId = crypto.randomUUID();
  const clientIp = getClientIp(req);

  metrics.requestsTotal++;

  // Rate limiting
  if (!checkRateLimit(clientIp)) {
    metrics.requestsRateLimited++;
    logger.warn("Rate limit exceeded", { clientIp, requestId });
    return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    });
  }

  // Read body once
  const body = await req.text();

  if (!body) {
    metrics.requestsError++;
    return buildErrorResponse(
      new AppError("Empty request body", "INVALID_REQUEST", 400),
      corsHeaders
    );
  }

  // Detect platform
  let handler: PlatformHandler | undefined;
  let platform: SubscriptionPlatform | undefined;

  for (const h of handlers) {
    if (h.canHandle(req)) {
      handler = h;
      platform = h.platform;
      break;
    }
  }

  // If no handler matched, try to detect from body structure
  if (!handler) {
    try {
      const parsed = JSON.parse(body);

      // Apple: has signedPayload
      if (parsed.signedPayload) {
        handler = appleHandler;
        platform = "apple";
      }
      // Stripe: has object field
      else if (parsed.object === "event" && parsed.type?.startsWith("customer.")) {
        handler = stripeHandler;
        platform = "stripe";
      }
      // Google Play: has message.data (Pub/Sub)
      else if (parsed.message?.data) {
        handler = googlePlayHandler;
        platform = "google_play";
      }
    } catch {
      // Not JSON, can't detect
    }
  }

  if (!handler || !platform) {
    metrics.requestsError++;
    logger.warn("Unable to detect webhook platform", {
      requestId,
      contentType: req.headers.get("content-type"),
      hasStripeSignature: !!req.headers.get("stripe-signature"),
      bodyPreview: body.substring(0, 100),
    });
    return buildErrorResponse(
      new AppError("Unable to detect webhook platform", "UNKNOWN_PLATFORM", 400),
      corsHeaders
    );
  }

  logger.info(`Processing ${platform} webhook`, {
    requestId,
    platform,
    clientIp,
    contentLength: body.length,
  });

  // Verify webhook authenticity
  let isValid: boolean;
  try {
    isValid = await measureAsync(
      "webhook.verify",
      () => handler!.verifyWebhook(req, body),
      { platform }
    );
  } catch (error) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    const err = error instanceof Error ? error : new Error(String(error));
    trackError(err, { platform, operation: "verify_webhook", requestId });
    logger.error(`${platform} webhook verification error`, err);
    return buildSuccessResponse(
      { received: true, error: "verification_error" },
      corsHeaders
    );
  }

  if (!isValid) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    logger.warn(`${platform} webhook verification failed`, { requestId });
    // Return 200 to prevent retries for invalid webhooks
    return buildSuccessResponse(
      { received: true, error: "verification_failed" },
      corsHeaders
    );
  }

  // Parse the event
  let event: SubscriptionEvent;
  try {
    event = await measureAsync(
      "webhook.parse",
      () => handler!.parseEvent(req, body),
      { platform }
    );
  } catch (error) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    const err = error instanceof Error ? error : new Error(String(error));
    trackError(err, { platform, operation: "parse_event", requestId });
    logger.error(`Failed to parse ${platform} event`, err);
    return buildSuccessResponse(
      { received: true, error: "parse_failed" },
      corsHeaders
    );
  }

  // Check deduplication (in-memory layer before database)
  if (!checkDedup(event.eventId)) {
    metrics.requestsDuplicate++;
    logger.info("Duplicate event detected (in-memory)", {
      requestId,
      eventId: event.eventId,
      platform,
    });
    return buildSuccessResponse(
      { received: true, already_processed: true, source: "cache" },
      corsHeaders
    );
  }

  logger.info("Parsed subscription event", {
    requestId,
    eventId: event.eventId,
    platform: event.platform,
    eventType: event.eventType,
    rawEventType: event.rawEventType,
    productId: event.subscription.productId,
    status: event.subscription.status,
    environment: event.environment,
  });

  // Get database client
  const supabase = getServiceRoleClient();

  // Record event (idempotent)
  let recordResult: { eventId: string; alreadyProcessed: boolean };
  try {
    recordResult = await recordEvent(supabase, event);
  } catch (error) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    const err = error instanceof Error ? error : new Error(String(error));
    trackError(err, { platform, operation: "record_event", requestId, eventId: event.eventId });
    logger.error("Failed to record event", err);
    return buildSuccessResponse(
      { received: true, error: "database_error" },
      corsHeaders
    );
  }

  if (recordResult.alreadyProcessed) {
    metrics.requestsDuplicate++;
    logger.info("Event already processed (database)", {
      requestId,
      eventId: event.eventId,
    });
    return buildSuccessResponse(
      { received: true, already_processed: true, source: "database" },
      corsHeaders
    );
  }

  // Check if we should update subscription
  if (!shouldUpdateSubscription(event.eventType)) {
    logger.info("Event does not require subscription update", {
      requestId,
      eventId: event.eventId,
      eventType: event.eventType,
    });

    await markEventProcessed(supabase, recordResult.eventId, null, null);

    metrics.requestsSuccess++;
    metrics.byPlatform[platform].success++;
    const durationMs = timer.end({ platform, action: "none" });
    updateLatencyMetrics(durationMs);
    metrics.lastProcessedAt = new Date().toISOString();

    return buildSuccessResponse(
      { received: true, processed: true, action: "none" },
      corsHeaders
    );
  }

  // Find user
  const userId = await findUserForTransaction(
    supabase,
    event.subscription.appUserId,
    event.subscription.originalTransactionId
  );

  if (!userId) {
    logger.warn("No user found for transaction", {
      requestId,
      eventId: event.eventId,
      originalTransactionId: event.subscription.originalTransactionId,
      appUserId: event.subscription.appUserId,
    });

    await markEventProcessed(supabase, recordResult.eventId, null, "user_not_found");

    metrics.requestsSuccess++;
    metrics.byPlatform[platform].success++;
    const durationMs = timer.end({ platform, action: "user_not_found" });
    updateLatencyMetrics(durationMs);
    metrics.lastProcessedAt = new Date().toISOString();

    return buildSuccessResponse(
      { received: true, processed: true, user_found: false },
      corsHeaders
    );
  }

  // Upsert subscription
  let subscriptionId: string;
  try {
    subscriptionId = await upsertSubscription(supabase, userId, event);
  } catch (error) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    const err = error instanceof Error ? error : new Error(String(error));
    trackError(err, {
      platform,
      operation: "upsert_subscription",
      requestId,
      eventId: event.eventId,
      userId,
    });
    logger.error("Failed to upsert subscription", err);

    await markEventProcessed(supabase, recordResult.eventId, null, `upsert_failed: ${error}`);

    return buildSuccessResponse(
      { received: true, error: "subscription_update_failed" },
      corsHeaders
    );
  }

  // Mark as processed
  await markEventProcessed(supabase, recordResult.eventId, subscriptionId, null);

  const durationMs = timer.end({
    platform,
    eventType: event.eventType,
    userId,
    subscriptionId,
  });
  updateLatencyMetrics(durationMs);

  metrics.requestsSuccess++;
  metrics.byPlatform[platform].success++;
  metrics.lastProcessedAt = new Date().toISOString();

  logger.info("Successfully processed subscription event", {
    requestId,
    eventId: event.eventId,
    platform: event.platform,
    eventType: event.eventType,
    userId,
    subscriptionId,
    status: event.subscription.status,
    durationMs,
  });

  return buildSuccessResponse(
    {
      received: true,
      processed: true,
      platform: event.platform,
      status: event.subscription.status,
      subscription_id: subscriptionId,
    },
    corsHeaders
  );
}

// =============================================================================
// Health Check
// =============================================================================

function handleHealthCheck(req: Request): Response {
  const corsHeaders = getCorsHeadersWithMobile(req);
  const circuitStatuses = getAllCircuitStatuses();
  const dbCircuitHealthy = isCircuitHealthy("subscription-db");

  const status = dbCircuitHealthy ? "healthy" : "degraded";

  return new Response(
    JSON.stringify({
      status,
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
      platforms: handlers.map((h) => h.platform),
      circuits: Object.entries(circuitStatuses).reduce((acc, [name, state]) => {
        acc[name] = {
          state: state.state,
          failures: state.failures,
          totalRequests: state.totalRequests,
          failureRate: state.totalRequests > 0
            ? Math.round((state.totalFailures / state.totalRequests) * 100)
            : 0,
        };
        return acc;
      }, {} as Record<string, unknown>),
    }),
    {
      status: status === "healthy" ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

// =============================================================================
// Metrics Endpoint
// =============================================================================

function handleMetrics(req: Request): Response {
  const corsHeaders = getCorsHeadersWithMobile(req);
  const errorStats = getErrorStats();
  const performanceMetrics = getMetricsSummary();
  const healthMetrics = getHealthMetrics();

  return new Response(
    JSON.stringify({
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
      webhook: metrics,
      errors: {
        total: errorStats.total,
        bySeverity: errorStats.bySeverity,
        recentAlerts: errorStats.recentAlerts,
      },
      performance: {
        operations: performanceMetrics.slice(0, 10),
        memory: healthMetrics.memory,
        uptime: healthMetrics.uptime,
      },
      circuits: getAllCircuitStatuses(),
      cache: {
        dedupCacheSize: dedupCache.size,
        rateLimitCacheSize: rateLimitCache.size,
      },
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const corsHeaders = getCorsHeadersWithMobile(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleMobileCorsPrelight(req);
  }

  // Health check
  if (req.method === "GET" && (url.pathname.endsWith("/health") || url.pathname === "/")) {
    return handleHealthCheck(req);
  }

  // Metrics endpoint
  if (req.method === "GET" && url.pathname.endsWith("/metrics")) {
    return handleMetrics(req);
  }

  // Webhook handler
  if (req.method === "POST") {
    try {
      return await handleWebhook(req);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      trackError(err, { operation: "webhook_handler_unhandled" });
      logger.error("Unhandled error in webhook handler", err);
      return buildSuccessResponse(
        { received: true, error: "internal_error" },
        corsHeaders
      );
    }
  }

  return buildErrorResponse(
    new AppError("Method not allowed", "METHOD_NOT_ALLOWED", 405),
    corsHeaders
  );
});
