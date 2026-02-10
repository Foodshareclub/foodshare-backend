/**
 * Unified API Handler
 *
 * Enterprise-grade API handler for cross-platform Edge Functions.
 * Provides:
 * - CORS handling (web + mobile)
 * - Authentication validation
 * - Request schema validation (Zod + Valibot)
 * - Idempotency key support
 * - Rate limiting integration
 * - Method routing
 * - Consistent error handling
 * - Request context and tracing
 *
 * @example
 * ```typescript
 * import { createAPIHandler } from "../_shared/api-handler.ts";
 * import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
 *
 * const createProductSchema = z.object({
 *   name: z.string().min(1),
 *   description: z.string(),
 *   location: z.object({ lat: z.number(), lng: z.number() }),
 * });
 *
 * export default createAPIHandler({
 *   service: "products-api",
 *   requireAuth: true,
 *   routes: {
 *     GET: { handler: listProducts },
 *     POST: { schema: createProductSchema, handler: createProduct },
 *   },
 * });
 * ```
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { createContext, clearContext, setUserId, type RequestContext } from "./context.ts";
import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "./cors.ts";
import {
  AppError,
  AuthenticationError,
  ValidationError,
  RateLimitError,
} from "./errors.ts";
import {
  buildSuccessResponse,
  buildErrorResponse,
  shouldUseTransitionalFormat,
  type UIHints,
} from "./response-adapter.ts";
import { logger } from "./logger.ts";
import { trackError } from "./error-tracking.ts";
import { trackRequest, checkMemoryUsage } from "./performance.ts";
import { validateCsrf, type CsrfOptions, CsrfError } from "./csrf.ts";

// =============================================================================
// Types
// =============================================================================

/** Schema interface supporting both Zod and Valibot */
interface Schema<T = unknown> {
  // Zod
  parse?: (data: unknown) => T;
  safeParse?: (data: unknown) => { success: true; data: T } | { success: false; error: { errors: Array<{ path: (string | number)[]; message: string }> } };
  // Valibot
  _parse?: (input: unknown) => { output: T } | { issues: Array<{ path?: Array<{ key: string }>; message: string }> };
}

/** Handler context with parsed data and auth info */
export interface HandlerContext<TBody = unknown, TQuery = Record<string, string>> {
  /** The original request */
  request: Request;
  /** Request context (requestId, correlationId, etc.) */
  ctx: RequestContext;
  /** Authenticated user ID (if requireAuth is true) */
  userId: string | null;
  /** Supabase client (authenticated if userId is set) */
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>;
  /** Parsed and validated request body */
  body: TBody;
  /** URL query parameters */
  query: TQuery;
  /** URL path parameters (from route matching) */
  params: Record<string, string>;
  /** Request headers */
  headers: Headers;
  /** Idempotency key (if provided) */
  idempotencyKey: string | null;
  /** CORS headers for response */
  corsHeaders: Record<string, string>;
}

/** Route handler function */
export type RouteHandler<TBody = unknown, TQuery = Record<string, string>> = (
  ctx: HandlerContext<TBody, TQuery>
) => Promise<Response>;

/** Route configuration */
export interface RouteConfig<TBody = unknown, TQuery = Record<string, string>> {
  /** Zod schema for request body validation (POST/PUT/PATCH) */
  schema?: Schema<TBody>;
  /** Zod schema for query parameters */
  querySchema?: Schema<TQuery>;
  /** Route handler */
  handler: RouteHandler<TBody, TQuery>;
  /** Override auth requirement for this route */
  requireAuth?: boolean;
  /** Enable idempotency check for this route */
  idempotent?: boolean;
}

/** HTTP methods supported */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Maximum requests allowed in window */
  limit: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Key generator: how to identify the client */
  keyBy?: "ip" | "user" | "device" | ((ctx: HandlerContext) => string);
  /** Use distributed store (database) vs in-memory */
  distributed?: boolean;
  /** Skip rate limit for certain conditions */
  skip?: (ctx: HandlerContext) => boolean;
}

/** Deprecated version configuration */
export interface DeprecatedVersion {
  version: string;
  message: string;
  sunsetDate: string; // ISO 8601 date
}

