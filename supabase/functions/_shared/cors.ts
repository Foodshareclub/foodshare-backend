// cors.ts - Enhanced CORS configuration with origin validation

/**
 * Default allowed origins for production
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
