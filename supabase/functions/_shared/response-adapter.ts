/**
 * Response Adapter
 *
 * Provides bidirectional conversion between response formats:
 * - Legacy format (errors.ts): { success, data, requestId, timestamp, durationMs }
 * - Unified format (response.ts): { success, data, meta: { requestId, timestamp, responseTime }, pagination, uiHints }
 *
 * Enables gradual migration with feature flag support and backward compatibility.
 *
 * @module response-adapter
 */

import { getContext, getElapsedMs } from "./context.ts";
import { logger } from "./logger.ts";
import type { AppError } from "./errors.ts";

// =============================================================================
// Types (previously in response.ts)
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
// Feature Flag
// =============================================================================

/**
 * Check if unified response format is enabled
 * Controlled by USE_UNIFIED_RESPONSE environment variable
 */
export function isUnifiedResponseEnabled(): boolean {
  return Deno.env.get("USE_UNIFIED_RESPONSE") === "true";
}

// =============================================================================
// Types
// =============================================================================

/** Legacy response format from errors.ts */
export interface LegacySuccessResponse<T = unknown> {
  success: true;
  data: T;
  requestId?: string;
  correlationId?: string;
  timestamp: string;
  durationMs?: number;
}

/** Legacy error response format from errors.ts */
export interface LegacyErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
  requestId?: string;
  correlationId?: string;
  timestamp: string;
  durationMs?: number;
}

/** Combined legacy response type */
export type LegacyResponse<T = unknown> = LegacySuccessResponse<T> | LegacyErrorResponse;

/** Unified response format from response.ts (target format) */
export type UnifiedResponse<T = unknown> = APIResponse<T>;

/** Adapter response that includes both formats for transition period */
export interface TransitionalResponse<T = unknown> {
  // Unified format fields
  success: boolean;
  data?: T;
  error?: APIError;
  meta: ResponseMeta;
  pagination?: Pagination;
  uiHints?: UIHints;

  // Legacy format fields (for backward compatibility during transition)
  requestId?: string; // Duplicate of meta.requestId
  timestamp?: string; // Duplicate of meta.timestamp
  durationMs?: number; // Duplicate of meta.responseTime
  correlationId?: string; // Legacy field
}

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Convert legacy success response to unified format
 */
export function legacyToUnified<T>(legacy: LegacySuccessResponse<T>): UnifiedResponse<T> {
  return {
    success: true,
    data: legacy.data,
    meta: {
      requestId: legacy.requestId || crypto.randomUUID(),
      timestamp: legacy.timestamp,
      responseTime: legacy.durationMs || 0,
    },
  };
}

/**
 * Convert legacy error response to unified format
 */
export function legacyErrorToUnified(legacy: LegacyErrorResponse): UnifiedResponse<never> {
  return {
    success: false,
    error: {
      code: legacy.error.code,
      message: legacy.error.message,
      details: legacy.error.details,
    },
    meta: {
      requestId: legacy.requestId || crypto.randomUUID(),
      timestamp: legacy.timestamp,
      responseTime: legacy.durationMs || 0,
    },
  };
}

/**
 * Convert unified response to legacy format (for legacy clients)
 */
export function unifiedToLegacy<T>(unified: UnifiedResponse<T>): LegacyResponse<T> {
  if (unified.success && unified.data !== undefined) {
    return {
      success: true,
      data: unified.data,
      requestId: unified.meta.requestId,
      timestamp: unified.meta.timestamp,
      durationMs: unified.meta.responseTime,
    };
  }

  return {
    success: false,
    error: unified.error || { code: "UNKNOWN_ERROR", message: "Unknown error" },
    requestId: unified.meta.requestId,
    timestamp: unified.meta.timestamp,
    durationMs: unified.meta.responseTime,
  };
}

/**
 * Create a transitional response with both formats
 * This allows legacy clients to continue working while new clients use unified format
 */
export function createTransitionalResponse<T>(
  data: T,
  options?: {
    pagination?: Pagination;
    uiHints?: UIHints;
    cacheTTL?: number;
    version?: string;
    correlationId?: string;
  },
): TransitionalResponse<T> {
  const ctx = getContext();
  const now = new Date().toISOString();
  const elapsed = ctx ? getElapsedMs() : 0;
  const requestId = ctx?.requestId || crypto.randomUUID();

  return {
    // Unified format (primary)
    success: true,
    data,
    meta: {
      requestId,
      timestamp: now,
      responseTime: elapsed,
      cacheTTL: options?.cacheTTL,
      version: options?.version,
    },
    pagination: options?.pagination,
    uiHints: options?.uiHints,

    // Legacy format (backward compatibility)
    requestId,
    timestamp: now,
    durationMs: elapsed,
    correlationId: options?.correlationId || ctx?.correlationId,
  };
}

/**
 * Create a transitional error response with both formats
 */
export function createTransitionalErrorResponse(
  error: AppError | Error | { code: string; message: string; details?: unknown },
  options?: {
    version?: string;
    correlationId?: string;
    retryable?: boolean;
    retryAfterMs?: number;
  },
): TransitionalResponse<never> {
  const ctx = getContext();
  const now = new Date().toISOString();
  const elapsed = ctx ? getElapsedMs() : 0;
  const requestId = ctx?.requestId || crypto.randomUUID();

  let errorBody: APIError;
  if ("code" in error && typeof error.code === "string") {
    errorBody = {
      code: error.code,
      message: error.message,
      details: "details" in error ? error.details : undefined,
    };
  } else {
    errorBody = {
      code: "INTERNAL_ERROR",
      message: error.message,
    };
  }

  return {
    // Unified format (primary)
    success: false,
    error: errorBody,
    meta: {
      requestId,
      timestamp: now,
      responseTime: elapsed,
      version: options?.version,
    },

    // Legacy format (backward compatibility)
    requestId,
    timestamp: now,
    durationMs: elapsed,
    correlationId: options?.correlationId || ctx?.correlationId,
  };
}

