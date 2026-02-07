/**
 * Enhanced CORS Configuration
 *
 * Provides secure CORS handling with:
 * - Origin validation for web apps
 * - Mobile app origin handling (Capacitor, native WebViews)
 * - Null origin support for native mobile apps
 * - Consistent headers across all functions
 */

/**
 * Default allowed origins for web production
 * Override by passing custom origins to getCorsHeaders()
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
 * Legacy wildcard CORS headers (less secure)
 * @deprecated Use getCorsHeaders() instead for better security
 */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Get CORS headers with origin validation
 * @param request - The incoming request
 * @param allowedOrigins - Optional array of allowed origins (defaults to DEFAULT_ALLOWED_ORIGINS)
 * @param allowCredentials - Whether to allow credentials (default: true)
 */
export function getCorsHeaders(
  request: Request,
  allowedOrigins: string[] = DEFAULT_ALLOWED_ORIGINS,
  allowCredentials: boolean = true
): Record<string, string> {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "3600",
  };

  if (allowCredentials) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

/**
 * Get permissive CORS headers (allows all origins)
 * Use only for public APIs that don't handle sensitive data
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
 * Handle OPTIONS preflight request
 * @param request - The incoming request
 * @param allowedOrigins - Optional array of allowed origins
 */
export function handleCorsPrelight(request: Request, allowedOrigins?: string[]): Response {
  const headers = allowedOrigins
    ? getCorsHeaders(request, allowedOrigins)
    : getPermissiveCorsHeaders();

  return new Response("ok", { headers, status: 204 });
}

/**
 * Handle OPTIONS preflight for mobile-aware endpoints
 */
export function handleMobileCorsPrelight(
  request: Request,
  additionalOrigins?: string[]
): Response {
  return new Response("ok", {
    headers: getCorsHeadersWithMobile(request, additionalOrigins),
    status: 204,
  });
}

/**
 * Get CORS headers that also support mobile app origins
 *
 * Use this for functions that serve both web and mobile clients.
 * Handles:
 * - Standard web origins (validated against allowlist)
 * - Mobile origins (capacitor://, ionic://, file://)
 * - Null origins (native iOS apps)
 *
 * @param request - The incoming request
 * @param additionalOrigins - Extra origins to allow beyond defaults
 */
export function getCorsHeadersWithMobile(
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

  // Check if origin matches any allowed pattern
  // SECURITY: Use exact hostname matching for mobile schemes to prevent bypasses
  // like capacitor://localhost.attacker.com
  let allowedOrigin = allAllowed.find((allowed) => {
    if (allowed.endsWith("//")) {
      // Handle scheme-only patterns like "file://"
      return origin.startsWith(allowed);
    }
    // For mobile schemes (capacitor://, ionic://, app://), use exact match only
    // to prevent subdomain/hostname manipulation attacks
    if (allowed.startsWith("capacitor://") || allowed.startsWith("ionic://") || allowed.startsWith("app://")) {
      return origin === allowed;
    }
    return origin === allowed;
  });

  // Fall back to production origin if no match
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
 * Check if the request origin is from a mobile app
 * SECURITY: Uses exact matching for mobile schemes to prevent hostname manipulation
 */
export function isMobileOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  // Native apps often send null origin
  if (!origin || origin === "null") {
    return true;
  }

  return MOBILE_ORIGINS.some((mobileOrigin) => {
    if (mobileOrigin.endsWith("//")) {
      // Scheme-only patterns like "file://" - use prefix match
      return origin.startsWith(mobileOrigin);
    }
    // All other mobile origins use exact match to prevent bypasses
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

  // No origin header - could be server-to-server or mobile
  if (!origin || origin === "null") {
    return allowMobile;
  }

  // Check web origins
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check mobile origins
  // SECURITY: Uses exact matching for mobile schemes to prevent hostname manipulation
  if (allowMobile) {
    return MOBILE_ORIGINS.some((mobileOrigin) => {
      if (mobileOrigin.endsWith("//")) {
        // Scheme-only patterns like "file://" - use prefix match
        return origin.startsWith(mobileOrigin);
      }
      // All other mobile origins use exact match to prevent bypasses
      return origin === mobileOrigin;
    });
  }

  return false;
}
