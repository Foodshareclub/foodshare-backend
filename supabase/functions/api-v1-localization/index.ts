/**
 * Unified Localization API v1
 *
 * Consolidated localization service merging locale + localization functions.
 *
 * Routes:
 * - GET  /api-v1-localization              → UI string bundles (simple, fast)
 * - GET  /api-v1-localization/translations  → UI strings with delta sync, user context
 * - POST /api-v1-localization/translate-content → Dynamic content via self-hosted LLM
 * - POST /api-v1-localization/prewarm       → Prewarm translation cache (fire-and-forget)
 * - POST /api-v1-localization/translate-batch → Batch translate content to all locales
 * - POST /api-v1-localization/get-translations → Get cached translations for content items
 * - POST /api-v1-localization/backfill-posts → Backfill translations for existing posts
 * - POST /api-v1-localization/backfill-challenges → Backfill translations for challenges
 * - POST /api-v1-localization/backfill-forum-posts → Backfill translations for forum posts
 * - GET  /api-v1-localization/audit         → Audit untranslated UI strings
 * - POST /api-v1-localization/ui-batch-translate → Batch translate UI strings with LLM
 * - POST /api-v1-localization/update        → Update UI string translations
 * - POST /api-v1-localization/process-queue → Process pending translations from queue
 * - POST /api-v1-localization/generate-infoplist-strings → Generate localized InfoPlist.strings
 * - POST /api-v1-localization/sync-to-redis → Sync locale preference to Redis cache
 * - GET  /api-v1-localization/health        → Comprehensive health check
 */

import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { AppError } from "../_shared/errors.ts";

// Import handlers
import uiStringsHandler from "./handlers/ui-strings.ts";
import translationsHandler from "./handlers/translations.ts";
import translateContentHandler from "./handlers/translate-content.ts";
import prewarmHandler from "./handlers/prewarm.ts";
import translateBatchHandler from "./handlers/translate-batch.ts";
import auditHandler from "./handlers/audit.ts";
import uiBatchTranslateHandler from "./handlers/ui-batch-translate.ts";
import updateHandler from "./handlers/update.ts";
import getTranslationsHandler from "./handlers/get-translations.ts";
import backfillPostsHandler from "./handlers/backfill-posts.ts";
import backfillChallengesHandler from "./handlers/backfill-challenges.ts";
import backfillForumPostsHandler from "./handlers/backfill-forum-posts.ts";
import processQueueHandler from "./handlers/process-queue.ts";
import healthHandler from "./handlers/health.ts";
import generateInfoPlistStringsHandler from "./handlers/generate-infoplist-strings.ts";
import syncToRedisHandler from "./handlers/sync-to-redis.ts";

const SERVICE = "api-v1-localization";

/**
 * Extract subpath from URL
 * /api-v1-localization → ""
 * /api-v1-localization/translations → "translations"
 * /api-v1-localization/sync-to-redis → "sync-to-redis"
 */
function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const locIndex = pathname.indexOf("/api-v1-localization");
  if (locIndex === -1) return "";
  const subPath = pathname.slice(locIndex + 20); // "/api-v1-localization" = 20 chars
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// Handler signature: all handlers receive request + pre-computed CORS headers
type HandlerFn = (req: Request, corsHeaders: Record<string, string>) => Promise<Response> | Response;

// Handler map for POST routes
const postHandlers: Record<string, HandlerFn> = {
  "translate-content": translateContentHandler,
  "prewarm": prewarmHandler,
  "translate-batch": translateBatchHandler,
  "ui-batch-translate": uiBatchTranslateHandler,
  "update": updateHandler,
  "get-translations": getTranslationsHandler,
  "backfill-posts": backfillPostsHandler,
  "backfill-challenges": backfillChallengesHandler,
  "backfill-forum-posts": backfillForumPostsHandler,
  "process-queue": processQueueHandler,
  "generate-infoplist-strings": generateInfoPlistStringsHandler,
  "sync-to-redis": syncToRedisHandler,
};

// Handler map for GET routes
const getHandlers: Record<string, HandlerFn> = {
  "translations": translationsHandler,
  "audit": auditHandler,
  "health": healthHandler,
};

async function routeRequest(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const subPath = getSubPath(url).replace(/\/$/, ""); // strip trailing slash
  const method = ctx.request.method;

  logger.debug("Localization routing", { subPath, method });

  // GET / — Simple UI string bundles (fast, compressed)
  if (method === "GET" && (subPath === "" || subPath === "/")) {
    return uiStringsHandler(ctx.request, ctx.corsHeaders);
  }

  // GET routes
  if (method === "GET") {
    const handler = getHandlers[subPath];
    if (handler) return handler(ctx.request, ctx.corsHeaders);
  }

  // POST routes
  if (method === "POST") {
    const handler = postHandlers[subPath];
    if (handler) return handler(ctx.request, ctx.corsHeaders);
  }

  // Root info for non-GET methods on /
  if (subPath === "" || subPath === "/") {
    return new Response(JSON.stringify({
      success: true,
      service: SERVICE,
      version: "3.0.0",
      endpoints: [
        { path: "/api-v1-localization", method: "GET", description: "UI string bundles (simple)" },
        { path: "/api-v1-localization/translations", method: "GET", description: "UI strings with delta sync" },
        { path: "/api-v1-localization/translate-content", method: "POST", description: "Dynamic content translation via LLM" },
        { path: "/api-v1-localization/prewarm", method: "POST", description: "Prewarm translation cache" },
        { path: "/api-v1-localization/translate-batch", method: "POST", description: "Batch translate content to all locales" },
        { path: "/api-v1-localization/audit", method: "GET", description: "Audit untranslated UI strings" },
        { path: "/api-v1-localization/ui-batch-translate", method: "POST", description: "Batch translate UI strings with LLM" },
        { path: "/api-v1-localization/update", method: "POST", description: "Update UI string translations" },
        { path: "/api-v1-localization/get-translations", method: "POST", description: "Get cached translations for content (BFF)" },
        { path: "/api-v1-localization/backfill-posts", method: "POST", description: "Backfill translations for existing posts" },
        { path: "/api-v1-localization/backfill-challenges", method: "POST", description: "Backfill translations for challenges" },
        { path: "/api-v1-localization/backfill-forum-posts", method: "POST", description: "Backfill translations for forum posts" },
        { path: "/api-v1-localization/process-queue", method: "POST", description: "Process pending translations from queue" },
        { path: "/api-v1-localization/generate-infoplist-strings", method: "POST", description: "Generate localized InfoPlist.strings" },
        { path: "/api-v1-localization/sync-to-redis", method: "POST", description: "Sync locale preference to Redis cache" },
        { path: "/api-v1-localization/health", method: "GET", description: "Comprehensive health check" },
      ],
      supportedLocales: [
        "en", "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi",
        "ar", "it", "pl", "nl", "ja", "ko", "tr", "vi", "id", "th", "sv"
      ],
    }), {
      status: 200,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  throw new AppError(`Endpoint not found: ${subPath}`, "NOT_FOUND", 404);
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: "3",
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 100,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: routeRequest },
    POST: { handler: routeRequest },
  },
}));
