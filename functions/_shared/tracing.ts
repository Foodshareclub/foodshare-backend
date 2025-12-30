/**
 * OpenTelemetry Tracing Integration
 *
 * Provides distributed tracing for Edge Functions with:
 * - Automatic span creation for HTTP requests
 * - Context propagation via W3C Trace Context
 * - Integration with Supabase and external services
 * - Export to OTLP-compatible backends (Grafana, Honeycomb, etc.)
 *
 * @module
 */

// =============================================================================
// Types (inline to avoid npm import issues in Edge)
// =============================================================================

interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}

interface Span {
  spanContext(): SpanContext;
  setAttribute(key: string, value: string | number | boolean): Span;
  setStatus(status: { code: number; message?: string }): Span;
  recordException(error: Error): void;
  end(): void;
}

interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
  kind?: SpanKind;
}

enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}

enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

// =============================================================================
// Configuration
// =============================================================================

const OTEL_ENABLED = Deno.env.get("OTEL_ENABLED") === "true";
const OTEL_ENDPOINT = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT") || "";
const OTEL_SERVICE_NAME = Deno.env.get("OTEL_SERVICE_NAME") || "foodshare-edge";
const OTEL_HEADERS = Deno.env.get("OTEL_EXPORTER_OTLP_HEADERS") || "";

// =============================================================================
// Lightweight Span Implementation (for Edge runtime)
// =============================================================================

function generateId(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

class EdgeSpan implements Span {
  private _traceId: string;
  private _spanId: string;
  private _parentSpanId: string | null;
  private _name: string;
  private _startTime: number;
  private _endTime: number | null = null;
  private _attributes: Record<string, string | number | boolean> = {};
  private _status: { code: number; message?: string } = { code: SpanStatusCode.UNSET };
  private _events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }> = [];

  constructor(
    name: string,
    traceId?: string,
    parentSpanId?: string | null,
    attributes?: Record<string, string | number | boolean>
  ) {
    this._name = name;
    this._traceId = traceId || generateId(16);
    this._spanId = generateId(8);
    this._parentSpanId = parentSpanId || null;
    this._startTime = performance.now();
    if (attributes) {
      this._attributes = { ...attributes };
    }
  }

  spanContext(): SpanContext {
    return {
      traceId: this._traceId,
      spanId: this._spanId,
      traceFlags: 1, // Sampled
    };
  }

  setAttribute(key: string, value: string | number | boolean): Span {
    this._attributes[key] = value;
    return this;
  }

  setStatus(status: { code: number; message?: string }): Span {
    this._status = status;
    return this;
  }

  recordException(error: Error): void {
    this._events.push({
      name: "exception",
      timestamp: performance.now(),
      attributes: {
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack,
      },
    });
    this.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }

  end(): void {
    if (this._endTime !== null) return;
    this._endTime = performance.now();

    // Export span asynchronously if OTEL is enabled
    if (OTEL_ENABLED && OTEL_ENDPOINT) {
      this.exportSpan().catch(() => {
        // Silently ignore export errors in Edge
      });
    }
  }

  private async exportSpan(): Promise<void> {
    const spanData = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: OTEL_SERVICE_NAME } },
            { key: "deployment.environment", value: { stringValue: Deno.env.get("ENVIRONMENT") || "production" } },
          ],
        },
        scopeSpans: [{
          scope: { name: "foodshare-edge-functions" },
          spans: [{
            traceId: this._traceId,
            spanId: this._spanId,
            parentSpanId: this._parentSpanId || undefined,
            name: this._name,
            kind: SpanKind.SERVER,
            startTimeUnixNano: BigInt(Math.floor((performance.timeOrigin + this._startTime) * 1_000_000)).toString(),
            endTimeUnixNano: BigInt(Math.floor((performance.timeOrigin + (this._endTime || performance.now())) * 1_000_000)).toString(),
            attributes: Object.entries(this._attributes).map(([key, value]) => ({
              key,
              value: typeof value === "string" ? { stringValue: value } :
                     typeof value === "number" ? { intValue: value.toString() } :
                     { boolValue: value },
            })),
            status: this._status.code === SpanStatusCode.ERROR
              ? { code: 2, message: this._status.message }
              : { code: this._status.code },
            events: this._events.map((e) => ({
              name: e.name,
              timeUnixNano: BigInt(Math.floor((performance.timeOrigin + e.timestamp) * 1_000_000)).toString(),
              attributes: e.attributes ? Object.entries(e.attributes).map(([key, value]) => ({
                key,
                value: { stringValue: String(value) },
              })) : [],
            })),
          }],
        }],
      }],
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Parse OTEL headers (format: "key1=value1,key2=value2")
    if (OTEL_HEADERS) {
      OTEL_HEADERS.split(",").forEach((pair) => {
        const [key, value] = pair.split("=");
        if (key && value) headers[key.trim()] = value.trim();
      });
    }

    await fetch(`${OTEL_ENDPOINT}/v1/traces`, {
      method: "POST",
      headers,
      body: JSON.stringify(spanData),
    });
  }

  toJSON() {
    return {
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      name: this._name,
      startTime: this._startTime,
      endTime: this._endTime,
      attributes: this._attributes,
      status: this._status,
    };
  }
}

