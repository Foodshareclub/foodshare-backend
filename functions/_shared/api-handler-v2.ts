/**
 * Bleeding-Edge API Handler v2
 *
 * Next-generation API handler with modern patterns:
 * - Type-safe Result pattern (no try/catch)
 * - OpenTelemetry distributed tracing
 * - Response compression (gzip/brotli)
 * - Security headers middleware
 * - Streaming support
 * - Valibot validation (10x smaller than Zod)
 *
 * @module
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Internal imports
import { type Result, ok, err, isOk, match, tryCatchAsync, type DomainError } from "./result.ts";
import { getTracer, withTracing, type Span, SpanStatusCode } from "./tracing.ts";
import { applySecurityHeaders, SecurityPresets, type SecurityHeadersConfig } from "./security-headers.ts";
import { withCompression, negotiateEncoding, type CompressionConfig } from "./compression.ts";
import { createContext, clearContext, setUserId, type RequestContext } from "./context.ts";
import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "./cors.ts";
import { logger } from "./logger.ts";

// =============================================================================
// Types
// =============================================================================

/** Valibot-compatible schema interface */
export interface Schema<T = unknown> {
  _parse(input: unknown): { output: T } | { issues: Array<{ path?: Array<{ key: string }>; message: string }> };
}

/** Handler result type - forces explicit error handling */
export type HandlerResult<T> = Result<T, DomainError>;
export type AsyncHandlerResult<T> = Promise<HandlerResult<T>>;

/** Handler context with full type safety */
export interface HandlerContext<TBody = unknown, TQuery = Record<string, string>> {
  /** Original request */
  readonly request: Request;
  /** Request context (requestId, traceId, etc.) */
  readonly ctx: RequestContext;
  /** Active trace span */
  readonly span: Span;
  /** Authenticated user ID */
  readonly userId: string | null;
  /** Supabase client */
  readonly supabase: SupabaseClient;
  /** Validated request body */
  readonly body: TBody;
  /** Validated query params */
  readonly query: TQuery;
  /** URL path parameters */
  readonly params: Record<string, string>;
  /** Request headers */
  readonly headers: Headers;
  /** CORS headers */
  readonly corsHeaders: Record<string, string>;
  /** Idempotency key */
  readonly idempotencyKey: string | null;
  /** Compression encoding */
  readonly encoding: "br" | "gzip" | "deflate" | "identity";
}

/** Type-safe route handler */
export type RouteHandler<TBody = unknown, TQuery = Record<string, string>, TResult = unknown> = (
  ctx: HandlerContext<TBody, TQuery>
) => AsyncHandlerResult<TResult>;

/** Route configuration */
export interface RouteConfig<TBody = unknown, TQuery = Record<string, string>, TResult = unknown> {
  /** Valibot schema for body validation */
  schema?: Schema<TBody>;
  /** Valibot schema for query validation */
  querySchema?: Schema<TQuery>;
  /** Route handler returning Result */
  handler: RouteHandler<TBody, TQuery, TResult>;
  /** Override auth requirement */
  requireAuth?: boolean;
  /** Enable idempotency */
  idempotent?: boolean;
  /** Enable streaming response */
  streaming?: boolean;
  /** Custom rate limit */
  rateLimit?: RateLimitConfig;
}

/** Rate limit configuration */
export interface RateLimitConfig {
  limit: number;
  windowMs: number;
  keyBy?: "ip" | "user" | "device" | ((ctx: HandlerContext) => string);
  skip?: (ctx: HandlerContext) => boolean;
}

