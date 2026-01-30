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
  SubscriptionEventType,
  shouldUpdateSubscription,
} from "../_shared/subscriptions/types.ts";
import {
  sendSubscriptionAlert,
  sendCircuitBreakerAlert,
  sendErrorRateAlert,
} from "../_shared/telegram-alerts.ts";

// Import platform handlers
import { appleHandler } from "./handlers/apple.ts";
import { googlePlayHandler } from "./handlers/google-play.ts";
import { stripeHandler } from "./handlers/stripe.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "4.0.0";
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

// Platform-specific rate limiting (more lenient for high-volume platforms)
const PLATFORM_RATE_LIMITS: Record<SubscriptionPlatform, { maxRequests: number; windowMs: number }> = {
  apple: { maxRequests: 200, windowMs: 60000 },
  google_play: { maxRequests: 200, windowMs: 60000 },
  stripe: { maxRequests: 500, windowMs: 60000 }, // Higher for batch processing
};

// Global rate limiting (fallback)
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100; // per window

// Deduplication cache with LRU eviction
const DEDUP_TTL_MS = 300000; // 5 minutes
const DEDUP_MAX_SIZE = 10000; // Maximum entries before eviction

// Revenue-impacting event types that require alerts
const REVENUE_CRITICAL_EVENTS: SubscriptionEventType[] = [
  "billing_issue",
  "grace_period_expired",
  "refunded",
  "revoked",
];

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
  byPlatform: Record<SubscriptionPlatform, { success: number; error: number; lastEventAt: string | null }>;
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastProcessedAt: string | null;
  // Revenue tracking
  revenueEvents: {
    subscriptions: number;
    renewals: number;
    cancellations: number;
    refunds: number;
    billingIssues: number;
    graceRecoveries: number;
  };
  // DLQ stats
  dlqAdded: number;
}

