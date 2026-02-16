/**
 * Performance Monitoring Utilities
 *
 * Provides performance tracking, metrics collection, slow query detection,
 * span tracing, and SLI counters.
 */

import { logger } from "./logger.ts";
import { getContext } from "./context.ts";

// =============================================================================
// Types
// =============================================================================

export interface PerformanceMetric {
  operation: string;
  durationMs: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SlowQueryAlert {
  query: string;
  durationMs: number;
  threshold: number;
  timestamp: string;
  context?: Record<string, unknown>;
}

// =============================================================================
// Span Tracing
// =============================================================================

export interface Span {
  operation: string;
  startTime: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  status: "ok" | "error";
}

export interface SpanHandle {
  end: (metadata?: Record<string, unknown>) => Span;
}

const MAX_SPANS_PER_REQUEST = 100;

// Per-request span storage (safe in single-threaded Deno edge functions)
let currentSpans: Span[] = [];

/**
 * Start a new span for tracking an operation within a request.
 * Call `.end()` on the returned handle when the operation completes.
 */
export function startSpan(operation: string): SpanHandle {
  const span: Span = {
    operation,
    startTime: performance.now(),
    status: "ok",
  };

  return {
    end: (metadata?: Record<string, unknown>): Span => {
      span.durationMs = Math.round(performance.now() - span.startTime);
      span.metadata = metadata;
      if (metadata?.error) {
        span.status = "error";
      }
      if (currentSpans.length < MAX_SPANS_PER_REQUEST) {
        currentSpans.push(span);
      }
      return span;
    },
  };
}

/**
 * Get all spans for the current request.
 */
export function getSpans(): Span[] {
  return [...currentSpans];
}

/**
 * Clear spans for the current request (call at end of request, before clearContext).
 */
export function clearSpans(): void {
  currentSpans = [];
}

// =============================================================================
// SLI Counters
// =============================================================================

export interface SLICounterData {
  requestCount: number;
  errorCount: number;
  latencyBuckets: Record<string, number>;
}

const LATENCY_BUCKET_BOUNDARIES = [100, 250, 500, 1000, 3000];
const LATENCY_BUCKET_LABELS = ["le100", "le250", "le500", "le1000", "le3000", "leInf"];

const sliCounters = new Map<string, SLICounterData>();

function getOrCreateSLI(handler: string): SLICounterData {
  let counter = sliCounters.get(handler);
  if (!counter) {
    counter = {
      requestCount: 0,
      errorCount: 0,
      latencyBuckets: Object.fromEntries(LATENCY_BUCKET_LABELS.map((l) => [l, 0])),
    };
    sliCounters.set(handler, counter);
  }
  return counter;
}

/**
 * Increment SLI counters for a completed request.
 */
export function recordSLI(handler: string, durationMs: number, isError: boolean): void {
  const counter = getOrCreateSLI(handler);
  counter.requestCount++;
  if (isError) counter.errorCount++;

  // Increment all buckets where durationMs <= boundary (cumulative histogram)
  for (let i = 0; i < LATENCY_BUCKET_BOUNDARIES.length; i++) {
    if (durationMs <= LATENCY_BUCKET_BOUNDARIES[i]) {
      counter.latencyBuckets[LATENCY_BUCKET_LABELS[i]]++;
    }
  }
  // +Inf bucket always gets incremented
  counter.latencyBuckets["leInf"]++;
}

/**
 * Get all SLI counters.
 */
export function getSLICounters(): Map<string, SLICounterData> {
  return new Map(sliCounters);
}

/**
 * Get SLI latency bucket boundaries (for Prometheus export).
 */
export function getSLIBucketBoundaries(): number[] {
  return [...LATENCY_BUCKET_BOUNDARIES];
}

// =============================================================================
// Configuration
// =============================================================================

const SLOW_QUERY_THRESHOLD_MS = 1000; // 1 second
const SLOW_OPERATION_THRESHOLD_MS = 3000; // 3 seconds
const METRICS_BUFFER_SIZE = 1000;

// =============================================================================
// In-Memory Metrics Store
// =============================================================================

const metricsBuffer: PerformanceMetric[] = [];
const slowQueries: SlowQueryAlert[] = [];

// =============================================================================
// Performance Timer
// =============================================================================

export class PerformanceTimer {
  private startTime: number;
  private operation: string;
  private metadata: Record<string, unknown>;

  constructor(operation: string, metadata: Record<string, unknown> = {}) {
    this.operation = operation;
    this.metadata = metadata;
    this.startTime = performance.now();
  }

  /**
   * End the timer and record the metric
   */
  end(additionalMetadata?: Record<string, unknown>): number {
    const durationMs = Math.round(performance.now() - this.startTime);

    const metric: PerformanceMetric = {
      operation: this.operation,
      durationMs,
      timestamp: new Date().toISOString(),
      metadata: { ...this.metadata, ...additionalMetadata },
    };

    // Add to buffer
    metricsBuffer.push(metric);
    if (metricsBuffer.length > METRICS_BUFFER_SIZE) {
      metricsBuffer.shift(); // Remove oldest
    }

    // Log slow operations
    if (durationMs > SLOW_OPERATION_THRESHOLD_MS) {
      logger.warn("Slow operation detected", {
        operation: this.operation,
        durationMs,
        threshold: SLOW_OPERATION_THRESHOLD_MS,
        ...this.metadata,
        ...additionalMetadata,
      });
    }

    return durationMs;
  }

