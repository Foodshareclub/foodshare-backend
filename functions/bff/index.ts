/**
 * BFF (Backend for Frontend) Edge Function
 *
 * Unified BFF layer that aggregates data for cross-platform clients.
 * Reduces round-trips by combining multiple data sources into single responses.
 *
 * Endpoints:
 * - GET /bff/feed     - Aggregated home feed (listings + counts)
 * - GET /bff/dashboard - User dashboard (profile + stats + activity)
 *
 * Features:
 * - Platform-aware response shaping (iOS/Android/Web)
 * - Single RPC calls for aggregated data
 * - Consistent authentication via api-handler
 * - Rate limiting per endpoint
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { NotFoundError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// Import handlers
import feedHandler from "./handlers/feed.ts";
import dashboardHandler from "./handlers/dashboard.ts";
import messagesHandler from "./handlers/messages.ts";
import profileHandler from "./handlers/profile.ts";

// =============================================================================
// Route Detection
// =============================================================================

function getSubPath(url: URL): string {
  // Extract the path after /bff
  // URL might be: /bff, /bff/feed, /bff/dashboard
  const pathname = url.pathname;
  const bffIndex = pathname.indexOf("/bff");

  if (bffIndex === -1) {
    return "";
  }

  const subPath = pathname.slice(bffIndex + 4); // Remove "/bff"
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// =============================================================================
// Router Handler
// =============================================================================

async function routeRequest(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const subPath = getSubPath(url);

  logger.debug("BFF routing", { subPath, method: ctx.request.method });

  switch (subPath) {
    case "feed":
    case "feed/":
      // Delegate to feed handler
      return feedHandler(ctx.request);

    case "dashboard":
    case "dashboard/":
      // Delegate to dashboard handler
      return dashboardHandler(ctx.request);

    case "messages":
    case "messages/":
      // Delegate to messages handler
      return messagesHandler(ctx.request);

    case "profile":
    case "profile/":
      // Delegate to profile handler
      return profileHandler(ctx.request);

    case "":
    case "/":
      // Root BFF endpoint - return available endpoints
      return ok({
        service: "bff",
        version: "1.0.0",
        endpoints: [
          { path: "/bff/feed", method: "GET", description: "Aggregated home feed" },
          { path: "/bff/dashboard", method: "GET", description: "User dashboard" },
          { path: "/bff/messages", method: "GET", description: "Chat rooms with messages" },
          { path: "/bff/profile", method: "GET", description: "User profile with listings" },
        ],
      }, ctx);

    default:
      throw new NotFoundError("BFF endpoint", subPath);
  }
}

// =============================================================================
// Health Check Handler
// =============================================================================

async function handleHealth(ctx: HandlerContext): Promise<Response> {
  return ok({
    status: "healthy",
    service: "bff",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    endpoints: {
      feed: "available",
      dashboard: "available",
      messages: "available",
      profile: "available",
    },
  }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff",
  version: "1.0.0",
  requireAuth: false, // Auth checked per sub-handler
  routes: {
    GET: {
      handler: routeRequest,
    },
  },
});
