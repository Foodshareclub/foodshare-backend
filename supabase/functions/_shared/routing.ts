/**
 * Shared Route Parsing
 *
 * Extracts path segments from Edge Function URLs by stripping the
 * function name prefix and splitting on "/".
 *
 * @example
 * ```typescript
 * // URL: https://...supabase.co/functions/v1/api-v1-auth/rate/check
 * const route = parseRoute(url, "POST", "api-v1-auth");
 * // => { resource: "rate", segments: ["rate", "check"], method: "POST", subPath: "check" }
 * ```
 */

export interface ParsedRoute {
  /** First path segment (e.g. "rate", "users", "health") */
  resource: string;
  /** All path segments after the function name prefix */
  segments: string[];
  /** HTTP method (uppercase) */
  method: string;
  /** Second path segment, if any (e.g. "check", "batch") */
  subPath: string;
}

/**
 * Parse a route from an Edge Function URL.
 *
 * Strips the function name prefix, normalises slashes, and splits
 * into segments.
 *
 * @param url       - The request URL
 * @param method    - The HTTP method (GET, POST, etc.)
 * @param functionName - The Edge Function name (e.g. "api-v1-auth")
 */
export function parseRoute(
  url: URL,
  method: string,
  functionName: string,
): ParsedRoute {
  const path = url.pathname
    .replace(new RegExp(`^\\/${functionName}\\/?`), "")
    .replace(/^\/+/, "");

  const segments = path.split("/").filter(Boolean);
  const resource = segments[0] || "";
  const subPath = segments[1] || "";

  return { resource, segments, method: method.toUpperCase(), subPath };
}
