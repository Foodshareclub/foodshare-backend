/**
 * Metrics Collection Client
 *
 * Provides fire-and-forget metrics recording for Edge Functions.
 * Records to the metrics schema for observability dashboards.
 *
 * Features:
 * - Async, non-blocking metric recording
 * - Automatic batching for efficiency
 * - Circuit breaker status sync
 * - Integration with request context
 */

import { getContext, getElapsedMs } from "./context.ts";
import { getSupabaseClient } from "./supabase.ts";
import { CircuitState, getCircuitStatus, getAllCircuitStatuses } from "./circuit-breaker.ts";

/**
 * Metric event for a function call
 */
export interface MetricEvent {
  /** Function name (e.g., "create-listing", "send-push-notification") */
  functionName: string;
  /** Request ID for correlation */
  requestId: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
  /** User ID if authenticated */
  userId?: string;
  /** Client platform */
  platform?: "ios" | "android" | "web" | "unknown";
  /** Request start time (performance.now()) */
  startTime: number;
  /** HTTP status code */
  statusCode?: number;
  /** Error code if failed */
  errorCode?: string;
  /** Error message if failed */
  errorMessage?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// Queue for batching metrics
const metricsQueue: MetricEvent[] = [];
let flushTimer: number | undefined;
const FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds
const MAX_BATCH_SIZE = 50;

/**
 * Record a function call metric
 * This is fire-and-forget - errors are logged but not thrown
 *
 * @example
 * ```typescript
 * recordMetric({
 *   functionName: "create-listing",
 *   requestId: ctx.requestId,
 *   startTime: ctx.startTime,
 *   statusCode: 200,
 * });
 * ```
 */
export function recordMetric(event: MetricEvent): void {
  metricsQueue.push(event);

  // Start flush timer if not already running
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushMetrics().catch((e) => console.error("Failed to flush metrics:", e));
    }, FLUSH_INTERVAL_MS);
  }

  // Flush immediately if batch is full
  if (metricsQueue.length >= MAX_BATCH_SIZE) {
    flushMetrics().catch((e) => console.error("Failed to flush metrics:", e));
  }
}

/**
 * Record a metric from the current request context
 * Convenience method that uses the active context
 */
export function recordMetricFromContext(
  functionName: string,
  statusCode: number,
  options?: {
    errorCode?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  const ctx = getContext();
  if (!ctx) return;

  recordMetric({
    functionName,
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    userId: ctx.userId,
    platform: ctx.platform,
    startTime: ctx.startTime,
    statusCode,
    ...options,
  });
}

/**
 * Flush all queued metrics to the database
 */
export async function flushMetrics(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }

  if (metricsQueue.length === 0) return;

  // Take all queued metrics
  const events = metricsQueue.splice(0, metricsQueue.length);

  try {
    const supabase = getSupabaseClient();

    // Record each event
    for (const event of events) {
      const durationMs = Math.round(performance.now() - event.startTime);

      await supabase.rpc("record_function_call", {
        p_function_name: event.functionName,
        p_request_id: event.requestId,
        p_duration_ms: durationMs,
        p_status_code: event.statusCode || 0,
        p_correlation_id: event.correlationId,
        p_user_id: event.userId,
        p_platform: event.platform,
        p_error_code: event.errorCode,
        p_error_message: event.errorMessage?.substring(0, 500),
        p_metadata: event.metadata || {},
      }).catch((e) => {
        // Log but don't fail
        console.error("Failed to record metric:", e.message);
      });
    }
  } catch (error) {
    console.error("Failed to flush metrics:", error);
    // Don't re-queue failed metrics to avoid memory growth
  }
}

/**
 * Sync circuit breaker status to database
 */
export async function syncCircuitStatus(circuitName: string, state: CircuitState): Promise<void> {
  try {
    const status = getCircuitStatus(circuitName);
    if (!status) return;

    const supabase = getSupabaseClient();

    await supabase.rpc("update_circuit_status", {
      p_circuit_name: circuitName,
      p_state: status.state,
      p_failure_count: status.failures,
      p_success_count: status.successes,
    });
  } catch (error) {
    console.error("Failed to sync circuit status:", error);
  }
}

/**
 * Sync all circuit breaker statuses to database
 */
export async function syncAllCircuitStatuses(): Promise<void> {
  const statuses = getAllCircuitStatuses();

  for (const [name, status] of Object.entries(statuses)) {
    await syncCircuitStatus(name, status.state);
  }
}

/**
 * Get metrics summary from database
 */
export async function getMetricsSummary(minutes: number = 5): Promise<{
  errorRate: number;
  p95Latency: number;
  totalRequests: number;
} | null> {
  try {
    const supabase = getSupabaseClient();

    const [errorRateResult, p95Result] = await Promise.all([
      supabase.rpc("get_error_rate", { p_minutes: minutes }),
      supabase.rpc("get_p95_latency", { p_minutes: minutes }),
    ]);

    if (errorRateResult.error || p95Result.error) {
      console.error("Failed to get metrics summary:", errorRateResult.error || p95Result.error);
      return null;
    }

    const errorData = errorRateResult.data?.[0] || { total_requests: 0, error_rate: 0 };

    return {
      errorRate: parseFloat(errorData.error_rate) || 0,
      p95Latency: p95Result.data || 0,
      totalRequests: parseInt(errorData.total_requests) || 0,
    };
  } catch (error) {
    console.error("Failed to get metrics summary:", error);
    return null;
  }
}

/**
 * Middleware-style metrics wrapper
 *
 * @example
 * ```typescript
 * Deno.serve(withMetrics("my-function", async (req) => {
 *   // Your handler code
 *   return new Response("OK");
 * }));
 * ```
 */
export function withMetrics(
  functionName: string,
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const startTime = performance.now();
    let statusCode = 200;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;

    try {
      const response = await handler(req);
      statusCode = response.status;
      return response;
    } catch (error) {
      statusCode = 500;
      errorCode = "UNHANDLED_ERROR";
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      recordMetric({
        functionName,
        requestId: crypto.randomUUID(),
        startTime,
        statusCode,
        errorCode,
        errorMessage,
      });
    }
  };
}

/**
 * Record health check result
 */
export async function recordHealthCheck(
  service: string,
  status: "healthy" | "degraded" | "unhealthy",
  responseTimeMs: number,
  details?: Record<string, unknown>,
  errorMessage?: string
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    await supabase.from("metrics.health_checks").insert({
      service,
      status,
      response_time_ms: responseTimeMs,
      details: details || {},
      error_message: errorMessage,
    });
  } catch (error) {
    console.error("Failed to record health check:", error);
  }
}

/**
 * Cleanup on module unload - flush any remaining metrics
 */
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("unload", () => {
    if (metricsQueue.length > 0) {
      // Synchronous cleanup isn't possible, but we try
      flushMetrics().catch(() => {});
    }
  });
}