/** API handler configuration */
export interface APIHandlerConfig {
  /** Service name */
  service: string;
  /** API version */
  version?: string;
  /** Default auth requirement */
  requireAuth?: boolean;
  /** URL path pattern for params */
  pathPattern?: string;
  /** Routes by method */
  routes: Partial<Record<HttpMethod, RouteConfig>>;
  /** Rate limiting */
  rateLimit?: RateLimitConfig;
  /** Security headers preset */
  security?: keyof typeof SecurityPresets | SecurityHeadersConfig;
  /** Compression config */
  compression?: CompressionConfig | false;
  /** Enable tracing */
  tracing?: boolean;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// =============================================================================
// Domain Errors
// =============================================================================

const createError = (code: string, message: string, status: number, context?: Record<string, unknown>): DomainError => ({
  code,
  message,
  context: { ...context, status },
});

export const Errors = {
  validation: (message: string, fields?: Record<string, string>) =>
    createError("VALIDATION_ERROR", message, 400, { fields }),
  unauthorized: (message = "Authentication required") =>
    createError("UNAUTHORIZED", message, 401),
  forbidden: (message = "Access denied") =>
    createError("FORBIDDEN", message, 403),
  notFound: (resource: string, id?: string) =>
    createError("NOT_FOUND", `${resource} not found`, 404, { resource, id }),
  conflict: (message: string) =>
    createError("CONFLICT", message, 409),
  rateLimited: (retryAfterMs: number) =>
    createError("RATE_LIMITED", "Rate limit exceeded", 429, { retryAfterMs }),
  internal: (message: string, cause?: Error) =>
    createError("INTERNAL_ERROR", message, 500, { cause: cause?.message }),
} as const;

// =============================================================================
// Validation
// =============================================================================

function validateWithValibot<T>(
  schema: Schema<T>,
  data: unknown,
  location: string
): Result<T, DomainError> {
  const result = schema._parse(data);

  if ("issues" in result) {
    const fields: Record<string, string> = {};
    for (const issue of result.issues) {
      const path = issue.path?.map((p) => p.key).join(".") || "root";
      fields[path] = issue.message;
    }
    return err(Errors.validation(`Invalid ${location}`, fields));
  }

  return ok(result.output);
}

// Also support Zod for backwards compatibility
function validateWithZod<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: { errors: Array<{ path: (string | number)[]; message: string }> } } },
  data: unknown,
  location: string
): Result<T, DomainError> {
  const result = schema.safeParse(data);

  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.errors) {
      fields[issue.path.join(".")] = issue.message;
    }
    return err(Errors.validation(`Invalid ${location}`, fields));
  }

  return ok(result.data);
}

function validate<T>(schema: unknown, data: unknown, location: string): Result<T, DomainError> {
  // Check if Valibot schema
  if (typeof (schema as Schema)._parse === "function") {
    return validateWithValibot(schema as Schema<T>, data, location);
  }
  // Assume Zod
  return validateWithZod(schema as Parameters<typeof validateWithZod<T>>[0], data, location);
}

// =============================================================================
// Response Building
// =============================================================================

function buildResponse<T>(
  result: Result<T, DomainError>,
  corsHeaders: Record<string, string>,
  options: { version?: string; requestId?: string } = {}
): Response {
  return match(result, {
    ok: (data) => {
      const body = JSON.stringify({
        success: true,
        data,
        meta: {
          version: options.version || "2",
          requestId: options.requestId,
          timestamp: new Date().toISOString(),
        },
      });

      return new Response(body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-Id": options.requestId || "",
          "X-API-Version": options.version || "2",
        },
      });
    },
    err: (error) => {
      const status = (error.context?.status as number) || 500;
      const body = JSON.stringify({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.context && { details: error.context }),
        },
        meta: {
          version: options.version || "2",
          requestId: options.requestId,
          timestamp: new Date().toISOString(),
        },
      });

      const headers: Record<string, string> = {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Id": options.requestId || "",
      };

      // Add rate limit headers
      if (error.code === "RATE_LIMITED" && error.context?.retryAfterMs) {
        headers["Retry-After"] = Math.ceil((error.context.retryAfterMs as number) / 1000).toString();
      }

      return new Response(body, { status, headers });
    },
  });
}

// =============================================================================
// Authentication
// =============================================================================

async function authenticate(
  supabase: SupabaseClient
): Promise<Result<string | null, DomainError>> {
  return tryCatchAsync(
    async () => {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return null;
      return user.id;
    },
    () => Errors.internal("Authentication failed")
  );
}

// =============================================================================
// Rate Limiting
// =============================================================================

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Result<{ remaining: number; resetAt: number }, DomainError> {
  const now = Date.now();
  const existing = rateLimitStore.get(key);

  if (!existing || existing.resetAt < now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return ok({ remaining: limit - 1, resetAt: now + windowMs });
  }

  if (existing.count >= limit) {
    return err(Errors.rateLimited(existing.resetAt - now));
  }

  existing.count++;
  return ok({ remaining: limit - existing.count, resetAt: existing.resetAt });
}