/** API handler configuration */
export interface APIHandlerConfig {
  /** Service name for logging and tracing */
  service: string;
  /** Require authentication for all routes (default: true) */
  requireAuth?: boolean;
  /** API version (for response headers) */
  version?: string;
  /** URL path pattern for path parameter extraction (e.g., "/products/:productId") */
  pathPattern?: string;
  /** Routes by HTTP method */
  routes: Partial<Record<HttpMethod, RouteConfig>>;
  /** Built-in rate limiting configuration */
  rateLimit?: RateLimitConfig;
  /** Custom rate limit check (return error Response to block) */
  checkRateLimit?: (ctx: HandlerContext) => Promise<Response | null>;
  /** Additional allowed origins */
  additionalOrigins?: string[];
  /** Supported API versions */
  supportedVersions?: string[];
  /** Deprecated versions with sunset dates */
  deprecatedVersions?: DeprecatedVersion[];
  /** CSRF protection configuration (enabled by default for mutation requests) */
  csrf?: CsrfOptions | boolean;
}

// =============================================================================
// Supabase Client Factory
// =============================================================================

function createSupabaseClient(authHeader?: string | null) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  return createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: authHeader ? { Authorization: authHeader } : {},
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// =============================================================================
// Authentication
// =============================================================================

// deno-lint-ignore no-explicit-any
async function authenticateRequest(
  supabase: SupabaseClient<any, any, any>
): Promise<string | null> {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return null;
    }

    return user.id;
  } catch {
    return null;
  }
}

// =============================================================================
// Idempotency
// =============================================================================

// deno-lint-ignore no-explicit-any
async function checkIdempotencyKey(
  supabase: SupabaseClient<any, any, any>,
  key: string,
  operation: string
): Promise<{ cached: boolean; response?: unknown }> {
  const { data, error } = await supabase.rpc("check_idempotency_key", {
    p_key: key,
    p_operation: operation,
    p_response: null,
  });

  if (error) {
    logger.warn("Idempotency check failed", { error: error.message });
    return { cached: false };
  }

  return data as { cached: boolean; response?: unknown };
}

// deno-lint-ignore no-explicit-any
async function storeIdempotencyKey(
  supabase: SupabaseClient<any, any, any>,
  key: string,
  operation: string,
  response: unknown
): Promise<void> {
  const { error } = await supabase.rpc("check_idempotency_key", {
    p_key: key,
    p_operation: operation,
    p_response: response,
  });

  if (error) {
    logger.warn("Idempotency store failed", { error: error.message });
  }
}

// =============================================================================
// Request Parsing
// =============================================================================

async function parseRequestBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const text = await request.text();
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ValidationError("Invalid JSON in request body");
    }
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const obj: Record<string, unknown> = {};
    formData.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }

  return {};
}

function parseQueryParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

// =============================================================================
// Validation
// =============================================================================

function validateWithSchema<T>(schema: Schema<T>, data: unknown, location: string): T {
  // Try Zod first (check safeParse before _parse, since Zod also has _parse
  // but with a different signature that expects ParseInput, not raw data)
  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);

    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));

      throw new ValidationError(`Invalid ${location}`, errors);
    }

    return result.data;
  }

  // Fall back to Valibot
  if (typeof schema._parse === "function") {
    const result = schema._parse(data);

    if ("issues" in result) {
      const errors = result.issues.map((issue) => ({
        field: issue.path?.map((p) => p.key).join(".") || "root",
        message: issue.message,
      }));
      throw new ValidationError(`Invalid ${location}`, errors);
    }

    return result.output;
  }

  throw new ValidationError(`Invalid schema for ${location}`);
}

// =============================================================================
// Path Parameter Extraction
// =============================================================================

/**
 * Extract path parameters from URL based on pattern
 *
 * @example
 * extractPathParams(new URL("https://example.com/products/123/reviews/456"), "/products/:productId/reviews/:reviewId")
 * // => { productId: "123", reviewId: "456" }
 */
