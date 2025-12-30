/**
 * Unified Response Envelope
 *
 * Standardized response format for all Edge Functions.
 * Provides consistent structure for success/error responses with metadata.
 *
 * Response format:
 * {
 *   success: boolean,
 *   data?: T,
 *   error?: { code: string, message: string, details?: unknown },
 *   meta: {
 *     requestId: string,
 *     timestamp: string,
 *     responseTime: number,
 *     cacheTTL?: number
 *   },
 *   pagination?: { offset, limit, total, hasMore },
 *   uiHints?: { refreshAfter?, displayMode?, badges? }
 * }
 */

import { corsHeaders } from "./cors.ts";

// =============================================================================
// Types
// =============================================================================

export interface APIError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  responseTime: number;
  cacheTTL?: number;
  version?: string;
}

export interface Pagination {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface UIHints {
  refreshAfter?: number;
  displayMode?: "list" | "grid" | "map";
  badges?: Array<{ text: string; color: string; screen?: string }>;
  pullToRefresh?: boolean;
  showEmptyState?: boolean;
  emptyStateMessage?: string;
}

export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: APIError;
  meta: ResponseMeta;
  pagination?: Pagination;
  uiHints?: UIHints;
}

// =============================================================================
// Response Context
// =============================================================================

export interface ResponseContext {
  requestId: string;
  startTime: number;
  version?: string;
}

/**
 * Create a response context at the start of request handling
 */
export function createResponseContext(version?: string): ResponseContext {
  return {
    requestId: crypto.randomUUID(),
    startTime: performance.now(),
    version,
  };
}

// =============================================================================
// Success Response Builders
// =============================================================================

/**
 * Build a success response with data
 */
export function successResponse<T>(
  data: T,
  ctx: ResponseContext,
  options?: {
    pagination?: Pagination;
    uiHints?: UIHints;
    cacheTTL?: number;
    headers?: Record<string, string>;
    status?: number;
  }
): Response {
  const response: APIResponse<T> = {
    success: true,
    data,
    meta: {
      requestId: ctx.requestId,
      timestamp: new Date().toISOString(),
      responseTime: Math.round(performance.now() - ctx.startTime),
      cacheTTL: options?.cacheTTL,
      version: ctx.version,
    },
    pagination: options?.pagination,
    uiHints: options?.uiHints,
  };

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
    "X-Request-Id": ctx.requestId,
    ...(ctx.version && { "X-Version": ctx.version }),
    ...(options?.cacheTTL && {
      "Cache-Control": `public, max-age=${options.cacheTTL}`,
    }),
    ...options?.headers,
  };

  return new Response(JSON.stringify(response), {
    status: options?.status || 200,
    headers,
  });
}

/**
 * Build a paginated success response
 */
export function paginatedResponse<T>(
  items: T[],
  ctx: ResponseContext,
  pagination: Omit<Pagination, "hasMore"> & { hasMore?: boolean },
  options?: {
    uiHints?: UIHints;
    cacheTTL?: number;
    headers?: Record<string, string>;
  }
): Response {
  const fullPagination: Pagination = {
    ...pagination,
    hasMore: pagination.hasMore ?? (pagination.offset + items.length) < pagination.total,
    nextOffset:
      (pagination.offset + items.length) < pagination.total
        ? pagination.offset + pagination.limit
        : undefined,
  };

  return successResponse(
    items,
    ctx,
    {
      pagination: fullPagination,
      uiHints: options?.uiHints,
      cacheTTL: options?.cacheTTL,
      headers: options?.headers,
    }
  );
}

// =============================================================================
// Error Response Builders
// =============================================================================

/**
 * Build an error response
 */
