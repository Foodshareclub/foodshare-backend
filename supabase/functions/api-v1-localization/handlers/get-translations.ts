/**
 * Get Translations Handler (Simplified)
 *
 * Fetches pre-translated content from database.
 * Backend jobs (backfill-forum-posts, process-queue) handle translation.
 * Apps just fetch what's already translated.
 *
 * POST /localization/get-translations
 * {
 *   "contentType": "post" | "challenge" | "forum_post",
 *   "contentIds": ["123", "456", ...],
 *   "locale": "ru",
 *   "fields": ["title", "description"]  // optional
 * }
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";

interface GetTranslationsRequest {
  contentType: "post" | "challenge" | "forum_post";
  contentIds: string[];
  locale: string;
  fields?: string[];
}

interface TranslationResult {
  [field: string]: string | null;
}

// Supported locales
const SUPPORTED_LOCALES = [
  "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi", "ar",
  "it", "pl", "nl", "ja", "ko", "tr", "sv", "vi", "id", "th"
];

// Field mappings for different content types
const CONTENT_FIELD_MAPPINGS: Record<string, Record<string, string>> = {
  post: { title: "post_name", description: "post_description" },
  challenge: { title: "challenge_title", description: "challenge_description" },
  forum_post: { title: "forum_post_name", content: "forum_post_description" }
};

// Table names for different content types
const CONTENT_TABLES: Record<string, string> = {
  post: "posts",
  challenge: "challenges",
  forum_post: "forum"
};

/**
 * Create SHA-256 hash of text (for DB lookup)
 */
async function hashText(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export default async function getTranslationsHandler(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed. Use POST."
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const body: GetTranslationsRequest = await req.json();
    const { contentType, contentIds, locale, fields = ["title", "description"] } = body;

    // Validate content type
    if (!contentType || !["post", "challenge", "forum_post"].includes(contentType)) {
      return new Response(JSON.stringify({
        success: false,
        error: "Invalid contentType. Must be 'post', 'challenge', or 'forum_post'."
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Return empty for English
    if (locale === "en") {
      const emptyTranslations: Record<string, TranslationResult> = {};
      for (const id of contentIds || []) {
        emptyTranslations[id] = {};
        for (const field of fields) {
          emptyTranslations[id][field] = null;
        }
      }
      return new Response(JSON.stringify({
        success: true,
        translations: emptyTranslations,
        locale: "en",
        fromDatabase: 0,
        notFound: contentIds?.length || 0
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Validate locale
    if (!locale || !SUPPORTED_LOCALES.includes(locale)) {
      return new Response(JSON.stringify({
        success: false,
        error: `Unsupported locale: ${locale}`,
        supportedLocales: SUPPORTED_LOCALES
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Validate content IDs
    if (!contentIds || !Array.isArray(contentIds) || contentIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        translations: {},
        locale,
        fromDatabase: 0,
        notFound: 0
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Limit batch size
    const maxBatchSize = 50;
    const limitedIds = contentIds.slice(0, maxBatchSize);

    // Initialize Supabase client
    const supabase = getSupabaseClient();

    // Results tracking
    const translations: Record<string, TranslationResult> = {};
    let fromDatabase = 0;

    const tableName = CONTENT_TABLES[contentType];
    const fieldMapping = CONTENT_FIELD_MAPPINGS[contentType];

    // Build select columns
    const selectColumns = ["id", ...Object.values(fieldMapping)].join(", ");

    // Fetch source content from database
    const { data: sourceContent, error: sourceError } = await supabase
      .from(tableName)
      .select(selectColumns)
      .in("id", limitedIds.map(id => parseInt(id, 10)));

    if (sourceError) {
      logger.error("Failed to fetch source content", sourceError);
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to fetch source content: ${sourceError.message}`
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (sourceContent && sourceContent.length > 0) {
      // For each content item, look up translations by content hash
      for (const item of sourceContent) {
        const contentId = String(item.id);
        translations[contentId] = {};

        for (const field of fields) {
          const dbColumn = fieldMapping[field];
          const sourceText = item[dbColumn];

          if (!sourceText || sourceText.trim().length === 0) {
            translations[contentId][field] = null;
            continue;
          }

          // Generate hash for lookup
          const contentHash = await hashText(sourceText);

          // Look up in dynamic_content_translations by hash
          const { data: dbTrans, error: dbError } = await supabase
            .from("dynamic_content_translations")
            .select("translated_text")
            .eq("content_hash", contentHash)
            .eq("target_locale", locale)
            .gt("expires_at", new Date().toISOString())
            .single();

          if (!dbError && dbTrans?.translated_text) {
            translations[contentId][field] = dbTrans.translated_text;
            fromDatabase++;
          } else {
            // No translation found - return null (backend will translate via background job)
            translations[contentId][field] = null;
          }
        }
      }
    }

    // Initialize any remaining IDs not found in source table
    for (const contentId of limitedIds) {
      if (!translations[contentId]) {
        translations[contentId] = {};
        for (const field of fields) {
          translations[contentId][field] = null;
        }
      }
    }

    const notFound = Object.values(translations).filter(
      t => Object.values(t).every(v => v === null)
    ).length;

    logger.debug("Get translations completed", { 
      itemCount: limitedIds.length, 
      fromDatabase, 
      notFound, 
      locale 
    });

    return new Response(JSON.stringify({
      success: true,
      translations,
      locale,
      fromDatabase,
      notFound
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    logger.error("Get translations error", error as Error);
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