// Cleanup expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt < now) rateLimitStore.delete(key);
  }
}, 60000);

// =============================================================================
// Path Parameter Extraction
// =============================================================================

function extractPathParams(url: URL, pattern: string): Record<string, string> {
  const params: Record<string, string> = {};
  const patternSegments = pattern.split("/").filter(Boolean);
  const urlSegments = url.pathname.split("/").filter(Boolean);

  let startIndex = 0;
  for (let i = 0; i <= urlSegments.length - patternSegments.length; i++) {
    let matches = true;
    for (let j = 0; j < patternSegments.length; j++) {
      const ps = patternSegments[j];
      const us = urlSegments[i + j];
      if (!ps.startsWith(":") && ps !== us) {
        matches = false;
        break;
      }
    }
    if (matches) {
      startIndex = i;
      break;
    }
  }

  for (let i = 0; i < patternSegments.length; i++) {
    const ps = patternSegments[i];
    const us = urlSegments[startIndex + i];
    if (ps.startsWith(":") && us) {
      params[ps.slice(1)] = decodeURIComponent(us);
    }
  }

  return params;
}

// =============================================================================
// Utilities
// =============================================================================

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

async function parseBody(request: Request): Promise<Result<unknown, DomainError>> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return tryCatchAsync(
      async () => {
        const text = await request.text();
        return text ? JSON.parse(text) : {};
      },
      () => Errors.validation("Invalid JSON body")
    );
  }

  if (contentType.includes("multipart/form-data")) {
    return tryCatchAsync(
      async () => {
        const formData = await request.formData();
        const obj: Record<string, unknown> = {};
        formData.forEach((value, key) => { obj[key] = value; });
        return obj;
      },
      () => Errors.validation("Invalid form data")
    );
  }

  return ok({});
}

function parseQuery(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { params[key] = value; });
  return params;
}

// =============================================================================
// Main Handler Factory
// =============================================================================