export function errorResponse(
  error: APIError,
  ctx: ResponseContext,
  options?: {
    status?: number;
    headers?: Record<string, string>;
  }
): Response {
  const response: APIResponse = {
    success: false,
    error,
    meta: {
      requestId: ctx.requestId,
      timestamp: new Date().toISOString(),
      responseTime: Math.round(performance.now() - ctx.startTime),
      version: ctx.version,
    },
  };

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
    "X-Request-Id": ctx.requestId,
    ...(ctx.version && { "X-Version": ctx.version }),
    ...options?.headers,
  };

  return new Response(JSON.stringify(response), {
    status: options?.status || 500,
    headers,
  });
}

// =============================================================================
// Common Error Factories
// =============================================================================

export const Errors = {
  notFound: (resource: string): APIError => ({
    code: "NOT_FOUND",
    message: `${resource} not found`,
  }),

  unauthorized: (message = "Authentication required"): APIError => ({
    code: "UNAUTHORIZED",
    message,
  }),

  forbidden: (message = "Access denied"): APIError => ({
    code: "FORBIDDEN",
    message,
  }),

  badRequest: (message: string, details?: unknown): APIError => ({
    code: "BAD_REQUEST",
    message,
    details,
  }),

  validationFailed: (errors: Array<{ field: string; message: string }>): APIError => ({
    code: "VALIDATION_FAILED",
    message: "Validation failed",
    details: errors,
  }),

  rateLimited: (retryAfter: number): APIError => ({
    code: "RATE_LIMITED",
    message: "Too many requests",
    details: { retryAfter },
  }),

  serverError: (message = "Internal server error"): APIError => ({
    code: "SERVER_ERROR",
    message,
  }),

  serviceUnavailable: (service: string): APIError => ({
    code: "SERVICE_UNAVAILABLE",
    message: `${service} is temporarily unavailable`,
  }),

  methodNotAllowed: (allowed: string[]): APIError => ({
    code: "METHOD_NOT_ALLOWED",
    message: `Method not allowed. Use: ${allowed.join(", ")}`,
  }),
};

// =============================================================================
// Response Helpers with Custom CORS
// =============================================================================

/**
 * Build a success response with custom CORS headers
 */
export function successWithCors<T>(
  data: T,
  ctx: ResponseContext,
  customCorsHeaders: Record<string, string>,
  options?: {
    pagination?: Pagination;
    uiHints?: UIHints;
    cacheTTL?: number;
    status?: number;
  }
): Response {
  return successResponse(data, ctx, {
    ...options,
    headers: customCorsHeaders,
  });
}

/**
 * Build an error response with custom CORS headers
 */
export function errorWithCors(
  error: APIError,
  ctx: ResponseContext,
  customCorsHeaders: Record<string, string>,
  status = 500
): Response {
  return errorResponse(error, ctx, {
    status,
    headers: customCorsHeaders,
  });
}

// =============================================================================
// Display-Ready Data Formatters
// =============================================================================

export const Formatters = {
  /**
   * Format distance for display
   */
  distance(km: number): string {
    if (km < 1) {
      return `${Math.round(km * 1000)}m away`;
    }
    return `${km.toFixed(1)} km away`;
  },

  /**
   * Format rating for display
   */
  rating(average: number, count: number): string {
    if (count === 0) return "No ratings yet";
    return `${average.toFixed(1)} ★ (${count})`;
  },

  /**
   * Format relative time
   */
  relativeTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return "Today";
    if (diffHours < 48) return "Yesterday";
    if (diffDays < 7) return `${Math.floor(diffDays)} days ago`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  },

  /**
   * Format count with units
   */
  count(value: number, singular: string, plural?: string): string {
    const unit = value === 1 ? singular : (plural || `${singular}s`);
    return `${value} ${unit}`;
  },

  /**
   * Truncate text with ellipsis
   */
  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  },
};

// =============================================================================
// Legacy Default Export (backward compatibility)
// =============================================================================

/**
 * @deprecated Use successResponse or errorResponse instead
 */
const response = (body: unknown, statusCode: number): Response => {
  return new Response(
    JSON.stringify({
      body,
    }),
    {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
      status: statusCode,
    }
  );
};

export default response;
