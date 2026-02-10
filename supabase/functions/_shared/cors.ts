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
 * - `getCorsHeaders(request, additionalOrigins?)` — origin-validated CORS for web + mobile
 * - `handleCorsPreflight(request, additionalOrigins?)` — OPTIONS handler
 *
 * Utility exports:
 * - `isMobileOrigin(request)` — check if request is from mobile app
 * - `isOriginAllowed(request)` — validate origin against allowlist
 * - `getPermissiveCorsHeaders()` — wildcard CORS for server-to-server endpoints
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
  "file://", // Android WebView
  "app://localhost", // Custom app scheme
];

/**
 * @deprecated Use `getCorsHeaders(request)` instead
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// =============================================================================
// Primary API
// =============================================================================

/**
 * Get CORS headers with origin validation for web + mobile clients.
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
  additionalOrigins: string[] = []
): Record<string, string> {
  const origin = request.headers.get("origin");
  const allAllowed = [...DEFAULT_ALLOWED_ORIGINS, ...MOBILE_ORIGINS, ...additionalOrigins];

  // Handle null origin (native mobile apps send this)
  if (!origin || origin === "null") {
    return {
      "Access-Control-Allow-Origin": DEFAULT_ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-correlation-id, x-request-id, x-client-platform, x-app-version",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "3600",
      "Access-Control-Expose-Headers": "x-request-id, x-correlation-id, x-response-time, retry-after",
    };
  }

  // SECURITY: Use exact hostname matching for mobile schemes to prevent bypasses
  // like capacitor://localhost.attacker.com
  let allowedOrigin = allAllowed.find((allowed) => {
    if (allowed.endsWith("//")) {
      return origin.startsWith(allowed);
    }
    if (allowed.startsWith("capacitor://") || allowed.startsWith("ionic://") || allowed.startsWith("app://")) {
      return origin === allowed;
    }
    return origin === allowed;
  });

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
    "Access-Control-Expose-Headers": "x-request-id, x-correlation-id, x-response-time, retry-after",
  };
}

/**
 * Handle OPTIONS preflight request (web + mobile aware)
 */
export function handleCorsPreflight(
  request: Request,
  additionalOrigins?: string[]
): Response {
  return new Response("ok", {
    headers: getCorsHeaders(request, additionalOrigins),
    status: 204,
  });
}

// =============================================================================
// Utility
// =============================================================================

/**
 * Get permissive CORS headers (allows all origins).
 * Use only for server-to-server endpoints (webhooks, cron triggers, health checks).
 * @deprecated Prefer `getCorsHeaders(request)` for client-facing endpoints
 */
export function getPermissiveCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "3600",
  };
}

/**
 * Check if the request origin is from a mobile app
 * SECURITY: Uses exact matching for mobile schemes to prevent hostname manipulation
 */
export function isMobileOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (!origin || origin === "null") {
    return true;
  }

  return MOBILE_ORIGINS.some((mobileOrigin) => {
    if (mobileOrigin.endsWith("//")) {
      return origin.startsWith(mobileOrigin);
    }
    return origin === mobileOrigin;
  });
}

/**
 * Validate that the origin is allowed
 * Returns true if origin is in the allowed list or is a mobile origin
 */
export function isOriginAllowed(
  request: Request,
  allowedOrigins: string[] = DEFAULT_ALLOWED_ORIGINS,
  allowMobile: boolean = true
): boolean {
  const origin = request.headers.get("origin");

  if (!origin || origin === "null") {
    return allowMobile;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  if (allowMobile) {
    return MOBILE_ORIGINS.some((mobileOrigin) => {
      if (mobileOrigin.endsWith("//")) {
        return origin.startsWith(mobileOrigin);
      }
      return origin === mobileOrigin;
    });
  }

  return false;
}

// =============================================================================
// Deprecated Aliases (kept for backward compatibility)
// =============================================================================

/**
 * @deprecated Use `getCorsHeaders(request, additionalOrigins)` — now the primary export
 */
export const getCorsHeadersWithMobile = getCorsHeaders;

/**
 * @deprecated Use `handleCorsPreflight(request, additionalOrigins)`
 */
export const handleMobileCorsPrelight = handleCorsPreflight;

/**
 * @deprecated Use `handleCorsPreflight(request)`
 */
export function handleCorsPrelight(request: Request, allowedOrigins?: string[]): Response {
  return handleCorsPreflight(request, allowedOrigins);
}
