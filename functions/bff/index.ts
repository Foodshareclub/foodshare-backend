/**
 * BFF (Backend for Frontend) Edge Function
 *
 * Unified BFF layer that aggregates data for cross-platform clients.
 * Reduces round-trips by combining multiple data sources into single responses.
 *
 * Endpoints:
 * - GET /bff/feed     - Aggregated home feed (listings + counts)
 * - GET /bff/dashboard - User dashboard (profile + stats + activity)
 * - GET /bff/translations - Localized translations
 *
 * Features:
 * - Platform-aware response shaping (iOS/Android/Web)
 * - Single RPC calls for aggregated data
 * - Rate limiting per endpoint
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { getCorsHeadersWithMobile } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

// Import handlers
import translationsHandler from "./handlers/translations.ts";

// =============================================================================
// Route Detection
// =============================================================================

function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const bffIndex = pathname.indexOf("/bff");
  if (bffIndex === -1) return "";
  const subPath = pathname.slice(bffIndex + 4);
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeadersWithMobile(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const subPath = getSubPath(url);

  logger.debug("BFF routing", { subPath, method: req.method });

  try {
    switch (subPath) {
      case "translations":
      case "translations/":
        return translationsHandler(req);

      case "":
      case "/":
        return new Response(JSON.stringify({
          success: true,
          service: "bff",
          version: "2.0.0",
          endpoints: [
            { path: "/bff/translations", method: "GET", description: "Localized translations" },
          ],
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
    logger.error("BFF error", { error: (error as Error).message, subPath });
    return new Response(JSON.stringify({
      success: false,
      error: { code: "INTERNAL_ERROR", message: (error as Error).message },
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