const metrics: WebhookMetrics = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsError: 0,
  requestsDuplicate: 0,
  requestsRateLimited: 0,
  byPlatform: {
    apple: { success: 0, error: 0, lastEventAt: null },
    google_play: { success: 0, error: 0, lastEventAt: null },
    stripe: { success: 0, error: 0, lastEventAt: null },
  },
  avgLatencyMs: 0,
  p95LatencyMs: 0,
  lastProcessedAt: null,
  revenueEvents: {
    subscriptions: 0,
    renewals: 0,
    cancellations: 0,
    refunds: 0,
    billingIssues: 0,
    graceRecoveries: 0,
  },
  dlqAdded: 0,
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

    // Send Telegram alert for circuit breaker state changes
    if (to === "OPEN" || to === "HALF_OPEN" || (to === "CLOSED" && from !== "CLOSED")) {
      sendCircuitBreakerAlert(
        service,
        to as "OPEN" | "HALF_OPEN" | "CLOSED",
        state.failures
      ).catch((err) => {
        logger.warn("Failed to send circuit breaker alert", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  },
});

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Track revenue-impacting events for monitoring and alerting
 */
async function trackRevenueEvent(
  eventType: SubscriptionEventType,
  event?: SubscriptionEvent
): Promise<void> {
  switch (eventType) {
    case "subscription_created":
      metrics.revenueEvents.subscriptions++;
      break;
    case "subscription_renewed":
      metrics.revenueEvents.renewals++;
      break;
    case "subscription_canceled":
    case "subscription_expired":
      metrics.revenueEvents.cancellations++;
      break;
    case "refunded":
    case "revoked":
      metrics.revenueEvents.refunds++;
      break;
    case "billing_issue":
    case "grace_period_expired":
      metrics.revenueEvents.billingIssues++;
      break;
    case "billing_recovered":
      metrics.revenueEvents.graceRecoveries++;
      break;
  }

  // Send Telegram alert on revenue-critical events
  if (REVENUE_CRITICAL_EVENTS.includes(eventType) && event) {
    logger.warn("Revenue-critical event detected", {
      eventType,
      alertLevel: "high",
      metrics: metrics.revenueEvents,
    });

    // Fire and forget - don't block webhook response
    sendSubscriptionAlert(eventType, {
      platform: event.platform,
      productId: event.subscription.productId,
      userId: event.subscription.appUserId,
      originalTransactionId: event.subscription.originalTransactionId,
      status: event.subscription.status,
    }).catch((err) => {
      logger.warn("Failed to send subscription alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Evict oldest entries from dedup cache when it exceeds max size
 */
function evictDedupCache(): void {
  if (dedupCache.size <= DEDUP_MAX_SIZE) return;

  // Convert to array, sort by timestamp (oldest first), delete oldest 20%
  const entries = [...dedupCache.entries()].sort((a, b) => a[1] - b[1]);
  const deleteCount = Math.floor(entries.length * 0.2);

  for (let i = 0; i < deleteCount; i++) {
    dedupCache.delete(entries[i][0]);
  }

  logger.info("Evicted dedup cache entries", {
    deletedCount: deleteCount,
    newSize: dedupCache.size,
  });
}

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

// Error rate monitoring - track last 100 requests
const ERROR_RATE_THRESHOLD = 15; // Alert if >15% errors
const ERROR_RATE_CHECK_INTERVAL = 100; // Check every 100 requests
let lastErrorRateCheck = 0;

/**
 * Check error rate and alert if above threshold
 */
function checkErrorRateAndAlert(): void {
  // Only check every N requests to avoid constant alerts
  if (metrics.requestsTotal - lastErrorRateCheck < ERROR_RATE_CHECK_INTERVAL) {
    return;
  }

  lastErrorRateCheck = metrics.requestsTotal;

  const errorRate = metrics.requestsTotal > 10
    ? (metrics.requestsError / metrics.requestsTotal) * 100
    : 0;

  if (errorRate > ERROR_RATE_THRESHOLD) {
    logger.error("High error rate detected", {
      errorRate: errorRate.toFixed(2),
      total: metrics.requestsTotal,
      errors: metrics.requestsError,
    });

    // Fire and forget - send alert async
    sendErrorRateAlert(
      errorRate,
      metrics.requestsTotal,
      metrics.requestsError
    ).catch((err) => {
      logger.warn("Failed to send error rate alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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

function checkRateLimit(clientIp: string, platform?: SubscriptionPlatform): boolean {
  const now = Date.now();
  const key = platform ? `${platform}:${clientIp}` : clientIp;

  // Use platform-specific limits if available
  const limits = platform
    ? PLATFORM_RATE_LIMITS[platform]
    : { maxRequests: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS };

  const existing = rateLimitCache.get(key);

  if (!existing || now - existing.windowStart > limits.windowMs) {
    rateLimitCache.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= limits.maxRequests) {
    return false;
  }

  existing.count++;
  return true;
}

function checkDedup(eventId: string): boolean {
  const now = Date.now();

  // Clean old entries periodically (every 100 checks)
  if (dedupCache.size > 0 && dedupCache.size % 100 === 0) {
    for (const [key, timestamp] of dedupCache.entries()) {
      if (now - timestamp > DEDUP_TTL_MS) {
        dedupCache.delete(key);
      }
    }
  }

  if (dedupCache.has(eventId)) {
    return false; // Duplicate
  }

  // Evict if cache is too large
  evictDedupCache();

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
// Field Validation
// =============================================================================

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateEventFields(event: SubscriptionEvent): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!event.eventId?.trim()) {
    errors.push("Missing eventId");
  }
  if (!event.subscription.originalTransactionId?.trim()) {
    errors.push("Missing originalTransactionId");
  }
  if (!event.subscription.productId?.trim()) {
    errors.push("Missing productId");
  }
  if (!event.subscription.status?.trim()) {
    errors.push("Missing subscription status");
  }

  // Validate timestamps are reasonable (not in far future)
  const now = Date.now();
  const maxFutureMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  if (event.subscription.expiresDate) {
    const expiresTime = event.subscription.expiresDate.getTime();
    if (expiresTime > now + maxFutureMs * 52) { // Allow up to 1 year
      errors.push("expiresDate too far in future");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// State Transition Validation
// =============================================================================

async function validateStatusTransition(
  supabase: ReturnType<typeof getServiceRoleClient>,
  originalTransactionId: string,
  platform: string,
  newStatus: string,
  eventType: string
): Promise<{ valid: boolean; currentStatus: string }> {
  return await withCircuitBreaker("subscription-db", async () => {
    // Get current status
    const { data: currentStatus } = await supabase.rpc("billing_get_current_status", {
      p_original_transaction_id: originalTransactionId,
      p_platform: platform,
    });

    // If no existing subscription, any status is valid (new subscription)
    if (currentStatus === "unknown") {
      return { valid: true, currentStatus };
    }

    // Validate transition
    const { data: isValid } = await supabase.rpc("billing_validate_status_transition", {
      p_current_status: currentStatus,
      p_new_status: newStatus,
      p_event_type: eventType,
    });

    return { valid: isValid ?? true, currentStatus };
  });
}

// =============================================================================
// Atomic Webhook Processing
// =============================================================================

interface AtomicProcessResult {
  success: boolean;
  alreadyProcessed: boolean;
  eventId: string | null;
  subscriptionId: string | null;
  error?: string;
}

async function processWebhookAtomically(
  supabase: ReturnType<typeof getServiceRoleClient>,
  event: SubscriptionEvent,
  userId: string | null
): Promise<AtomicProcessResult> {
  return await withCircuitBreaker("subscription-db", async () => {
    return await retryWithBackoff(async () => {
      return await measureAsync("db.process_atomic", async () => {
        const sub = event.subscription;

        const { data, error } = await supabase.rpc("billing_process_webhook_atomically", {
          p_notification_uuid: event.eventId,
          p_platform: event.platform,
          p_notification_type: event.rawEventType,
          p_subtype: event.rawSubtype || null,
          p_original_transaction_id: sub.originalTransactionId,
          p_signed_payload: event.rawPayload,
          p_decoded_payload: {
            platform: event.platform,
            eventType: event.eventType,
            subscription: sub,
            environment: event.environment,
          },
          p_signed_date: event.eventTime.toISOString(),
          p_user_id: userId,
          p_product_id: sub.productId,
          p_bundle_id: sub.bundleId || null,
          p_status: sub.status,
          p_purchase_date: sub.purchaseDate?.toISOString() || null,
          p_original_purchase_date: sub.originalPurchaseDate?.toISOString() || null,
          p_expires_date: sub.expiresDate?.toISOString() || null,
          p_auto_renew_status: sub.autoRenewEnabled ?? null,
          p_auto_renew_product_id: sub.autoRenewProductId || null,
          p_environment: event.environment === "production" ? "Production" : "Sandbox",
          p_app_account_token: sub.appUserId || null,
        });

        if (error) {
          throw new Error(`Atomic processing failed: ${error.message}`);
        }

        return {
          success: data?.success ?? false,
          alreadyProcessed: data?.already_processed ?? false,
          eventId: data?.event_id || null,
          subscriptionId: data?.subscription_id || null,
        };
      }, { platform: event.platform, eventType: event.eventType });
    }, "processWebhookAtomically");
  });
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
    checkErrorRateAndAlert();
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
    checkErrorRateAndAlert();
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
    checkErrorRateAndAlert();
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

  // ==========================================================================
  // Step 1: Validate required fields
  // ==========================================================================
  const validation = validateEventFields(event);
  if (!validation.valid) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    logger.warn("Event failed field validation", {
      requestId,
      eventId: event.eventId,
      errors: validation.errors,
    });
    return buildSuccessResponse(
      { received: true, error: "validation_failed", details: validation.errors },
      corsHeaders
    );
  }

  // ==========================================================================
  // Step 2: Check if we should update subscription
  // ==========================================================================
  if (!shouldUpdateSubscription(event.eventType)) {
    logger.info("Event does not require subscription update", {
      requestId,
      eventId: event.eventId,
      eventType: event.eventType,
    });

    // Still record the event for audit trail using atomic processing
    try {
      const result = await processWebhookAtomically(supabase, event, null);
      if (result.alreadyProcessed) {
        metrics.requestsDuplicate++;
        return buildSuccessResponse(
          { received: true, already_processed: true, source: "database" },
          corsHeaders
        );
      }
    } catch (error) {
      logger.warn("Failed to record non-actionable event", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

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

  // ==========================================================================
  // Step 3: Find user for transaction
  // ==========================================================================
  const userId = await findUserForTransaction(
    supabase,
    event.subscription.appUserId,
    event.subscription.originalTransactionId
  );

  // ==========================================================================
  // Step 4: Validate state transition (if user exists with subscription)
  // ==========================================================================
  if (userId) {
    try {
      const transitionCheck = await validateStatusTransition(
        supabase,
        event.subscription.originalTransactionId,
        event.platform,
        event.subscription.status,
        event.eventType
      );

      if (!transitionCheck.valid) {
        logger.warn("Invalid status transition detected", {
          requestId,
          eventId: event.eventId,
          currentStatus: transitionCheck.currentStatus,
          newStatus: event.subscription.status,
          eventType: event.eventType,
        });
        // Log but don't reject - platform is source of truth
        // This is for monitoring, not blocking
      }
    } catch (error) {
      // Non-critical - continue processing
      logger.warn("Failed to validate status transition", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==========================================================================
  // Step 5: Atomic processing (record + upsert + mark processed in one tx)
  // ==========================================================================
  let result: AtomicProcessResult;
  try {
    result = await processWebhookAtomically(supabase, event, userId);
  } catch (error) {
    metrics.requestsError++;
    metrics.byPlatform[platform].error++;
    checkErrorRateAndAlert();
    const err = error instanceof Error ? error : new Error(String(error));
    trackError(err, {
      platform,
      operation: "process_webhook_atomically",
      requestId,
      eventId: event.eventId,
      userId,
    });
    logger.error("Atomic webhook processing failed", err);

    // Note: The atomic function automatically adds to DLQ on failure
    return buildSuccessResponse(
      { received: true, error: "processing_failed", dlq: true },
      corsHeaders
    );
  }

  // ==========================================================================
  // Step 6: Handle results
  // ==========================================================================
  if (result.alreadyProcessed) {
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

  if (!userId) {
    logger.warn("No user found for transaction", {
      requestId,
      eventId: event.eventId,
      originalTransactionId: event.subscription.originalTransactionId,
      appUserId: event.subscription.appUserId,
    });

    metrics.requestsSuccess++;
    metrics.byPlatform[platform].success++;
    metrics.byPlatform[platform].lastEventAt = new Date().toISOString();
    trackRevenueEvent(event.eventType, event);
    const durationMs = timer.end({ platform, action: "user_not_found" });
    updateLatencyMetrics(durationMs);
    metrics.lastProcessedAt = new Date().toISOString();

    return buildSuccessResponse(
      { received: true, processed: true, user_found: false },
      corsHeaders
    );
  }

  // Success path
  const durationMs = timer.end({
    platform,
    eventType: event.eventType,
    userId,
    subscriptionId: result.subscriptionId,
  });
  updateLatencyMetrics(durationMs);

  metrics.requestsSuccess++;
  metrics.byPlatform[platform].success++;
  metrics.byPlatform[platform].lastEventAt = new Date().toISOString();
  metrics.lastProcessedAt = new Date().toISOString();

  // Track revenue metrics (fire and forget - alerts sent async)
  trackRevenueEvent(event.eventType, event);

  logger.info("Successfully processed subscription event", {
    requestId,
    eventId: event.eventId,
    platform: event.platform,
    eventType: event.eventType,
    userId,
    subscriptionId: result.subscriptionId,
    status: event.subscription.status,
    durationMs,
  });

  return buildSuccessResponse(
    {
      received: true,
      processed: true,
      platform: event.platform,
      status: event.subscription.status,
      subscription_id: result.subscriptionId,
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

  // Check for stale data (no events in last 24 hours could indicate issues)
  const lastEventAge = metrics.lastProcessedAt
    ? Date.now() - new Date(metrics.lastProcessedAt).getTime()
    : null;
  const isStale = lastEventAge && lastEventAge > 24 * 60 * 60 * 1000; // 24 hours

  // Check for high error rate (>10% in last window)
  const errorRate = metrics.requestsTotal > 10
    ? (metrics.requestsError / metrics.requestsTotal) * 100
    : 0;
  const highErrorRate = errorRate > 10;

  // Determine status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  const issues: string[] = [];

  if (!dbCircuitHealthy) {
    status = "unhealthy";
    issues.push("database_circuit_open");
  }
  if (highErrorRate) {
    status = status === "unhealthy" ? "unhealthy" : "degraded";
    issues.push("high_error_rate");
  }
  if (isStale) {
    status = status === "unhealthy" ? "unhealthy" : "degraded";
    issues.push("stale_data");
  }

  return new Response(
    JSON.stringify({
      status,
      issues,
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
      platforms: handlers.map((h) => h.platform),
      checks: {
        database: dbCircuitHealthy,
        errorRate: Math.round(errorRate * 100) / 100,
        lastEventAge: lastEventAge ? Math.round(lastEventAge / 1000) : null,
        dedupCacheSize: dedupCache.size,
        rateLimitCacheSize: rateLimitCache.size,
      },
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
      status: status === "healthy" ? 200 : status === "degraded" ? 200 : 503,
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

  // Calculate derived metrics
  const successRate = metrics.requestsTotal > 0
    ? ((metrics.requestsSuccess / metrics.requestsTotal) * 100).toFixed(2)
    : "0.00";

  const churnRate = metrics.revenueEvents.subscriptions > 0
    ? ((metrics.revenueEvents.cancellations / metrics.revenueEvents.subscriptions) * 100).toFixed(2)
    : "0.00";

  const graceRecoveryRate = metrics.revenueEvents.billingIssues > 0
    ? ((metrics.revenueEvents.graceRecoveries / metrics.revenueEvents.billingIssues) * 100).toFixed(2)
    : "0.00";

  return new Response(
    JSON.stringify({
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
      webhook: {
        ...metrics,
        successRate: `${successRate}%`,
      },
      revenue: {
        events: metrics.revenueEvents,
        churnRate: `${churnRate}%`,
        graceRecoveryRate: `${graceRecoveryRate}%`,
        netSubscriptions: metrics.revenueEvents.subscriptions - metrics.revenueEvents.cancellations,
      },
      errors: {
        total: errorStats.total,
        bySeverity: errorStats.bySeverity,
        recentAlerts: errorStats.recentAlerts,
      },
      performance: {
        operations: performanceMetrics.slice(0, 10),
        memory: healthMetrics.memory,
        uptime: healthMetrics.uptime,
        latency: {
          avg: metrics.avgLatencyMs,
          p95: metrics.p95LatencyMs,
        },
      },
      circuits: getAllCircuitStatuses(),
      cache: {
        dedupCacheSize: dedupCache.size,
        dedupMaxSize: DEDUP_MAX_SIZE,
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
