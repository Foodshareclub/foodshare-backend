/**
 * Sync to Redis Handler
 *
 * Updates the Redis cache with user locale preferences.
 * Called by:
 * - Database trigger when profiles.preferred_locale changes
 * - Direct API call from clients after locale change
 *
 * This enables O(1) locale lookup on app launch instead of database query.
 */

import { logger } from "../../_shared/logger.ts";
import { userLocaleCache } from "../services/translation-cache.ts";

interface SyncToRedisRequest {
  userId: string;
  locale: string;
}

export default async function syncToRedisHandler(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "Use POST method" },
      }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const startTime = Date.now();

  try {
    // Parse request body
    const body = await req.json() as SyncToRedisRequest;
    const { userId, locale } = body;

    // Validate required fields
    if (!userId || !locale) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "userId and locale are required" },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Validate locale format (2-letter code)
    const validLocales = [
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
    ];

    if (!validLocales.includes(locale)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "INVALID_LOCALE", message: `Unsupported locale: ${locale}` },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Validate userId format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "INVALID_USER_ID", message: "userId must be a valid UUID" },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Update Redis cache
    await userLocaleCache.set(userId, locale, "profile_update");

    const responseTimeMs = Date.now() - startTime;

    logger.info("Locale synced to Redis", {
      userId,
      locale,
      responseTimeMs,
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          userId,
          locale,
          cached: true,
        },
        meta: {
          responseTimeMs,
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    logger.error("Sync to Redis error", { error });

    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: (error as Error).message,
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