// =============================================================================
// Tracer Implementation
// =============================================================================

class EdgeTracer implements Tracer {
  private _currentSpan: EdgeSpan | null = null;

  constructor(_name: string) {
    // Name stored for debugging/logging if needed
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const parentContext = this._currentSpan?.spanContext();
    const span = new EdgeSpan(
      name,
      parentContext?.traceId,
      parentContext?.spanId,
      options?.attributes
    );
    this._currentSpan = span;
    return span;
  }

  getCurrentSpan(): EdgeSpan | null {
    return this._currentSpan;
  }
}

// =============================================================================
// Global Tracer Registry
// =============================================================================

const tracers = new Map<string, EdgeTracer>();

export function getTracer(name: string): Tracer {
  if (!tracers.has(name)) {
    tracers.set(name, new EdgeTracer(name));
  }
  return tracers.get(name)!;
}

// =============================================================================
// W3C Trace Context Propagation
// =============================================================================

const TRACEPARENT_REGEX = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  traceFlags: number;
}

/** Extract trace context from incoming request headers */
export function extractTraceContext(headers: Headers): TraceContext | null {
  const traceparent = headers.get("traceparent");
  if (!traceparent) return null;

  const match = traceparent.match(TRACEPARENT_REGEX);
  if (!match) return null;

  return {
    traceId: match[1],
    parentSpanId: match[2],
    traceFlags: parseInt(match[3], 16),
  };
}

/** Inject trace context into outgoing request headers */
export function injectTraceContext(headers: Headers, span: Span): void {
  const ctx = span.spanContext();
  const traceparent = `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags.toString(16).padStart(2, "0")}`;
  headers.set("traceparent", traceparent);
}

// =============================================================================
// Middleware Helpers
// =============================================================================

export interface TracingContext {
  span: Span;
  traceId: string;
  spanId: string;
}

/** Create a traced handler wrapper */
export function withTracing(
  serviceName: string,
  handler: (request: Request) => Promise<Response>
): (request: Request) => Promise<Response> {
  const tracer = getTracer(serviceName);

  return async (request: Request) => {
    const url = new URL(request.url);

    // Extract parent context if present
    const parentContext = extractTraceContext(request.headers);

    // Start span
    const span = tracer.startSpan(`${request.method} ${url.pathname}`, {
      attributes: {
        "http.method": request.method,
        "http.url": url.href,
        "http.target": url.pathname + url.search,
        "http.host": url.host,
        "http.scheme": url.protocol.replace(":", ""),
        "http.user_agent": request.headers.get("user-agent") || "",
      },
    });

    // If we have a parent context, link to it
    if (parentContext) {
      span.setAttribute("parent.trace_id", parentContext.traceId);
      span.setAttribute("parent.span_id", parentContext.parentSpanId);
    }

    try {
      const response = await handler(request);

      // Record response attributes
      span.setAttribute("http.status_code", response.status);

      if (response.status >= 400) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.status}`,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // Inject trace context into response headers
      const newHeaders = new Headers(response.headers);
      injectTraceContext(newHeaders, span);
      newHeaders.set("X-Trace-Id", span.spanContext().traceId);

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  };
}

/** Create a child span for database operations */
export function traceDatabase(
  tracer: Tracer,
  operation: string,
  table: string
): Span {
  return tracer.startSpan(`DB ${operation} ${table}`, {
    attributes: {
      "db.system": "postgresql",
      "db.operation": operation,
      "db.sql.table": table,
    },
  });
}

/** Create a child span for external HTTP calls */
export function traceExternalCall(
  tracer: Tracer,
  method: string,
  url: string
): Span {
  return tracer.startSpan(`HTTP ${method} ${new URL(url).hostname}`, {
    attributes: {
      "http.method": method,
      "http.url": url,
    },
  });
}

// =============================================================================
// Exports
// =============================================================================

export { SpanKind, SpanStatusCode };
export type { Span, Tracer, SpanOptions };