function extractPathParams(url: URL, pattern: string): Record<string, string> {
  const params: Record<string, string> = {};

  // Extract the path from the URL (handle edge function paths)
  // Edge functions might be at /products or /api/products
  const urlPath = url.pathname;

  // Split pattern and URL path into segments
  const patternSegments = pattern.split("/").filter(Boolean);
  const urlSegments = urlPath.split("/").filter(Boolean);

  // Find where the pattern starts in the URL
  // This handles cases like URL: /api/products/123 and pattern: /products/:id
  let startIndex = 0;
  for (let i = 0; i <= urlSegments.length - patternSegments.length; i++) {
    let matches = true;
    for (let j = 0; j < patternSegments.length; j++) {
      const patternSeg = patternSegments[j];
      const urlSeg = urlSegments[i + j];

      // Parameter segments always match
      if (patternSeg.startsWith(":")) continue;

      // Static segments must match exactly
      if (patternSeg !== urlSeg) {
        matches = false;
        break;
      }
    }
    if (matches) {
      startIndex = i;
      break;
    }
  }

  // Extract parameters
  for (let i = 0; i < patternSegments.length; i++) {
    const patternSeg = patternSegments[i];
    const urlSeg = urlSegments[startIndex + i];

    if (patternSeg.startsWith(":") && urlSeg) {
      const paramName = patternSeg.slice(1);
      params[paramName] = decodeURIComponent(urlSeg);
    }
  }

  return params;
}

