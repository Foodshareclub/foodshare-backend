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

// Lazy-load handlers to reduce cold start time (~300-500ms savings)
// Only the handler for the requested route is loaded per request
const lazyImport = <T>(path: string) => () => import(path).then((m) => m.default as T);

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
type HandlerFn = (
  req: Request,
  corsHeaders: Record<string, string>,
) => Promise<Response> | Response;

// Lazy handler maps — each handler is loaded only when its route is first accessed
const postHandlerLoaders: Record<string, () => Promise<HandlerFn>> = {
  "translate-content": lazyImport<HandlerFn>("./handlers/translate-content.ts"),
  "prewarm": lazyImport<HandlerFn>("./handlers/prewarm.ts"),
  "translate-batch": lazyImport<HandlerFn>("./handlers/translate-batch.ts"),
  "ui-batch-translate": lazyImport<HandlerFn>("./handlers/ui-batch-translate.ts"),
  "update": lazyImport<HandlerFn>("./handlers/update.ts"),
  "get-translations": lazyImport<HandlerFn>("./handlers/get-translations.ts"),
  "backfill-posts": lazyImport<HandlerFn>("./handlers/backfill-posts.ts"),
  "backfill-challenges": lazyImport<HandlerFn>("./handlers/backfill-challenges.ts"),
  "backfill-forum-posts": lazyImport<HandlerFn>("./handlers/backfill-forum-posts.ts"),
  "process-queue": lazyImport<HandlerFn>("./handlers/process-queue.ts"),
  "generate-infoplist-strings": lazyImport<HandlerFn>("./handlers/generate-infoplist-strings.ts"),
  "sync-to-redis": lazyImport<HandlerFn>("./handlers/sync-to-redis.ts"),
};

// Lazy handler maps for GET routes
const getHandlerLoaders: Record<string, () => Promise<HandlerFn>> = {
  "translations": lazyImport<HandlerFn>("./handlers/translations.ts"),
  "audit": lazyImport<HandlerFn>("./handlers/audit.ts"),
  "health": lazyImport<HandlerFn>("./handlers/health.ts"),
};

// Cache resolved handlers to avoid re-importing on subsequent requests
const resolvedHandlers = new Map<string, HandlerFn>();

async function resolveHandler(
  loaders: Record<string, () => Promise<HandlerFn>>,
  key: string,
): Promise<HandlerFn | null> {
  const cacheKey = `${key}`;
  const cached = resolvedHandlers.get(cacheKey);
  if (cached) return cached;

  const loader = loaders[key];
  if (!loader) return null;

  const handler = await loader();
  resolvedHandlers.set(cacheKey, handler);
  return handler;
}

async function routeRequest(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const subPath = getSubPath(url).replace(/\/$/, ""); // strip trailing slash
  const method = ctx.request.method;

  logger.debug("Localization routing", { subPath, method });

  // GET / — Simple UI string bundles (fast, compressed)
  if (method === "GET" && (subPath === "" || subPath === "/")) {
    const handler = await resolveHandler(
      { "ui-strings": lazyImport<HandlerFn>("./handlers/ui-strings.ts") },
      "ui-strings",
    );
    if (handler) return handler(ctx.request, ctx.corsHeaders);
  }

  // GET routes
  if (method === "GET") {
    const handler = await resolveHandler(getHandlerLoaders, subPath);
    if (handler) return handler(ctx.request, ctx.corsHeaders);
  }

  // POST routes
  if (method === "POST") {
    const handler = await resolveHandler(postHandlerLoaders, subPath);
    if (handler) return handler(ctx.request, ctx.corsHeaders);
  }

  // Root info for non-GET methods on /
  if (subPath === "" || subPath === "/") {
    return new Response(
      JSON.stringify({
        success: true,
        service: SERVICE,
        version: "3.0.0",
        endpoints: [
          {
            path: "/api-v1-localization",
            method: "GET",
            description: "UI string bundles (simple)",
          },
          {
            path: "/api-v1-localization/translations",
            method: "GET",
            description: "UI strings with delta sync",
          },
          {
            path: "/api-v1-localization/translate-content",
            method: "POST",
            description: "Dynamic content translation via LLM",
          },
          {
            path: "/api-v1-localization/prewarm",
            method: "POST",
            description: "Prewarm translation cache",
          },
          {
            path: "/api-v1-localization/translate-batch",
            method: "POST",
            description: "Batch translate content to all locales",
          },
          {
            path: "/api-v1-localization/audit",
            method: "GET",
            description: "Audit untranslated UI strings",
          },
          {
            path: "/api-v1-localization/ui-batch-translate",
            method: "POST",
            description: "Batch translate UI strings with LLM",
          },
          {
            path: "/api-v1-localization/update",
            method: "POST",
            description: "Update UI string translations",
          },
          {
            path: "/api-v1-localization/get-translations",
            method: "POST",
            description: "Get cached translations for content (BFF)",
          },
          {
            path: "/api-v1-localization/backfill-posts",
            method: "POST",
            description: "Backfill translations for existing posts",
          },
          {
            path: "/api-v1-localization/backfill-challenges",
            method: "POST",
            description: "Backfill translations for challenges",
          },
          {
            path: "/api-v1-localization/backfill-forum-posts",
            method: "POST",
            description: "Backfill translations for forum posts",
          },
          {
            path: "/api-v1-localization/process-queue",
            method: "POST",
            description: "Process pending translations from queue",
          },
          {
            path: "/api-v1-localization/generate-infoplist-strings",
            method: "POST",
            description: "Generate localized InfoPlist.strings",
          },
          {
            path: "/api-v1-localization/sync-to-redis",
            method: "POST",
            description: "Sync locale preference to Redis cache",
          },
          {
            path: "/api-v1-localization/health",
            method: "GET",
            description: "Comprehensive health check",
          },
        ],
        supportedLocales: [
          "en",
          "cs",
          "de",
          "es",
          "fr",
          "pt",
          "ru",
          "uk",
          "zh",
          "hi",
          "ar",
          "it",
          "pl",
          "nl",
          "ja",
          "ko",
          "tr",
          "vi",
          "id",
          "th",
          "sv",
        ],
      }),
      {
        status: 200,
        headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
      },
    );
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
