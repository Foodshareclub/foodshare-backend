/**
 * Response Adapter
 *
 * Unified response format for all Edge Functions:
 * { success, data, meta: { requestId, timestamp, responseTime }, pagination, uiHints }
 *
 * Platform-aware optimizations for iOS, Android, and Web clients.
 *
 * @module response-adapter
 */

import { getContext, getElapsedMs } from "./context.ts";
import { logger } from "./logger.ts";
import type { AppError } from "./errors.ts";

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
  /** Next cursor for cursor-based pagination */
  nextCursor?: string;
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
// Response Builders
// =============================================================================

/**
 * Build a unified success response
 */
export function buildSuccessResponse<T>(
  data: T,
  corsHeaders: Record<string, string>,
  options?: {
    status?: number;
    pagination?: Pagination;
    uiHints?: UIHints;
    cacheTTL?: number;
    version?: string;
  },
): Response {
  const ctx = getContext();

  const response: APIResponse<T> = {
    success: true,
    data,
    meta: {
      requestId: ctx?.requestId || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      responseTime: ctx ? getElapsedMs() : 0,
      cacheTTL: options?.cacheTTL,
      version: options?.version,
    },
    pagination: options?.pagination,
    uiHints: options?.uiHints,
  };

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };

  if (ctx?.requestId) {
    headers["X-Request-Id"] = ctx.requestId;
  }

  if (options?.version) {
    headers["X-API-Version"] = options.version;
  }

  if (options?.cacheTTL) {
    headers["Cache-Control"] = `public, max-age=${options.cacheTTL}`;
  }

  logger.debug("Building success response", {
    hasData: !!data,
    hasPagination: !!options?.pagination,
    hasUIHints: !!options?.uiHints,
  });

  return new Response(JSON.stringify(response), {
    status: options?.status || 200,
    headers,
  });
}

/**
 * Build a unified error response
 *
 * In production, strips `details` from non-validation errors to prevent
 * internal field name leakage. Keeps `details` for VALIDATION_ERROR since
 * clients need field-level error info.
 */
export function buildErrorResponse(
  error: AppError | Error | { code: string; message: string; details?: unknown },
  corsHeaders: Record<string, string>,
  options?: {
    status?: number;
    version?: string;
    retryAfterMs?: number;
  },
): Response {
  const ctx = getContext();
  const isProduction = Deno.env.get("ENVIRONMENT") === "production";

  // Determine status code
  let statusCode = options?.status || 500;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    statusCode = error.statusCode;
  }

  // Build error body
  let errorBody: APIError;
  if ("code" in error && typeof error.code === "string") {
    const rawDetails = "details" in error ? error.details : undefined;
    // In production, only expose details for validation errors
    const details = isProduction && error.code !== "VALIDATION_ERROR"
      ? undefined
      : rawDetails;

    errorBody = {
      code: error.code,
      message: error.message,
      details,
    };
  } else {
    errorBody = {
      code: "INTERNAL_ERROR",
      message: isProduction ? "Internal server error" : error.message,
    };
  }

  const response: APIResponse<never> = {
    success: false,
    error: errorBody,
    meta: {
      requestId: ctx?.requestId || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      responseTime: ctx ? getElapsedMs() : 0,
      version: options?.version,
    },
  };

  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };

  if (ctx?.requestId) {
    headers["X-Request-Id"] = ctx.requestId;
  }

  if (options?.retryAfterMs) {
    headers["Retry-After"] = String(Math.ceil(options.retryAfterMs / 1000));
  }

  // Log the error
  logger.error("Request failed", error instanceof Error ? error : new Error(String(error)), {
    statusCode,
    errorCode: "code" in error ? error.code : "INTERNAL_ERROR",
  });

  return new Response(JSON.stringify(response), {
    status: statusCode,
    headers,
  });
}

// =============================================================================
// Platform-Specific Response Optimization
// =============================================================================

export type Platform = "ios" | "android" | "web" | "unknown";

/**
 * Platform-specific UI hints
 */
export const PLATFORM_UI_HINTS: Record<Platform, Partial<UIHints>> = {
  ios: {
    refreshAfter: 300, // 5 minutes - ProMotion-aware
    displayMode: "list",
    pullToRefresh: true,
  },
  android: {
    refreshAfter: 300,
    displayMode: "list",
    pullToRefresh: true,
  },
  web: {
    refreshAfter: 600, // 10 minutes - longer for web
    displayMode: "grid",
    pullToRefresh: false,
  },
  unknown: {
    refreshAfter: 300,
    displayMode: "list",
    pullToRefresh: true,
  },
};

/**
 * Detect platform from request
 */