  /**
   * Get elapsed time without ending the timer
   */
  elapsed(): number {
    return Math.round(performance.now() - this.startTime);
  }
}

// =============================================================================
// Async Operation Wrapper
// =============================================================================

/**
 * Wrap an async operation with performance tracking
 */
export async function measureAsync<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
): Promise<T> {
  const timer = new PerformanceTimer(operation, metadata);

  try {
    const result = await fn();
    timer.end({ success: true });
    return result;
  } catch (error) {
    timer.end({ success: false, error: (error as Error).message });
    throw error;
  }
}

/**
 * Wrap a sync operation with performance tracking
 */
export function measureSync<T>(
  operation: string,
  fn: () => T,
  metadata?: Record<string, unknown>,
): T {
  const timer = new PerformanceTimer(operation, metadata);

  try {
    const result = fn();
    timer.end({ success: true });
    return result;
  } catch (error) {
    timer.end({ success: false, error: (error as Error).message });
    throw error;
  }
}

// =============================================================================
// Database Query Tracking
// =============================================================================

/**
 * Track database query performance
 */
export async function trackQuery<T>(
  query: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>,
): Promise<T> {
  const timer = new PerformanceTimer("database_query", { query, ...context });

  try {
    const result = await fn();
    const durationMs = timer.end({ success: true });

    // Alert on slow queries
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      const alert: SlowQueryAlert = {
        query,
        durationMs,
        threshold: SLOW_QUERY_THRESHOLD_MS,
        timestamp: new Date().toISOString(),
        context,
      };

      slowQueries.push(alert);
      if (slowQueries.length > 100) {
        slowQueries.shift();
      }

      logger.warn("Slow query detected", {
        query: query.substring(0, 200), // Truncate long queries
        durationMs,
        threshold: SLOW_QUERY_THRESHOLD_MS,
        ...context,
      });
    }

    return result;
  } catch (error) {
    timer.end({ success: false, error: (error as Error).message });
    throw error;
  }
}

// =============================================================================
// Metrics Aggregation
// =============================================================================

export interface MetricsSummary {
  operation: string;
  count: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  successRate: number;
}

/**
 * Get aggregated metrics for an operation
 */
export function getMetricsSummary(operation?: string): MetricsSummary[] {
  const filtered = operation
    ? metricsBuffer.filter((m) => m.operation === operation)
    : metricsBuffer;

  if (filtered.length === 0) {
    return [];
  }

  // Group by operation
  const grouped = new Map<string, PerformanceMetric[]>();
  for (const metric of filtered) {
    const existing = grouped.get(metric.operation) || [];
    existing.push(metric);
    grouped.set(metric.operation, existing);
  }

  // Calculate summaries
  const summaries: MetricsSummary[] = [];
  for (const [op, metrics] of grouped.entries()) {
    const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
    const successes = metrics.filter((m) => m.metadata?.success === true).length;

    summaries.push({
      operation: op,
      count: metrics.length,
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      minDurationMs: durations[0],
      maxDurationMs: durations[durations.length - 1],
      p50DurationMs: durations[Math.floor(durations.length * 0.5)],
      p95DurationMs: durations[Math.floor(durations.length * 0.95)],
      p99DurationMs: durations[Math.floor(durations.length * 0.99)],
      successRate: Math.round((successes / metrics.length) * 100),
    });
  }

  return summaries.sort((a, b) => b.avgDurationMs - a.avgDurationMs);
}

/**
 * Get recent slow queries
 */
export function getSlowQueries(limit = 10): SlowQueryAlert[] {
  return slowQueries.slice(-limit).reverse();
}

/**
 * Clear metrics buffer
 */
export function clearMetrics(): void {
  metricsBuffer.length = 0;
  slowQueries.length = 0;
}

// =============================================================================
// Request Performance Tracking
// =============================================================================

/**
 * Track overall request performance
 */
export function trackRequest(handler: string): {
  end: (statusCode: number) => void;
} {
  const ctx = getContext();
  const timer = new PerformanceTimer("http_request", {
    handler,
    requestId: ctx?.requestId,
    userId: ctx?.userId,
  });

  return {
    end: (statusCode: number) => {
      const durationMs = timer.end({
        statusCode,
        success: statusCode < 400,
      });

      // Record SLI counters
      recordSLI(handler, durationMs, statusCode >= 400);

      // Log request completion
      logger.info("Request completed", {
        handler,
        statusCode,
        durationMs,
        requestId: ctx?.requestId,
      });
    },
  };
}

// =============================================================================
// Memory Usage Tracking
// =============================================================================

export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

/**
 * Get current memory usage
 */
export function getMemoryStats(): MemoryStats {
  const memUsage = Deno.memoryUsage();

  return {
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
    external: Math.round(memUsage.external / 1024 / 1024), // MB
    rss: Math.round(memUsage.rss / 1024 / 1024), // MB
  };
}

/**
 * Log memory usage if it exceeds threshold
 */
export function checkMemoryUsage(thresholdMB = 512): void {
  const stats = getMemoryStats();

  if (stats.heapUsed > thresholdMB) {
    logger.warn("High memory usage detected", {
      heapUsedMB: stats.heapUsed,
      heapTotalMB: stats.heapTotal,
      thresholdMB,
    });
  }
}

// =============================================================================
// Health Check Endpoint Data
// =============================================================================

export interface HealthMetrics {
  uptime: number;
  memory: MemoryStats;
  recentMetrics: MetricsSummary[];
  slowQueries: SlowQueryAlert[];
}

/**
 * Get health metrics for monitoring endpoint
 */
export function getHealthMetrics(): HealthMetrics {
  return {
    uptime: Math.round(performance.now() / 1000), // seconds
    memory: getMemoryStats(),
    recentMetrics: getMetricsSummary().slice(0, 10),
    slowQueries: getSlowQueries(5),
  };
}
