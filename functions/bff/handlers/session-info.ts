/**
 * BFF Session Info Handler
 *
 * Lightweight endpoint returning user's cached session data:
 * - User ID
 * - Cached locale preference (Redis-first with DB fallback)
 *
 * This endpoint is optimized for fast cold starts and is called
 * immediately after authentication to sync locale preferences
 * across devices with O(1) Redis lookup.
 *
 * Reduces client round-trips by providing essential session data
 * in a single, fast request (~10ms with Redis cache hit).
 */

import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { userLocaleCache } from "../../localization/services/translation-cache.ts";

// =============================================================================
// Response Types
// =============================================================================

interface SessionInfoResponse {
  userId: string;
  locale: string;
  localeSource: "cache" | "database" | "default";
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetSessionInfo(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const startTime = Date.now();

  if (!userId) {
    logger.warn("Session info requested without user ID");
    return ok({ userId: null, locale: "en", localeSource: "default" }, ctx);
  }

  let locale: string | null = null;
  let localeSource: "cache" | "database" | "default" = "default";

  // 1. Try Redis cache first (O(1) lookup, ~1-5ms)
  try {
    locale = await userLocaleCache.get(userId);
    if (locale) {
      localeSource = "cache";
      logger.debug("Session info: Redis cache hit", { userId, locale });
    }
  } catch (error) {
    logger.warn("Session info: Redis cache error", { error: (error as Error).message });
  }

  // 2. Fallback to database if cache miss
  if (!locale) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("preferred_locale")
        .eq("id", userId)
        .single();

      if (error) {
        logger.warn("Session info: DB query failed", { error: error.message });
      } else if (data?.preferred_locale) {
        locale = data.preferred_locale;
        localeSource = "database";

        // Populate Redis cache for next time (fire-and-forget)
        userLocaleCache.set(userId, locale, "db_fallback").catch((err) => {
          logger.warn("Session info: Failed to cache locale", { error: (err as Error).message });
        });

        logger.debug("Session info: DB fallback", { userId, locale });
      }
    } catch (error) {
      logger.error("Session info: DB query error", { error: (error as Error).message });
    }
  }

  // 3. Default to English if no preference found
  if (!locale) {
    locale = "en";
    localeSource = "default";
    logger.debug("Session info: Using default locale", { userId });
  }

  const responseTimeMs = Date.now() - startTime;
  logger.info("Session info fetched", {
    userId,
    locale,
    localeSource,
    responseTimeMs,
  });

  const response: SessionInfoResponse = {
    userId,
    locale,
    localeSource,
  };

  return ok(response, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-session-info",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 120,
    windowMs: 60000, // 120 requests per minute (higher for cold start scenarios)
    keyBy: "user",
  },
  routes: {
    GET: {
      handler: handleGetSessionInfo,
    },
    // Support POST for Supabase client library which defaults to POST for functions.invoke()
    POST: {
      handler: handleGetSessionInfo,
    },
  },
});
