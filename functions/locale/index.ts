/**
 * Locale Edge Function - User Locale Preference Management
 *
 * Lightweight Edge Function for managing user locale preferences in Redis.
 * Separated from the main localization function for:
 * - Faster cold starts (minimal dependencies)
 * - Direct database trigger calls
 * - Clear separation of concerns
 *
 * Routes:
 * - POST /locale/sync-to-redis → Sync locale preference to Redis cache
 *
 * Features:
 * - O(1) Redis cache updates
 * - Called by database trigger on profile.preferred_locale changes
 * - Service role authentication for database trigger calls
 */

import { getCorsHeaders } from "../_shared/cors.ts";

// Import handlers
import syncToRedisHandler from "./handlers/sync-to-redis.ts";

/**
 * Extract subpath from URL
 * /locale → ""
 * /locale/sync-to-redis → "sync-to-redis"
 */
function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const locIndex = pathname.indexOf("/locale");
  if (locIndex === -1) return "";
  const subPath = pathname.slice(locIndex + 7); // "/locale" = 7 chars
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const subPath = getSubPath(url);

  console.log("Locale routing", { subPath, method: req.method });

  try {
    switch (subPath) {
      case "sync-to-redis":
      case "sync-to-redis/":
        // POST /locale/sync-to-redis → Sync locale preference to Redis
        return syncToRedisHandler(req);

      case "":
      case "/":
        // Root endpoint - return service info
        return new Response(JSON.stringify({
          success: true,
          service: "locale",
          version: "1.0.0",
          endpoints: [
            { path: "/locale/sync-to-redis", method: "POST", description: "Sync locale preference to Redis cache" },
          ],
          description: "User locale preference management for cross-device sync",
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      default:
        return new Response(JSON.stringify({
          success: false,
          error: { code: "NOT_FOUND", message: `Endpoint not found: ${subPath}` },
        }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (error) {
    console.error("Locale error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: { code: "INTERNAL_ERROR", message: (error as Error).message },
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
