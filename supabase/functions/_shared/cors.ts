/**
 * CORS Configuration
 *
 * Provides secure CORS handling with:
 * - Origin validation for web apps
 * - Mobile app origin handling (Capacitor, native WebViews)
 * - Null origin support for native mobile apps
 * - Consistent headers across all functions
 *
 * Primary exports:
 * - `getCorsHeaders(request, additionalOrigins?)` -- origin-validated CORS for web + mobile
 * - `handleCorsPreflight(request, additionalOrigins?)` -- OPTIONS handler
 *
 * Utility exports:
 * - `isMobileOrigin(request)` -- check if request is from mobile app
 * - `isOriginAllowed(request)` -- validate origin against allowlist
 */

/**
 * Default allowed origins for web production
 */
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://foodshare.app",
  "https://www.foodshare.app",
  "https://foodshare.club",
  "https://www.foodshare.club",
  "http://localhost:3000", // React dev
  "http://localhost:5173", // Vite dev
  "http://localhost:8000", // Alternative dev
];

/**
 * Mobile app origins
 * These are used by hybrid frameworks and native WebViews
 */
export const MOBILE_ORIGINS = [
  "capacitor://localhost", // Capacitor iOS/Android
  "ionic://localhost", // Ionic apps
  "http://localhost", // iOS WKWebView
  "file://", // Android WebView (exact match)
  "app://localhost", // Custom app scheme
];

// =============================================================================
// CORS Header Cache (memoized by origin + additionalOrigins)
// =============================================================================

const corsCache = new Map<string, Record<string, string>>();
const MAX_CORS_CACHE_SIZE = 50;

// =============================================================================
// Primary API
// =============================================================================

/**
 * Get CORS headers with origin validation for web + mobile clients.
 * Results are memoized by origin to avoid recomputation (~0.5-1ms per request).
 *
 * Handles:
 * - Standard web origins (validated against allowlist)
 * - Mobile origins (capacitor://, ionic://, file://)
 * - Null origins (native iOS apps)
 *
 * @param request - The incoming request
 * @param additionalOrigins - Extra origins to allow beyond defaults
 */
export function getCorsHeaders(
  request: Request,
  additionalOrigins: string[] = [],
): Record<string, string> {
  const origin = request.headers.get("origin") || "null";
  const cacheKey = `${origin}:${additionalOrigins.join(",")}`;

  const cached = corsCache.get(cacheKey);
  if (cached) return cached;

  const result = computeCorsHeaders(origin, additionalOrigins);

  // Evict oldest if cache is full
  if (corsCache.size >= MAX_CORS_CACHE_SIZE) {
    const firstKey = corsCache.keys().next().value;
    if (firstKey) corsCache.delete(firstKey);
  }
  corsCache.set(cacheKey, result);

  return result;
}

function computeCorsHeaders(
  origin: string,
  additionalOrigins: string[],
): Record<string, string> {
  const allAllowed = [...DEFAULT_ALLOWED_ORIGINS, ...MOBILE_ORIGINS, ...additionalOrigins];

  // Handle null origin (native mobile apps send this)
  if (origin === "null") {
    return {
      "Access-Control-Allow-Origin": DEFAULT_ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id, x-client-platform, x-app-version",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "3600",
      "Access-Control-Expose-Headers":
        "x-request-id, x-correlation-id, x-response-time, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
    };
  }

  // SECURITY: Use exact matching for all origins to prevent bypasses
  let allowedOrigin = allAllowed.find((allowed) => origin === allowed);

  if (!allowedOrigin) {
    allowedOrigin = DEFAULT_ALLOWED_ORIGINS[0];
  }

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id, x-client-platform, x-app-version",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "3600",
    "Access-Control-Expose-Headers":
      "x-request-id, x-correlation-id, x-response-time, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
  };
}

/**
 * Handle OPTIONS preflight request (web + mobile aware)
 */
export function handleCorsPreflight(
  request: Request,
  additionalOrigins?: string[],
): Response {
  return new Response(null, {
    headers: getCorsHeaders(request, additionalOrigins),
    status: 204,
  });
}

// =============================================================================
// Utility
// =============================================================================

/**
 * Check if the request origin is from a mobile app
 * SECURITY: Uses exact matching for all mobile schemes to prevent hostname manipulation
 */
export function isMobileOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (!origin || origin === "null") {
    return true;
  }

  return MOBILE_ORIGINS.some((mobileOrigin) => origin === mobileOrigin);
}

/**
 * Validate that the origin is allowed
 * Returns true if origin is in the allowed list or is a mobile origin
 */
export function isOriginAllowed(
  request: Request,
  allowedOrigins: string[] = DEFAULT_ALLOWED_ORIGINS,
  allowMobile: boolean = true,
): boolean {
  const origin = request.headers.get("origin");

  if (!origin || origin === "null") {
    return allowMobile;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (allowMobile) {
    return MOBILE_ORIGINS.some((mobileOrigin) => origin === mobileOrigin);
  }

  return false;
}
