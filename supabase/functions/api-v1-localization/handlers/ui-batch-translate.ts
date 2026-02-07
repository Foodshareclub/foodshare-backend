/**
 * UI String Batch Translation Handler
 *
 * Translates UI strings from English to target locale using self-hosted LLM.
 * Works with the `translations` table which stores static UI strings.
 *
 * Routes:
 * - POST /localization/ui-batch-translate
 *
 * Usage:
 * {
 *   "locale": "de",
 *   "keys": { "challenge.title": "Challenge", "settings.profile": "Profile" },
 *   "apply": true,  // optional: apply translations to database
 *   "category": "challenge"  // optional: filter audit keys by category
 * }
 *
 * If keys not provided, fetches untranslated keys from audit endpoint.
 *
 * Features:
 * - Uses self-hosted LLM at translate.foodshare.club
 * - Preserves placeholders like {name}, {count}
 * - Batch processing (max 50 keys per request)
 * - Optional auto-apply to database
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";
import { getCorsHeaders } from "../../_shared/cors.ts";
import { logger } from "../../_shared/logger.ts";
import { llmTranslationService } from "../services/llm-translation.ts";

const VERSION = "2.0.0";
const MAX_KEYS_PER_BATCH = 50;

const SUPPORTED_LOCALES = [
  "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi", "ar",
  "it", "pl", "nl", "ja", "ko", "tr", "sv", "vi", "id", "th"
];

/**
 * Translate using self-hosted LLM
 */
async function translateWithLLM(
  keys: Record<string, string>,
  targetLocale: string
): Promise<Record<string, string>> {
  const translations: Record<string, string> = {};

  // Translate each key individually
  for (const [key, englishValue] of Object.entries(keys)) {
    try {
      const result = await llmTranslationService.translate(
        englishValue,
        "en",
        targetLocale,
        `UI string for key: ${key}`
      );

      // Only use translation if quality > 0 (successful)
      if (result.quality > 0) {
        translations[key] = result.text;
      } else {
        // Keep original if translation failed
        translations[key] = englishValue;
        logger.warn("Translation failed for key, keeping original", { key });
      }
    } catch (error) {
      logger.error("Translation error for key", { key, error });
      translations[key] = englishValue;
    }
  }

  return translations;
}

/**
 * Convert flat dot-notation keys to nested object for update
 */
function unflattenObject(flat: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [flatKey, value] of Object.entries(flat)) {
    const parts = flatKey.split(".");
    let current: Record<string, unknown> = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  return result;
}

/**
 * Deep merge two objects
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Fetch untranslated keys from database
 */
async function fetchUntranslatedKeys(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  locale: string,
  category?: string,
  limit: number = MAX_KEYS_PER_BATCH
): Promise<Record<string, string>> {
  // Fetch English translations as reference
  const { data: englishData, error: englishError } = await supabase
    .from("translations")
    .select("messages")
    .eq("locale", "en")
    .single();

  if (englishError || !englishData) {
    throw new Error("Could not fetch English reference translations");
  }

  // Fetch target locale
  const { data: localeData, error: localeError } = await supabase
    .from("translations")
    .select("messages")
    .eq("locale", locale)
    .single();

  if (localeError || !localeData) {
    throw new Error(`Could not fetch translations for locale '${locale}'`);
  }

  // Flatten both
  const flattenObject = (obj: Record<string, unknown>, prefix = ""): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, flattenObject(value as Record<string, unknown>, path));
      } else if (typeof value === "string") {
        result[path] = value;
      }
    }
    return result;
  };

  // deno-lint-ignore no-explicit-any
  const englishFlat = flattenObject((englishData as any).messages as Record<string, unknown>);
  // deno-lint-ignore no-explicit-any
  const localeFlat = flattenObject((localeData as any).messages as Record<string, unknown>);

  // Find untranslated keys
  const untranslated: Record<string, string> = {};
  let count = 0;

  for (const [key, englishValue] of Object.entries(englishFlat)) {
    if (count >= limit) break;

    const localeValue = localeFlat[key];
    if (localeValue === undefined) continue;

    // Check if value matches English (likely untranslated)
    if (localeValue === englishValue) {
      // Skip intentionally identical strings
      if (
        englishValue.includes("http") ||
        englishValue.includes("@") ||
        englishValue.match(/^[0-9.%]+$/) ||
        key.includes("_url") ||
        key.includes("email") ||
        key.endsWith(".icon") ||
        key.endsWith(".emoji")
      ) {
        continue;
      }

      // Filter by category if specified
      if (category && !key.startsWith(`${category}.`)) {
        continue;
      }

      untranslated[key] = englishValue;
      count++;
    }
  }

  return untranslated;
}

export default async function uiBatchTranslateHandler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed. Use POST."
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const supabase = getSupabaseClient();

  try {
    const body = await req.json();
    const { locale, keys, apply = false, category } = body;

    if (!locale) {
      return new Response(JSON.stringify({
        success: false,
        error: "missing_locale",
        message: "locale is required"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (!SUPPORTED_LOCALES.includes(locale)) {
      return new Response(JSON.stringify({
        success: false,
        error: "unsupported_locale",
        message: `Locale '${locale}' not supported. Supported: ${SUPPORTED_LOCALES.join(", ")}`
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // If keys not provided, fetch untranslated from audit
    let keysToTranslate = keys as Record<string, string>;

    if (!keysToTranslate || Object.keys(keysToTranslate).length === 0) {
      keysToTranslate = await fetchUntranslatedKeys(supabase, locale, category);
    }

    const keyCount = Object.keys(keysToTranslate).length;

    if (keyCount === 0) {
      return new Response(JSON.stringify({
        success: true,
        locale,
        message: "No keys to translate",
        translated: 0
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Limit batch size
    if (keyCount > MAX_KEYS_PER_BATCH) {
      const limitedKeys: Record<string, string> = {};
      let count = 0;
      for (const [key, value] of Object.entries(keysToTranslate)) {
        if (count >= MAX_KEYS_PER_BATCH) break;
        limitedKeys[key] = value;
        count++;
      }
      keysToTranslate = limitedKeys;
    }

    // Translate using self-hosted LLM
    const translations = await translateWithLLM(keysToTranslate, locale);

    // Apply to database if requested
    if (apply) {
      const { data: current, error: fetchError } = await supabase
        .from("translations")
        .select("id, messages")
        .eq("locale", locale)
        .single();

      if (fetchError || !current) {
        return new Response(JSON.stringify({
          success: false,
          error: "locale_not_found",
          message: `Could not fetch current translations for locale '${locale}'`,
          translations
        }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Convert flat translations to nested and merge
      const nestedTranslations = unflattenObject(translations);
      const mergedMessages = deepMerge(
        // deno-lint-ignore no-explicit-any
        (current as any).messages as Record<string, unknown>,
        nestedTranslations
      );
      const version = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

      // Update database
      const { error: updateError } = await supabase
        .from("translations")
        .update({
          messages: mergedMessages,
          version,
          updated_at: new Date().toISOString(),
        })
        // deno-lint-ignore no-explicit-any
        .eq("id", (current as any).id);

      if (updateError) {
        return new Response(JSON.stringify({
          success: false,
          error: "update_failed",
          message: updateError.message,
          translations
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        version: VERSION,
        locale,
        translated: Object.keys(translations).length,
        applied: true,
        newVersion: version,
        translations
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Return translations without applying
    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      locale,
      translated: Object.keys(translations).length,
      applied: false,
      translations
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: "translation_failed",
      message: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