export function detectPlatform(request: Request): Platform {
  // Check explicit header first
  const platformHeader = request.headers.get("X-Client-Platform")?.toLowerCase();
  if (platformHeader === "ios" || platformHeader === "android" || platformHeader === "web") {
    return platformHeader;
  }

  // Detect from User-Agent
  const ua = request.headers.get("User-Agent") || "";

  // iOS detection (check specific iOS markers)
  if (ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iOS") || ua.includes("Darwin")) {
    return "ios";
  }

  // Android detection
  if (ua.includes("Android")) {
    return "android";
  }

  // Web detection (browsers)
  if (
    ua.includes("Mozilla") ||
    ua.includes("Chrome") ||
    ua.includes("Safari") ||
    ua.includes("Firefox") ||
    ua.includes("Edge")
  ) {
    return "web";
  }

  return "unknown";
}

/**
 * Get platform-aware UI hints
 */
export function getPlatformUIHints(
  platform: Platform,
  customHints?: Partial<UIHints>,
): UIHints {
  const baseHints = PLATFORM_UI_HINTS[platform] || PLATFORM_UI_HINTS.unknown;
  return {
    ...baseHints,
    ...customHints,
  } as UIHints;
}

/**
 * Platform-specific response transformation options
 */
export interface PlatformOptimizationOptions {
  /** Minimize payload for bandwidth-constrained mobile */
  minimizePayload?: boolean;
  /** Include ProMotion hints for iOS */
  proMotionHints?: boolean;
  /** Include SEO-friendly URLs for web */
  includeCanonicalUrls?: boolean;
  /** Base URL for canonical URLs */
  baseUrl?: string;
}

/**
 * Apply platform-specific optimizations to response data
 */
export function applyPlatformOptimizations<T extends Record<string, unknown>>(
  data: T,
  platform: Platform,
  options?: PlatformOptimizationOptions,
): T & { _platformHints?: Record<string, unknown> } {
  const result = { ...data } as T & { _platformHints?: Record<string, unknown> };

  switch (platform) {
    case "ios": {
      if (options?.proMotionHints) {
        result._platformHints = {
          ...result._platformHints,
          preferredFPS: 120,
          supportsProMotion: true,
          animationPreferences: {
            springDamping: 0.8,
            springResponse: 0.3,
          },
        };
      }
      break;
    }

    case "android": {
      if (options?.minimizePayload) {
        for (const key of Object.keys(result)) {
          if (result[key] === null || result[key] === undefined) {
            delete result[key];
          }
        }
        result._platformHints = {
          ...result._platformHints,
          materialDesign: true,
          useDataMessages: true,
        };
      }
      break;
    }

    case "web": {
      if (options?.includeCanonicalUrls && options?.baseUrl) {
        result._platformHints = {
          ...result._platformHints,
          seoMode: true,
          baseUrl: options.baseUrl,
        };

        if ("id" in data && typeof data.id === "string") {
          (result as Record<string, unknown>).canonicalUrl = `${options.baseUrl}/${data.id}`;
        }
      }
      break;
    }
  }

  return result;
}

/**
 * Build platform-optimized response
 */
export function buildPlatformOptimizedResponse<T>(
  request: Request,
  data: T,
  corsHeaders: Record<string, string>,
  options?: {
    status?: number;
    pagination?: Pagination;
    cacheTTL?: number;
    version?: string;
    platformOptions?: PlatformOptimizationOptions;
  },
): Response {
  const platform = detectPlatform(request);
  const platformUIHints = getPlatformUIHints(
    platform,
    options?.pagination ? { showEmptyState: true } : undefined,
  );

  // Apply platform-specific data transformations if data is an object
  let optimizedData = data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    optimizedData = applyPlatformOptimizations(
      data as unknown as Record<string, unknown>,
      platform,
      {
        proMotionHints: platform === "ios",
        minimizePayload: platform === "android",
        includeCanonicalUrls: platform === "web",
        baseUrl: "https://foodshare.app",
        ...options?.platformOptions,
      },
    ) as unknown as T;
  }

  return buildSuccessResponse(optimizedData, corsHeaders, {
    status: options?.status,
    pagination: options?.pagination,
    uiHints: platformUIHints,
    cacheTTL: options?.cacheTTL,
    version: options?.version,
  });
}

/**
 * Create deep link URLs for all platforms
 */
export function createDeepLinks(
  entityType: "listing" | "profile" | "chat" | "notification",
  entityId: string,
  baseWebUrl: string = "https://foodshare.app",
): Record<Platform, string> {
  const paths: Record<typeof entityType, string> = {
    listing: "listing",
    profile: "profile",
    chat: "chat",
    notification: "notifications",
  };

  const path = paths[entityType];

  return {
    ios: `foodshare://${path}/${entityId}`,
    android: `foodshare://${path}/${entityId}`,
    web: `${baseWebUrl}/${path}/${entityId}`,
    unknown: `${baseWebUrl}/${path}/${entityId}`,
  };
}