// =============================================================================
// In-Memory Rate Limiting (for non-distributed mode)
// =============================================================================

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkInMemoryRateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const existing = rateLimitStore.get(key);

  if (!existing || existing.resetAt < now) {
    // Window expired or first request
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count++;
  return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean every minute

// =============================================================================
// Rate Limit Key Generators
// =============================================================================

function getRateLimitKey(
  ctx: HandlerContext,
  keyBy: RateLimitConfig["keyBy"],
  service: string
): string {
  if (typeof keyBy === "function") {
    return keyBy(ctx);
  }

  switch (keyBy) {
    case "user":
      return ctx.userId ? `user:${ctx.userId}:${service}` : `anon:${getClientIp(ctx.request)}:${service}`;
    case "device":
      const deviceId = ctx.headers.get("x-device-id") || ctx.headers.get("x-client-id");
      return deviceId ? `device:${deviceId}:${service}` : `ip:${getClientIp(ctx.request)}:${service}`;
    case "ip":
    default:
      return `ip:${getClientIp(ctx.request)}:${service}`;
  }
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// =============================================================================
// Main Handler Factory
// =============================================================================

/**
 * Create an API handler with full enterprise features
 */
export function createAPIHandler(config: APIHandlerConfig) {
  const {
    service,
    requireAuth = true,
    version = "1",
    pathPattern,
    routes,
    rateLimit,
    checkRateLimit,
    additionalOrigins,
    supportedVersions: _supportedVersions,
    deprecatedVersions,
    csrf = true, // CSRF protection enabled by default
  } = config;

  return async (request: Request): Promise<Response> => {
    // Initialize context
    const ctx = createContext(request, service);
    const corsHeaders = getCorsHeadersWithMobile(request, additionalOrigins);
    const useTransitional = shouldUseTransitionalFormat(request);
    const perfTracker = trackRequest(service);

    // Check memory usage periodically
    checkMemoryUsage();

    try {
      // Handle preflight
      if (request.method === "OPTIONS") {
        return handleMobileCorsPrelight(request, additionalOrigins);
      }

      // Check method is supported
      const method = request.method.toUpperCase() as HttpMethod;
      const routeConfig = routes[method];

      if (!routeConfig) {
        const allowedMethods = Object.keys(routes).filter((m) => m !== "OPTIONS");
        return buildErrorResponse(
          new AppError(
            `Method ${method} not allowed. Use: ${allowedMethods.join(", ")}`,
            "METHOD_NOT_ALLOWED",
            405
          ),
          corsHeaders,
          { version, includeTransitional: useTransitional }
        );
      }

      // CSRF protection for mutation methods (POST, PUT, PATCH, DELETE)
      if (csrf && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const csrfOptions: CsrfOptions = typeof csrf === "object" ? csrf : {};
        csrfOptions.additionalOrigins = [
          ...(csrfOptions.additionalOrigins || []),
          ...(additionalOrigins || []),
        ];

        const csrfResult = validateCsrf(request, csrfOptions);
        if (!csrfResult.valid) {
          logger.warn("CSRF validation failed", {
            reason: csrfResult.reason,
            origin: request.headers.get("origin"),
            referer: request.headers.get("referer"),
          });
          return buildErrorResponse(
            new AppError(
              "Request blocked: origin validation failed",
              "CSRF_VALIDATION_FAILED",
              403
            ),
            corsHeaders,
            { version, includeTransitional: useTransitional }
          );
        }
      }

      // Check API version deprecation
      const requestedVersion = getRequestedVersion(request);
      const deprecationInfo = deprecatedVersions?.find((d) => d.version === requestedVersion);

      // Create Supabase client
      const authHeader = request.headers.get("authorization");
      const supabase = createSupabaseClient(authHeader);

      // Authenticate if required
      const routeRequiresAuth = routeConfig.requireAuth ?? requireAuth;
      let userId: string | null = null;

      if (routeRequiresAuth) {
        userId = await authenticateRequest(supabase);

        if (!userId) {
          return buildErrorResponse(
            new AuthenticationError(),
            corsHeaders,
            { version, includeTransitional: useTransitional }
          );
        }

        setUserId(userId);
      } else if (authHeader) {
        // Optional auth - try to get user but don't require it
        userId = await authenticateRequest(supabase);
        if (userId) setUserId(userId);
      }

      // Parse URL and query params
      const url = new URL(request.url);
      const query = parseQueryParams(url);

      // Extract path parameters if pattern is configured
      const params = pathPattern ? extractPathParams(url, pathPattern) : {};

      // Validate query params if schema provided
      const validatedQuery = routeConfig.querySchema
        ? validateWithSchema(routeConfig.querySchema, query, "query parameters")
        : query;

      // Parse and validate body for mutation methods
      let body: unknown = {};
      if (["POST", "PUT", "PATCH"].includes(method)) {
        body = await parseRequestBody(request);

        if (routeConfig.schema) {
          body = validateWithSchema(routeConfig.schema, body, "request body");
        }
      }

      // Get idempotency key
      const idempotencyKey = request.headers.get("x-idempotency-key");

      // Check idempotency for supported routes
      if (idempotencyKey && routeConfig.idempotent) {
        const idempotencyCheck = await checkIdempotencyKey(
          supabase,
          idempotencyKey,
          `${service}:${method}`
        );

        if (idempotencyCheck.cached && idempotencyCheck.response) {
          logger.info("Returning cached idempotent response", { idempotencyKey });
          return buildSuccessResponse(idempotencyCheck.response, corsHeaders, {
            version,
            includeTransitional: useTransitional,
          });
        }
      }

      // Build handler context
      const handlerContext: HandlerContext = {
        request,
        ctx,
        userId,
        supabase,
        body,
        query: validatedQuery,
        params,
        headers: request.headers,
        idempotencyKey,
        corsHeaders,
      };

      // Check built-in rate limit if configured
      if (rateLimit) {
        const shouldSkip = rateLimit.skip?.(handlerContext) ?? false;

        if (!shouldSkip) {
          const rateLimitKey = getRateLimitKey(handlerContext, rateLimit.keyBy, service);
          const rateLimitResult = checkInMemoryRateLimit(
            rateLimitKey,
            rateLimit.limit,
            rateLimit.windowMs
          );

          if (!rateLimitResult.allowed) {
            const retryAfterMs = rateLimitResult.resetAt - Date.now();
            return buildErrorResponse(
              new RateLimitError("Rate limit exceeded", retryAfterMs),
              corsHeaders,
              { version, includeTransitional: useTransitional, retryAfterMs }
            );
          }
        }
      }

      // Check custom rate limit if configured
      if (checkRateLimit) {
        const rateLimitResponse = await checkRateLimit(handlerContext);
        if (rateLimitResponse) {
          return rateLimitResponse;
        }
      }

      // Execute handler
      const response = await routeConfig.handler(handlerContext);

      // Store idempotency key for successful mutation responses
      if (
        idempotencyKey &&
        routeConfig.idempotent &&
        response.ok &&
        ["POST", "PUT", "PATCH"].includes(method)
      ) {
        try {
          const responseClone = response.clone();
          const responseData = await responseClone.json();
          await storeIdempotencyKey(
            supabase,
            idempotencyKey,
            `${service}:${method}`,
            responseData.data
          );
        } catch {
          // Non-critical, log and continue
          logger.warn("Failed to store idempotency key", { idempotencyKey });
        }
      }

      // Add version header
      if (!response.headers.has("X-API-Version")) {
        response.headers.set("X-API-Version", version);
      }

      // Add deprecation headers if this version is deprecated
      if (deprecationInfo) {
        response.headers.set("Deprecation", "true");
        response.headers.set("Sunset", deprecationInfo.sunsetDate);
        response.headers.set("X-Deprecation-Warning", deprecationInfo.message);
        logger.warn("Deprecated API version used", {
          version: deprecationInfo.version,
          sunsetDate: deprecationInfo.sunsetDate,
        });
      }

      perfTracker.end(response.status);
      return response;
    } catch (error) {
      const appError = error instanceof Error ? error : new Error(String(error));

      // Handle CSRF errors with 403 status
      if (error instanceof CsrfError) {
        perfTracker.end(403);
        return buildErrorResponse(
          new AppError(error.message, "CSRF_VALIDATION_FAILED", 403),
          corsHeaders,
          { version, includeTransitional: useTransitional }
        );
      }

      // Track error for monitoring
      trackError(appError, {
        service,
        method: request.method,
        url: request.url,
      });

      const statusCode = error instanceof AppError ? error.statusCode : 500;
      perfTracker.end(statusCode);

      return buildErrorResponse(
        appError,
        corsHeaders,
        { version, includeTransitional: useTransitional }
      );
    } finally {
      clearContext();
    }
  };
}

// =============================================================================
// Response Helpers for Handlers
// =============================================================================

/**
 * Create a success response from a handler
 */
export function ok<T>(
  data: T,
  ctx: HandlerContext,
  statusOrOptions?: number | { status?: number; cacheTTL?: number; uiHints?: Record<string, unknown> }
): Response {
  const options = typeof statusOrOptions === "number"
    ? { status: statusOrOptions }
    : statusOrOptions || {};
  return buildSuccessResponse(data, ctx.corsHeaders, {
    status: options.status || 200,
    cacheTTL: options.cacheTTL,
    uiHints: options.uiHints as UIHints | undefined,
  });
}

/**
 * Create a created response (201)
 */
export function created<T>(data: T, ctx: HandlerContext): Response {
  return buildSuccessResponse(data, ctx.corsHeaders, { status: 201 });
}

/**
 * Create a no content response (204)
 */
export function noContent(ctx: HandlerContext): Response {
  return new Response(null, {
    status: 204,
    headers: ctx.corsHeaders,
  });
}

/**
 * Create a paginated response
 */
export function paginated<T>(
  items: T[],
  ctx: HandlerContext,
  pagination: {
    offset: number;
    limit: number;
    total: number;
    /** Next cursor for cursor-based pagination */
    nextCursor?: string | null;
  }
): Response {
  // Support both offset-based and cursor-based pagination
  const hasMore = pagination.nextCursor !== undefined
    ? pagination.nextCursor !== null
    : pagination.offset + items.length < pagination.total;

  return buildSuccessResponse(items, ctx.corsHeaders, {
    pagination: {
      offset: pagination.offset,
      limit: pagination.limit,
      total: pagination.total,
      hasMore,
      nextOffset: hasMore && pagination.nextCursor === undefined
        ? pagination.offset + pagination.limit
        : undefined,
      nextCursor: pagination.nextCursor ?? undefined,
    },
  });
}

// =============================================================================
// Version Negotiation Helper
// =============================================================================

/**
 * Get requested API version from Accept header or query param
 */
export function getRequestedVersion(request: Request): string {
  // Check Accept header: application/vnd.foodshare.v2+json
  const accept = request.headers.get("accept") || "";
  const versionMatch = accept.match(/vnd\.foodshare\.v(\d+)/);
  if (versionMatch) {
    return versionMatch[1];
  }

  // Check query param: ?version=2
  const url = new URL(request.url);
  const queryVersion = url.searchParams.get("version");
  if (queryVersion) {
    return queryVersion;
  }

  // Default to v1
  return "1";
}
