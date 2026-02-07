/**
 * Request Context and Distributed Tracing
 *
 * Provides request-scoped context that flows through the entire request lifecycle.
 * Used for:
 * - Request ID tracking
 * - Correlation ID for distributed tracing
 * - Performance timing
 * - User/platform identification
 */

/**
 * Context available throughout a request lifecycle
 */
export interface RequestContext {
  /** Unique identifier for this request */
  requestId: string;
  /** Correlation ID for tracing across services (from header or generated) */
  correlationId: string;
  /** Request start time (performance.now()) */
  startTime: number;
  /** Request start timestamp (Date) */
  startTimestamp: Date;
  /** Authenticated user ID (set after auth) */
  userId?: string;
  /** Client platform (ios, android, web) */
  platform?: "ios" | "android" | "web" | "unknown";
  /** Client app version */
  appVersion?: string;
  /** Function/service name */
  service?: string;
  /** Additional context data */
  metadata: Record<string, unknown>;
}

// Store context for the current request
// Note: Deno edge functions are single-threaded per request, so this is safe
let currentContext: RequestContext | null = null;

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `req_${timestamp}_${random}`;
}

/**
 * Detect platform from User-Agent or custom header
 */
function detectPlatform(request: Request): "ios" | "android" | "web" | "unknown" {
  // Check custom header first
  const clientPlatform = request.headers.get("x-client-platform")?.toLowerCase();
  if (clientPlatform === "ios" || clientPlatform === "android" || clientPlatform === "web") {
    return clientPlatform;
  }

  // Fall back to User-Agent detection
  const userAgent = request.headers.get("user-agent")?.toLowerCase() || "";

  if (userAgent.includes("foodshare") && userAgent.includes("ios")) return "ios";
  if (userAgent.includes("foodshare") && userAgent.includes("android")) return "android";
  if (userAgent.includes("iphone") || userAgent.includes("ipad")) return "ios";
  if (userAgent.includes("android")) return "android";
  if (userAgent.includes("mozilla") || userAgent.includes("chrome") || userAgent.includes("safari")) {
    return "web";
  }

  return "unknown";
}

/**
 * Create a new request context from an incoming request
 *
 * @example
 * ```typescript
 * Deno.serve(async (req) => {
 *   const ctx = createContext(req, "my-function");
 *   // ctx is now available throughout the request
 * });
 * ```
 */
export function createContext(request: Request, service?: string): RequestContext {
  const correlationId =
    request.headers.get("x-correlation-id") ||
    request.headers.get("x-request-id") ||
    generateRequestId();

  const context: RequestContext = {
    requestId: generateRequestId(),
    correlationId,
    startTime: performance.now(),
    startTimestamp: new Date(),
    platform: detectPlatform(request),
    appVersion: request.headers.get("x-app-version") || undefined,
    service,
    metadata: {},
  };

  currentContext = context;
  return context;
}

/**
 * Get the current request context
 * Returns null if no context has been created for this request
 */
export function getContext(): RequestContext | null {
  return currentContext;
}

/**
 * Get context or throw if not available
 */
export function requireContext(): RequestContext {
  if (!currentContext) {
    throw new Error("Request context not initialized. Call createContext first.");
  }
  return currentContext;
}

/**
 * Update the current context with new values
 */
export function updateContext(updates: Partial<Omit<RequestContext, "requestId" | "startTime">>): void {
  if (!currentContext) {
    throw new Error("Request context not initialized. Call createContext first.");
  }

  if (updates.userId !== undefined) currentContext.userId = updates.userId;
  if (updates.platform !== undefined) currentContext.platform = updates.platform;
  if (updates.appVersion !== undefined) currentContext.appVersion = updates.appVersion;
  if (updates.service !== undefined) currentContext.service = updates.service;
  if (updates.metadata) {
    currentContext.metadata = { ...currentContext.metadata, ...updates.metadata };
  }
}

/**
 * Set the authenticated user ID in context
 */
export function setUserId(userId: string): void {
  if (currentContext) {
    currentContext.userId = userId;
  }
}

/**
 * Add metadata to the current context
 */
export function addMetadata(key: string, value: unknown): void {
  if (currentContext) {
    currentContext.metadata[key] = value;
  }
}

/**
 * Get elapsed time since request start in milliseconds
 */
export function getElapsedMs(): number {
  if (!currentContext) return 0;
  return Math.round(performance.now() - currentContext.startTime);
}

/**
 * Clear the current context (call at end of request)
 */
export function clearContext(): void {
  currentContext = null;
}

/**
 * Execute a function with a specific context
 * Useful for background tasks or async operations
 */
export async function withContext<T>(
  context: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  const previousContext = currentContext;
  currentContext = context;

  try {
    return await fn();
  } finally {
    currentContext = previousContext;
  }
}

/**
 * Get headers to propagate context to downstream services
 */
export function getContextHeaders(): Record<string, string> {
  const ctx = currentContext;
  if (!ctx) return {};

  const headers: Record<string, string> = {
    "X-Request-Id": ctx.requestId,
    "X-Correlation-Id": ctx.correlationId,
  };

  if (ctx.platform) headers["X-Client-Platform"] = ctx.platform;
  if (ctx.appVersion) headers["X-App-Version"] = ctx.appVersion;
  if (ctx.userId) headers["X-User-Id"] = ctx.userId;

  return headers;
}

/**
 * Get standard response headers including context
 */
export function getResponseHeaders(
  additionalHeaders?: Record<string, string>
): Record<string, string> {
  const ctx = currentContext;

  return {
    "Content-Type": "application/json",
    ...(ctx && {
      "X-Request-Id": ctx.requestId,
      "X-Correlation-Id": ctx.correlationId,
      "X-Response-Time": `${getElapsedMs()}ms`,
    }),
    ...additionalHeaders,
  };
}

/**
 * Create a summary object for logging
 */
export function getContextSummary(): Record<string, unknown> {
  const ctx = currentContext;
  if (!ctx) return {};

  return {
    requestId: ctx.requestId,
    correlationId: ctx.correlationId,
    userId: ctx.userId,
    platform: ctx.platform,
    service: ctx.service,
    durationMs: getElapsedMs(),
  };
}

/**
 * Middleware-style wrapper that creates context and cleans up
 *
 * @example
 * ```typescript
 * Deno.serve(handleWithContext("my-function", async (req, ctx) => {
 *   // ctx is automatically created and cleaned up
 *   return new Response(JSON.stringify({ requestId: ctx.requestId }));
 * }));
 * ```
 */
export function handleWithContext(
  service: string,
  handler: (request: Request, context: RequestContext) => Promise<Response>
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const ctx = createContext(request, service);

    try {
      return await handler(request, ctx);
    } finally {
      clearContext();
    }
  };
}
