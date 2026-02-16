/**
 * Prometheus Metrics Formatter
 *
 * Converts internal SLI counters, circuit breaker states, and error stats
 * into Prometheus text exposition format.
 *
 * @see https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import { getSLIBucketBoundaries, getSLICounters } from "./performance.ts";
import { getErrorStats } from "./error-tracking.ts";
import { getAllCircuitStatuses } from "./circuit-breaker.ts";

/**
 * Format all metrics in Prometheus text exposition format.
 */
export function formatPrometheusMetrics(): string {
  const lines: string[] = [];

  // SLI Counters
  const sliCounters = getSLICounters();
  const bucketBoundaries = getSLIBucketBoundaries();

  if (sliCounters.size > 0) {
    // Request count
    lines.push("# HELP foodshare_http_requests_total Total number of HTTP requests.");
    lines.push("# TYPE foodshare_http_requests_total counter");
    for (const [handler, data] of sliCounters) {
      const sanitized = sanitizeLabel(handler);
      lines.push(`foodshare_http_requests_total{handler="${sanitized}"} ${data.requestCount}`);
    }
    lines.push("");

    // Error count
    lines.push("# HELP foodshare_http_errors_total Total number of HTTP errors.");
    lines.push("# TYPE foodshare_http_errors_total counter");
    for (const [handler, data] of sliCounters) {
      const sanitized = sanitizeLabel(handler);
      lines.push(`foodshare_http_errors_total{handler="${sanitized}"} ${data.errorCount}`);
    }
    lines.push("");

    // Latency histogram
    lines.push(
      "# HELP foodshare_http_request_duration_ms_bucket HTTP request duration in milliseconds.",
    );
    lines.push("# TYPE foodshare_http_request_duration_ms_bucket histogram");
    for (const [handler, data] of sliCounters) {
      const sanitized = sanitizeLabel(handler);
      for (let i = 0; i < bucketBoundaries.length; i++) {
        const boundary = bucketBoundaries[i];
        const label = `le${boundary}`;
        const count = data.latencyBuckets[label] || 0;
        lines.push(
          `foodshare_http_request_duration_ms_bucket{handler="${sanitized}",le="${boundary}"} ${count}`,
        );
      }
      const infCount = data.latencyBuckets["leInf"] || 0;
      lines.push(
        `foodshare_http_request_duration_ms_bucket{handler="${sanitized}",le="+Inf"} ${infCount}`,
      );
    }
    lines.push("");
  }

  // Circuit breaker states
  const circuitBreakers = getAllCircuitStatuses();
  const cbEntries = Object.entries(circuitBreakers);
  if (cbEntries.length > 0) {
    lines.push(
      "# HELP foodshare_circuit_breaker_state Circuit breaker state (0=closed, 1=half-open, 2=open).",
    );
    lines.push("# TYPE foodshare_circuit_breaker_state gauge");
    for (const [name, cb] of cbEntries) {
      const stateValue = cb.state === "closed" ? 0 : cb.state === "half-open" ? 1 : 2;
      lines.push(`foodshare_circuit_breaker_state{name="${sanitizeLabel(name)}"} ${stateValue}`);
    }
    lines.push("");

    lines.push(
      "# HELP foodshare_circuit_breaker_failures_total Total circuit breaker failures.",
    );
    lines.push("# TYPE foodshare_circuit_breaker_failures_total counter");
    for (const [name, cb] of cbEntries) {
      lines.push(
        `foodshare_circuit_breaker_failures_total{name="${
          sanitizeLabel(name)
        }"} ${cb.totalFailures}`,
      );
    }
    lines.push("");
  }

  // Error stats
  const errorStats = getErrorStats();
  lines.push("# HELP foodshare_errors_total Total tracked errors by severity.");
  lines.push("# TYPE foodshare_errors_total counter");
  for (const [severity, count] of Object.entries(errorStats.bySeverity)) {
    lines.push(`foodshare_errors_total{severity="${severity}"} ${count}`);
  }
  lines.push("");

  // Memory usage
  try {
    const mem = Deno.memoryUsage();
    lines.push("# HELP foodshare_memory_heap_used_bytes Heap memory used in bytes.");
    lines.push("# TYPE foodshare_memory_heap_used_bytes gauge");
    lines.push(`foodshare_memory_heap_used_bytes ${mem.heapUsed}`);
    lines.push("");
    lines.push("# HELP foodshare_memory_rss_bytes Resident set size in bytes.");
    lines.push("# TYPE foodshare_memory_rss_bytes gauge");
    lines.push(`foodshare_memory_rss_bytes ${mem.rss}`);
    lines.push("");
  } catch {
    // Memory usage may not be available in all environments
  }

  return lines.join("\n") + "\n";
}

/**
 * Sanitize a label value for Prometheus (escape backslashes, quotes, newlines).
 */
function sanitizeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}
