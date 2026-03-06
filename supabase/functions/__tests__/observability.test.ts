/**
 * Observability Tests
 *
 * Tests for span tracing, SLI counters, Prometheus metrics, and traced fetch.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  clearSpans,
  getSLICounters,
  getSpans,
  recordSLI,
  startSpan,
} from "../_shared/performance.ts";
import { formatPrometheusMetrics } from "../_shared/prometheus.ts";
import { clearContext, createContext } from "../_shared/context.ts";
import { tracedFetch } from "../_shared/traced-fetch.ts";

// =============================================================================
// Span Tracing Tests
// =============================================================================

Deno.test("startSpan: records duration on end", () => {
  clearSpans();
  const span = startSpan("test.operation");
  // Simulate some work
  const result = span.end({ key: "value" });
  assertExists(result.durationMs);
  assertEquals(result.operation, "test.operation");
  assertEquals(result.status, "ok");
  assertEquals(result.metadata?.key, "value");
});

Deno.test("startSpan: marks error status when metadata has error", () => {
  clearSpans();
  const span = startSpan("test.error.op");
  const result = span.end({ error: "something failed" });
  assertEquals(result.status, "error");
});

Deno.test("getSpans: returns all spans for current request", () => {
  clearSpans();
  startSpan("op1").end();
  startSpan("op2").end();
  startSpan("op3").end();
  const spans = getSpans();
  assertEquals(spans.length, 3);
  assertEquals(spans[0].operation, "op1");
  assertEquals(spans[2].operation, "op3");
});

Deno.test("spans: capped at 100 per request", () => {
  clearSpans();
  for (let i = 0; i < 110; i++) {
    startSpan(`op_${i}`).end();
  }
  const spans = getSpans();
  assertEquals(spans.length, 100);
  assertEquals(spans[0].operation, "op_0");
  assertEquals(spans[99].operation, "op_99");
});

Deno.test("clearSpans: resets span array", () => {
  clearSpans();
  startSpan("test").end();
  assertEquals(getSpans().length, 1);
  clearSpans();
  assertEquals(getSpans().length, 0);
});

// =============================================================================
// SLI Counter Tests
// =============================================================================

Deno.test("recordSLI: increments request count", () => {
  const handler = "test-sli-req-count";
  recordSLI(handler, 50, false);
  recordSLI(handler, 100, false);
  const counters = getSLICounters();
  const data = counters.get(handler);
  assertExists(data);
  assertEquals(data.requestCount, 2);
  assertEquals(data.errorCount, 0);
});

Deno.test("recordSLI: increments error count for errors", () => {
  const handler = "test-sli-errors";
  recordSLI(handler, 50, false);
  recordSLI(handler, 200, true);
  recordSLI(handler, 300, true);
  const counters = getSLICounters();
  const data = counters.get(handler);
  assertExists(data);
  assertEquals(data.requestCount, 3);
  assertEquals(data.errorCount, 2);
});

Deno.test("recordSLI: latency buckets assigned correctly for fast request", () => {
  const handler = "test-sli-bucket-fast";
  recordSLI(handler, 50, false); // 50ms <= 100, 250, 500, 1000, 3000, +Inf
  const counters = getSLICounters();
  const data = counters.get(handler)!;
  assertEquals(data.latencyBuckets["le100"], 1);
  assertEquals(data.latencyBuckets["le250"], 1);
  assertEquals(data.latencyBuckets["le500"], 1);
  assertEquals(data.latencyBuckets["le1000"], 1);
  assertEquals(data.latencyBuckets["le3000"], 1);
  assertEquals(data.latencyBuckets["leInf"], 1);
});

Deno.test("recordSLI: latency buckets assigned correctly for medium request", () => {
  const handler = "test-sli-bucket-medium";
  recordSLI(handler, 300, false); // 300ms > 100, 250 but <= 500, 1000, 3000, +Inf
  const counters = getSLICounters();
  const data = counters.get(handler)!;
  assertEquals(data.latencyBuckets["le100"], 0);
  assertEquals(data.latencyBuckets["le250"], 0);
  assertEquals(data.latencyBuckets["le500"], 1);
  assertEquals(data.latencyBuckets["le1000"], 1);
  assertEquals(data.latencyBuckets["le3000"], 1);
  assertEquals(data.latencyBuckets["leInf"], 1);
});

Deno.test("recordSLI: latency buckets assigned correctly for slow request", () => {
  const handler = "test-sli-bucket-slow";
  recordSLI(handler, 5000, false); // 5000ms > all boundaries, only +Inf
  const counters = getSLICounters();
  const data = counters.get(handler)!;
  assertEquals(data.latencyBuckets["le100"], 0);
  assertEquals(data.latencyBuckets["le250"], 0);
  assertEquals(data.latencyBuckets["le500"], 0);
  assertEquals(data.latencyBuckets["le1000"], 0);
  assertEquals(data.latencyBuckets["le3000"], 0);
  assertEquals(data.latencyBuckets["leInf"], 1);
});

// =============================================================================
// Prometheus Format Tests
// =============================================================================

Deno.test("formatPrometheusMetrics: includes valid metric names and types", () => {
  // Record some data so Prometheus has something to format
  recordSLI("test-prom-handler", 150, false);

  const output = formatPrometheusMetrics();

  // Check for required Prometheus format elements
  assertEquals(output.includes("# HELP foodshare_http_requests_total"), true);
  assertEquals(output.includes("# TYPE foodshare_http_requests_total counter"), true);
  assertEquals(output.includes("# HELP foodshare_errors_total"), true);
  assertEquals(output.includes("# TYPE foodshare_errors_total counter"), true);
  assertEquals(output.includes('foodshare_http_requests_total{handler="test-prom-handler"}'), true);
  // Output should end with newline
  assertEquals(output.endsWith("\n"), true);
});

Deno.test("formatPrometheusMetrics: includes latency histogram buckets", () => {
  recordSLI("test-prom-hist", 250, false);
  const output = formatPrometheusMetrics();
  assertEquals(output.includes("foodshare_http_request_duration_ms_bucket"), true);
  assertEquals(output.includes('le="+Inf"'), true);
});

Deno.test("formatPrometheusMetrics: includes error severity breakdown", () => {
  const output = formatPrometheusMetrics();
  assertEquals(output.includes('foodshare_errors_total{severity="critical"}'), true);
  assertEquals(output.includes('foodshare_errors_total{severity="low"}'), true);
});

// =============================================================================
// Traced Fetch Tests
// =============================================================================

Deno.test("tracedFetch: creates span and forwards context headers", async () => {
  clearSpans();

  // Create request context so headers are available
  const mockRequest = new Request("http://localhost/test", { method: "GET" });
  const ctx = createContext(mockRequest, "test-service");

  // Save original fetch and mock it
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | undefined;

  globalThis.fetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const response = await tracedFetch("https://example.com/api/test", {
      method: "GET",
    }, "test.external.api");

    assertEquals(response.status, 200);

    // Verify span was created
    const spans = getSpans();
    assertEquals(spans.length >= 1, true);
    const fetchSpan = spans.find((s) => s.operation === "test.external.api");
    assertExists(fetchSpan);
    assertEquals(fetchSpan.status, "ok");
    assertExists(fetchSpan.durationMs);

    // Verify context headers were forwarded
    assertExists(capturedHeaders);
    const headers = capturedHeaders as Headers;
    assertEquals(headers.get("X-Request-Id"), ctx.requestId);
    assertEquals(headers.get("X-Correlation-Id"), ctx.correlationId);
  } finally {
    globalThis.fetch = originalFetch;
    clearContext();
    clearSpans();
  }
});
