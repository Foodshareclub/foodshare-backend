/**
 * Localization Edge Function - Componentized Router
 *
 * Consolidated translation service with multiple handlers:
 *
 * Routes:
 * - GET  /localization              → UI string bundles (simple, fast)
 * - GET  /localization/translations → UI strings with delta sync, user context
 * - POST /localization/translate-content → Dynamic content via self-hosted LLM
 * - POST /localization/prewarm      → Prewarm translation cache (fire-and-forget)
 * - POST /localization/translate-batch → Batch translate content to all locales
 * - POST /localization/get-translations → Get cached translations for content items
 * - POST /localization/backfill-posts → Backfill translations for existing posts
 * - GET  /localization/audit        → Audit untranslated UI strings
 * - POST /localization/ui-batch-translate → Batch translate UI strings with self-hosted LLM
 * - POST /localization/update       → Update UI string translations
 *
 * Features:
 * - Multi-level caching (Edge, Memory, Database, Redis)
 * - Compression (gzip)
 * - ETag support
 * - Rate limiting
 * - Self-hosted LLM for dynamic content
 * - Self-hosted LLM for UI string translation
 * - 21 languages supported
 */

import { getCorsHeaders } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

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

/**
 * Extract subpath from URL
 * /localization → ""
 * /localization/translations → "translations"
 * /localization/translate-content → "translate-content"
 */
function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const locIndex = pathname.indexOf("/localization");
  if (locIndex === -1) return "";
  const subPath = pathname.slice(locIndex + 13); // "/localization" = 13 chars
  // Remove leading slash if present
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

  logger.debug("Localization routing", { subPath, method: req.method });

  try {
    switch (subPath) {
      case "":
      case "/":
        // GET /localization → Simple UI string bundles (fast, compressed)
        return uiStringsHandler(req);

      case "translations":
      case "translations/":
        // GET /localization/translations → Delta sync, user context, feature flags
        return translationsHandler(req);

      case "translate-content":
      case "translate-content/":
        // POST /localization/translate-content → Dynamic content via LLM
        return translateContentHandler(req);

      case "prewarm":
      case "prewarm/":
        // POST /localization/prewarm → Prewarm translation cache (fire-and-forget)
        return prewarmHandler(req);

      case "translate-batch":
      case "translate-batch/":
        // POST /localization/translate-batch → Batch translate content to all locales
        return translateBatchHandler(req);

      case "audit":
      case "audit/":
        // GET /localization/audit → Audit untranslated UI strings
        return auditHandler(req);

      case "ui-batch-translate":
      case "ui-batch-translate/":
        // POST /localization/ui-batch-translate → Batch translate UI strings with OpenAI
        return uiBatchTranslateHandler(req);

      case "update":
      case "update/":
        // POST /localization/update → Update UI string translations
        return updateHandler(req);

      case "get-translations":
      case "get-translations/":
        // POST /localization/get-translations → Get cached translations for content (called by BFF)
        return getTranslationsHandler(req);

      case "backfill-posts":
      case "backfill-posts/":
        // POST /localization/backfill-posts → Backfill translations for existing posts
        return backfillPostsHandler(req);

      case "backfill-challenges":
      case "backfill-challenges/":
        // POST /localization/backfill-challenges → Backfill translations for existing challenges
        return backfillChallengesHandler(req);

      case "backfill-forum-posts":
      case "backfill-forum-posts/":
        // POST /localization/backfill-forum-posts → Backfill translations for existing forum posts
        return backfillForumPostsHandler(req);

      case "process-queue":
      case "process-queue/":
        // POST /localization/process-queue → Process pending translations from queue
        return processQueueHandler(req);

      case "generate-infoplist-strings":
      case "generate-infoplist-strings/":
        // POST /localization/generate-infoplist-strings → Generate localized InfoPlist.strings
        return generateInfoPlistStringsHandler(req);

      case "health":
      case "health/":
        // GET /localization/health → Comprehensive health check
        return healthHandler(req);

      default:
        // Return service info for root without path
        if (subPath === "" && req.method === "GET") {
          return new Response(JSON.stringify({
            success: true,
            service: "localization",
            version: "2.1.0",
            endpoints: [
              { path: "/localization", method: "GET", description: "UI string bundles (simple)" },
              { path: "/localization/translations", method: "GET", description: "UI strings with delta sync" },
              { path: "/localization/translate-content", method: "POST", description: "Dynamic content translation via LLM" },
              { path: "/localization/prewarm", method: "POST", description: "Prewarm translation cache (fire-and-forget)" },
              { path: "/localization/translate-batch", method: "POST", description: "Batch translate content to all locales (background)" },
              { path: "/localization/audit", method: "GET", description: "Audit untranslated UI strings" },
              { path: "/localization/ui-batch-translate", method: "POST", description: "Batch translate UI strings with self-hosted LLM" },
              { path: "/localization/update", method: "POST", description: "Update UI string translations" },
              { path: "/localization/get-translations", method: "POST", description: "Get cached translations for content (BFF)" },
              { path: "/localization/backfill-posts", method: "POST", description: "Backfill translations for existing posts" },
              { path: "/localization/backfill-challenges", method: "POST", description: "Backfill translations for existing challenges" },
              { path: "/localization/backfill-forum-posts", method: "POST", description: "Backfill translations for existing forum posts" },
              { path: "/localization/process-queue", method: "POST", description: "Process pending translations from queue (cron)" },
              { path: "/localization/generate-infoplist-strings", method: "POST", description: "Generate localized InfoPlist.strings files" },
            ],
            supportedLocales: [
              "en", "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi",
              "ar", "it", "pl", "nl", "ja", "ko", "tr", "vi", "id", "th", "sv"
            ],
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
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
    logger.error("Localization error", error as Error);
    return new Response(JSON.stringify({
      success: false,
      error: { code: "INTERNAL_ERROR", message: (error as Error).message },
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