// =============================================================================
// Response Builders (Unified API)
// =============================================================================

/**
 * Build a unified success response with optional transitional fields
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
    includeTransitional?: boolean;
  },
): Response {
  const ctx = getContext();
  const useUnified = isUnifiedResponseEnabled();
  const includeTransitional = options?.includeTransitional ?? true; // Default to transitional during migration

  let response: UnifiedResponse<T> | TransitionalResponse<T>;

  if (useUnified && !includeTransitional) {
    // Pure unified format
    response = {
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
  } else {
    // Transitional format (includes both)
    response = createTransitionalResponse(data, options);
  }

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
    format: useUnified ? "unified" : "transitional",
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
 * Build a unified error response with optional transitional fields
 */
export function buildErrorResponse(
  error: AppError | Error | { code: string; message: string; details?: unknown },
  corsHeaders: Record<string, string>,
  options?: {
    status?: number;
    version?: string;
    includeTransitional?: boolean;
    retryAfterMs?: number;
  },
): Response {
  const ctx = getContext();
  const useUnified = isUnifiedResponseEnabled();
  const includeTransitional = options?.includeTransitional ?? true;

  // Determine status code
  let statusCode = options?.status || 500;
  if ("statusCode" in error && typeof error.statusCode === "number") {
    statusCode = error.statusCode;
  }

  let response: UnifiedResponse<never> | TransitionalResponse<never>;

  if (useUnified && !includeTransitional) {
    // Pure unified format
    let errorBody: APIError;
    if ("code" in error && typeof error.code === "string") {
      errorBody = {
        code: error.code,
        message: error.message,
        details: "details" in error ? error.details : undefined,
      };
    } else {
      errorBody = {
        code: "INTERNAL_ERROR",
        message: error.message,
      };
    }

    response = {
      success: false,
      error: errorBody,
      meta: {
        requestId: ctx?.requestId || crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        responseTime: ctx ? getElapsedMs() : 0,
        version: options?.version,
      },
    };
  } else {
    // Transitional format
    response = createTransitionalErrorResponse(error, {
      version: options?.version,
      retryAfterMs: options?.retryAfterMs,
    });
  }

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
// Client Detection
// =============================================================================

/**
 * Detect client type from request headers
 * Used to determine which response format to use
 */
export function detectClientType(request: Request): "legacy" | "unified" | "unknown" {
  const accept = request.headers.get("accept") || "";
  const clientVersion = request.headers.get("x-client-version") || "";

  // Check for explicit unified format request
  if (accept.includes("vnd.foodshare.v2")) {
    return "unified";
  }

  // Check for legacy format request
  if (accept.includes("vnd.foodshare.v1")) {
    return "legacy";
  }

  // Check client version header (newer clients use unified)
  if (clientVersion) {
    const version = parseFloat(clientVersion);
    if (!isNaN(version) && version >= 2.0) {
      return "unified";
    }
    if (!isNaN(version) && version < 2.0) {
      return "legacy";
    }
  }

  return "unknown";
}

/**
 * Get the appropriate response format for a client
 * Returns true if transitional format should be used (includes both)
 */
export function shouldUseTransitionalFormat(request: Request): boolean {
  const clientType = detectClientType(request);

  // Unknown clients get transitional format during migration
  if (clientType === "unknown") {
    return true;
  }

  // Legacy clients explicitly requesting v1 get transitional (includes their format)
  if (clientType === "legacy") {
    return true;
  }

  // Unified clients can get pure unified format
  return false;
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
    // iOS-specific: hint for ProMotion displays
  },
  android: {
    refreshAfter: 300,
    displayMode: "list",
    pullToRefresh: true,
    // Android-specific: Material Design preferences
  },
  web: {
    refreshAfter: 600, // 10 minutes - longer for web
    displayMode: "grid",
    pullToRefresh: false, // No pull-to-refresh on web
    // Web-specific: page-based pagination preferred
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
 *
 * @param data Original response data
 * @param platform Target platform
 * @param options Optimization options
 * @returns Optimized response data
 */
export function applyPlatformOptimizations<T extends Record<string, unknown>>(
  data: T,
  platform: Platform,
  options?: PlatformOptimizationOptions,
): T & { _platformHints?: Record<string, unknown> } {
  const result = { ...data } as T & { _platformHints?: Record<string, unknown> };

  switch (platform) {
    case "ios": {
      // iOS optimizations
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
      // Android optimizations - minimize payload for bandwidth
      if (options?.minimizePayload) {
        // Remove null/undefined values to reduce payload size
        for (const key of Object.keys(result)) {
          if (result[key] === null || result[key] === undefined) {
            delete result[key];
          }
        }
        result._platformHints = {
          ...result._platformHints,
          materialDesign: true,
          useDataMessages: true, // Prefer FCM data messages
        };
      }
      break;
    }

    case "web": {
      // Web optimizations - SEO and full URLs
      if (options?.includeCanonicalUrls && options?.baseUrl) {
        result._platformHints = {
          ...result._platformHints,
          seoMode: true,
          baseUrl: options.baseUrl,
        };

        // Add canonical URL if data has an ID
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
    includeTransitional?: boolean;
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
    includeTransitional: options?.includeTransitional,
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
