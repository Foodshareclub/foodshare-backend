/**
 * Unified Geocoding API v1
 *
 * Enterprise-grade geocoding API consolidating ALL geocoding operations:
 * - Profile/Address: Geocode user addresses and update coordinates
 * - Posts: Geocode post addresses and update locations
 * - Queue: Batch processing with queue management
 * - Signup Location: IP geolocation webhook for user signups
 *
 * Routes:
 * - GET    /health              - Health check
 * - POST   /address             - Geocode and update user address (replaces update-coordinates)
 * - POST   /post                - Geocode single post address
 * - POST   /post/batch          - Batch process posts from queue
 * - GET    /post/stats          - Get queue statistics
 * - POST   /post/cleanup        - Cleanup old queue entries
 * - POST   /geocode             - Geocode an address without updating DB
 * - POST   /signup-location     - Before User Created webhook (IP geolocation)
 * - GET    /signup-location     - Signup location health sub-check
 *
 * @module api-v1-geocoding
 * @version 1.2.0
 */

import { createAPIHandler } from "../_shared/api-handler.ts";
import { handleGet, handlePost } from "./lib/handlers.ts";
import { SERVICE, VERSION } from "./lib/geocoding.ts";

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
