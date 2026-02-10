/**
 * Enterprise Image API v1
 *
 * Unified image processing endpoint for all features:
 * - Listings, Forum, Profiles, Challenges
 *
 * Features:
 * - Smart compression (TinyPNG/Cloudinary)
 * - EXIF extraction (GPS, timestamp, camera)
 * - Thumbnail generation
 * - AI food detection (optional)
 * - Batch upload support
 * - Orphan cleanup
 * - Recompression
 * - External URL upload
 *
 * Routes:
 * - POST /upload           - Single image upload
 * - POST /batch            - Batch image upload
 * - POST /proxy            - Proxy external image
 * - POST /upload-from-url  - Download and upload external image
 * - POST /cleanup          - Cleanup orphan images (cron)
 * - POST /recompress       - Recompress old images (cron)
 * - GET  /health           - Health check
 *
 * @module api-v1-images
 * @version 2.0.0
 */

import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { AppError } from "../_shared/errors.ts";
import { parseRoute } from "../_shared/routing.ts";
import { isR2Configured } from "../_shared/r2-storage.ts";

// Import handlers from lib/
import { handleUpload, handleBatchUpload } from "./lib/upload.ts";
import { handleProxy, handleUploadFromUrl } from "./lib/proxy.ts";
import { handleCleanup, handleRecompress } from "./lib/maintenance.ts";

const VERSION = "2.0.0";
const SERVICE = "api-v1-images";

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      r2: isR2Configured(),
    }, ctx);
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  switch (route.resource) {
    case "upload":
      return await handleUpload(ctx);
    case "batch":
      return await handleBatchUpload(ctx);
    case "proxy":
      return await handleProxy(ctx);
    case "upload-from-url":
      return await handleUploadFromUrl(ctx);
    case "cleanup":
      return await handleCleanup(ctx);
    case "recompress":
      return await handleRecompress(ctx);
    default:
      throw new AppError("Not found", "NOT_FOUND", 404);
  }
}

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
