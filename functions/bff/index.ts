/**
 * BFF (Backend for Frontend) Edge Function
 *
 * Unified BFF layer that aggregates data for cross-platform clients.
 * Reduces round-trips by combining multiple data sources into single responses.
 *
 * Endpoints:
 * - GET /bff/feed     - Aggregated home feed (listings + counts)
 * - GET /bff/dashboard - User dashboard (profile + stats + activity)
 * - GET /bff/challenges - Challenges data
 * - GET /bff/profile - User profile data
 * - GET /bff/search - Search results
 * - GET /bff/notifications - User notifications
 * - GET /bff/messages - Chat messages
 * - GET /bff/listing/:id - Single listing details
 *
 * Features:
 * - Platform-aware response shaping (iOS/Android/Web)
 * - Single RPC calls for aggregated data
 * - Rate limiting per endpoint
 */

import { getCorsHeadersWithMobile } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

// Import handlers
import feedHandler from "./handlers/feed.ts";
import dashboardHandler from "./handlers/dashboard.ts";
import challengesHandler from "./handlers/challenges.ts";
import profileHandler from "./handlers/profile.ts";
import searchHandler from "./handlers/search.ts";
import notificationsHandler from "./handlers/notifications.ts";
import messagesHandler from "./handlers/messages.ts";
import listingDetailHandler from "./handlers/listing-detail.ts";
import sessionInfoHandler from "./handlers/session-info.ts";

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
      case "feed":
      case "feed/":
        return feedHandler(req);

      case "dashboard":
      case "dashboard/":
        return dashboardHandler(req);

      case "challenges":
      case "challenges/":
        return challengesHandler(req);

      case "profile":
      case "profile/":
        return profileHandler(req);

      case "search":
      case "search/":
        return searchHandler(req);

      case "notifications":
      case "notifications/":
        return notificationsHandler(req);

      case "messages":
      case "messages/":
        return messagesHandler(req);

      case "session-info":
      case "session-info/":
        return sessionInfoHandler(req);

      case "":
      case "/":
        return new Response(JSON.stringify({
          success: true,
          service: "bff",
          version: "2.0.0",
          endpoints: [
            { path: "/bff/feed", method: "GET", description: "Aggregated home feed" },
            { path: "/bff/dashboard", method: "GET", description: "User dashboard" },
            { path: "/bff/challenges", method: "GET", description: "Challenges data" },
            { path: "/bff/profile", method: "GET", description: "User profile" },
            { path: "/bff/search", method: "GET", description: "Search results" },
            { path: "/bff/notifications", method: "GET", description: "User notifications" },
            { path: "/bff/messages", method: "GET", description: "Chat messages" },
            { path: "/bff/session-info", method: "GET", description: "Session info with cached locale" },
          ],
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      default:
        // Check for listing detail route (e.g., /bff/listing/123)
        if (subPath.startsWith("listing/")) {
          return listingDetailHandler(req);
        }

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