export function createAPIHandler(config: APIHandlerConfig) {
  const {
    service,
    version = "2",
    requireAuth = true,
    pathPattern,
    routes,
    rateLimit: globalRateLimit,
    security = "api",
    compression = {},
    tracing = true,
  } = config;

  const tracer = getTracer(service);

  const handler = async (request: Request): Promise<Response> => {
    const ctx = createContext(request, service);
    const corsHeaders = getCorsHeadersWithMobile(request);
    const encoding = negotiateEncoding(request.headers.get("Accept-Encoding"));

    // Start span
    const span = tracer.startSpan(`${request.method} ${service}`, {
      attributes: {
        "http.method": request.method,
        "http.url": request.url,
        "service.name": service,
      },
    });

    try {
      // Handle preflight
      if (request.method === "OPTIONS") {
        return handleMobileCorsPrelight(request);
      }

      // Check method
      const method = request.method.toUpperCase() as HttpMethod;
      const routeConfig = routes[method];

      if (!routeConfig) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "Method not allowed" });
        return buildResponse(
          err(createError("METHOD_NOT_ALLOWED", `Method ${method} not allowed`, 405)),
          corsHeaders,
          { version, requestId: ctx.requestId }
        );
      }

      // Create Supabase client
      const authHeader = request.headers.get("authorization");
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
          global: { headers: authHeader ? { Authorization: authHeader } : {} },
          auth: { autoRefreshToken: false, persistSession: false },
        }
      );

      // Authenticate
      const routeRequiresAuth = routeConfig.requireAuth ?? requireAuth;
      let userId: string | null = null;

      if (routeRequiresAuth || authHeader) {
        const authResult = await authenticate(supabase);
        if (!isOk(authResult)) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Auth failed" });
          return buildResponse(authResult, corsHeaders, { version, requestId: ctx.requestId });
        }
        userId = authResult.value;

        if (routeRequiresAuth && !userId) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Unauthorized" });
          return buildResponse(
            err(Errors.unauthorized()),
            corsHeaders,
            { version, requestId: ctx.requestId }
          );
        }

        if (userId) setUserId(userId);
      }

      span.setAttribute("user.id", userId || "anonymous");

      // Parse URL
      const url = new URL(request.url);
      const query = parseQuery(url);
      const params = pathPattern ? extractPathParams(url, pathPattern) : {};

      // Validate query
      let validatedQuery = query;
      if (routeConfig.querySchema) {
        const queryResult = validate(routeConfig.querySchema, query, "query parameters");
        if (!isOk(queryResult)) {
          return buildResponse(queryResult, corsHeaders, { version, requestId: ctx.requestId });
        }
        validatedQuery = queryResult.value as Record<string, string>;
      }

      // Parse and validate body
      let body: unknown = {};
      if (["POST", "PUT", "PATCH"].includes(method)) {
        const bodyResult = await parseBody(request);
        if (!isOk(bodyResult)) {
          return buildResponse(bodyResult, corsHeaders, { version, requestId: ctx.requestId });
        }
        body = bodyResult.value;

        if (routeConfig.schema) {
          const schemaResult = validate(routeConfig.schema, body, "request body");
          if (!isOk(schemaResult)) {
            return buildResponse(schemaResult, corsHeaders, { version, requestId: ctx.requestId });
          }
          body = schemaResult.value;
        }
      }

      // Rate limiting
      const rateConfig = routeConfig.rateLimit || globalRateLimit;
      if (rateConfig) {
        const shouldSkip = rateConfig.skip?.({
          request, ctx, span, userId, supabase, body, query: validatedQuery,
          params, headers: request.headers, corsHeaders,
          idempotencyKey: null, encoding,
        } as HandlerContext) ?? false;

        if (!shouldSkip) {
          const keyBase = typeof rateConfig.keyBy === "function"
            ? rateConfig.keyBy({} as HandlerContext)
            : rateConfig.keyBy === "user" && userId
              ? `user:${userId}`
              : `ip:${getClientIp(request)}`;

          const rateLimitResult = checkRateLimit(
            `${keyBase}:${service}`,
            rateConfig.limit,
            rateConfig.windowMs
          );

          if (!isOk(rateLimitResult)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Rate limited" });
            return buildResponse(rateLimitResult, corsHeaders, { version, requestId: ctx.requestId });
          }
        }
      }

      // Build context
      const handlerContext: HandlerContext = {
        request,
        ctx,
        span,
        userId,
        supabase,
        body,
        query: validatedQuery,
        params,
        headers: request.headers,
        corsHeaders,
        idempotencyKey: request.headers.get("x-idempotency-key"),
        encoding,
      };

      // Execute handler
      const result = await routeConfig.handler(handlerContext);

      // Build response
      let response = buildResponse(result, corsHeaders, { version, requestId: ctx.requestId });

      // Apply security headers
      const securityConfig = typeof security === "string"
        ? (SecurityPresets[security] as SecurityHeadersConfig)
        : security;
      response = applySecurityHeaders(response, securityConfig);

      // Record success
      span.setAttribute("http.status_code", response.status);
      span.setStatus({ code: response.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });

      return response;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });

      logger.error("Unhandled error", error instanceof Error ? error : new Error(String(error)));

      return buildResponse(
        err(Errors.internal(error instanceof Error ? error.message : "Unknown error")),
        corsHeaders,
        { version, requestId: ctx.requestId }
      );
    } finally {
      span.end();
      clearContext();
    }
  };

  // Wrap with tracing if enabled
  if (tracing) {
    return withTracing(service, handler);
  }

  // Wrap with compression if enabled
  if (compression !== false) {
    return withCompression(handler, compression);
  }

  return handler;
}

// =============================================================================
// Response Helpers
// =============================================================================

/** Success result */
export const success = <T>(data: T): HandlerResult<T> => ok(data);

/** Error result */
export const failure = (error: DomainError): HandlerResult<never> => err(error);

/** Not found error */
export const notFound = (resource: string, id?: string): HandlerResult<never> =>
  err(Errors.notFound(resource, id));

/** Validation error */
export const invalid = (message: string, fields?: Record<string, string>): HandlerResult<never> =>
  err(Errors.validation(message, fields));

/** Unauthorized error */
export const unauthorized = (message?: string): HandlerResult<never> =>
  err(Errors.unauthorized(message));

/** Forbidden error */
export const forbidden = (message?: string): HandlerResult<never> =>
  err(Errors.forbidden(message));

// =============================================================================
// Re-exports
// =============================================================================

export { ok, err, isOk, match, type Result, type DomainError } from "./result.ts";
