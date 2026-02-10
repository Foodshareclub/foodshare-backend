/**
 * Translation Audit Handler
 *
 * Audits translations to find untranslated UI strings by comparing
 * locale translations against English reference.
 *
 * Routes:
 * - GET /localization/audit?locale=de           → Audit single locale
 * - GET /localization/audit?locale=de&category=challenge → Audit by category
 * - GET /localization/audit?all=true            → Summary of all locales
 *
 * Features:
 * - Find strings that match English (likely untranslated)
 * - Filter by category (challenge, settings, etc.)
 * - Group results by top-level category
 * - Skip intentionally identical strings (URLs, emails, brand names)
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";

const VERSION = "2.0.0";
const SUPPORTED_LOCALES = [
  "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi", "ar",
  "it", "pl", "nl", "ja", "ko", "tr", "sv", "vi", "id", "th"
];

/**
 * Recursively flatten nested object to dot-notation paths
 */
function flattenObject(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
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
}

/**
 * Find keys where the value matches English (i.e., untranslated)
 */
function findUntranslatedKeys(
  englishFlat: Record<string, string>,
  localeFlat: Record<string, string>
): { key: string; value: string }[] {
  const untranslated: { key: string; value: string }[] = [];

  for (const [key, englishValue] of Object.entries(englishFlat)) {
    const localeValue = localeFlat[key];

    // Skip if key doesn't exist in locale (missing key, not untranslated)
    if (localeValue === undefined) continue;

    // Check if the value is identical to English
    if (localeValue === englishValue) {
      // Skip keys that are legitimately the same (URLs, brand names, etc.)
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

      untranslated.push({ key, value: englishValue });
    }
  }

  return untranslated;
}

export default async function auditHandler(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed. Use GET."
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const url = new URL(req.url);
  const supabase = getSupabaseClient();

  // Get query parameters
  const locale = url.searchParams.get("locale");
  const all = url.searchParams.get("all") === "true";
  const limit = parseInt(url.searchParams.get("limit") || "500");
  const category = url.searchParams.get("category"); // e.g., "challenge", "settings"

  // Fetch English translations as reference
  const { data: englishData, error: englishError } = await supabase
    .from("translations")
    .select("messages")
    .eq("locale", "en")
    .single();

  if (englishError || !englishData) {
    return new Response(JSON.stringify({
      success: false,
      error: "english_not_found",
      message: "Could not fetch English reference translations"
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const englishFlat = flattenObject(englishData.messages as Record<string, unknown>);

  // Single locale audit
  if (locale && !all) {
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

    const { data: localeData, error: localeError } = await supabase
      .from("translations")
      .select("messages, version")
      .eq("locale", locale)
      .single();

    if (localeError || !localeData) {
      return new Response(JSON.stringify({
        success: false,
        error: "locale_not_found",
        message: `Could not fetch translations for locale '${locale}'`
      }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const localeFlat = flattenObject(localeData.messages as Record<string, unknown>);
    let untranslated = findUntranslatedKeys(englishFlat, localeFlat);

    // Filter by category if specified
    if (category) {
      untranslated = untranslated.filter(item => item.key.startsWith(`${category}.`));
    }

    // Apply limit
    const limited = untranslated.slice(0, limit);

    // Group by top-level category for summary
    const byCategory: Record<string, number> = {};
    for (const item of untranslated) {
      const cat = item.key.split(".")[0];
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      locale,
      localeVersion: localeData.version,
      totalKeys: Object.keys(localeFlat).length,
      untranslatedCount: untranslated.length,
      returnedCount: limited.length,
      byCategory,
      untranslated: limited.map(item => ({
        key: item.key,
        englishValue: item.value
      }))
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // All locales summary
  if (all) {
    const { data: allLocales, error: allError } = await supabase
      .from("translations")
      .select("locale, messages, version")
      .neq("locale", "en");

    if (allError || !allLocales) {
      return new Response(JSON.stringify({
        success: false,
        error: "fetch_failed",
        message: "Could not fetch all locale translations"
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const summary: Record<string, {
      locale: string;
      version: string;
      totalKeys: number;
      untranslatedCount: number;
      byCategory: Record<string, number>;
    }> = {};

    for (const localeData of allLocales) {
      const localeFlat = flattenObject(localeData.messages as Record<string, unknown>);
      const untranslated = findUntranslatedKeys(englishFlat, localeFlat);

      const byCategory: Record<string, number> = {};
      for (const item of untranslated) {
        const cat = item.key.split(".")[0];
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      }

      summary[localeData.locale] = {
        locale: localeData.locale,
        version: localeData.version,
        totalKeys: Object.keys(localeFlat).length,
        untranslatedCount: untranslated.length,
        byCategory
      };
    }

    // Sort by untranslated count
    const sorted = Object.values(summary).sort((a, b) => b.untranslatedCount - a.untranslatedCount);

    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      englishKeyCount: Object.keys(englishFlat).length,
      localeCount: sorted.length,
      totalUntranslated: sorted.reduce((sum, l) => sum + l.untranslatedCount, 0),
      locales: sorted
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Default: show usage
  return new Response(JSON.stringify({
    success: true,
    version: VERSION,
    usage: {
      singleLocale: "GET /localization/audit?locale=de",
      singleLocaleWithCategory: "GET /localization/audit?locale=de&category=challenge",
      singleLocaleWithLimit: "GET /localization/audit?locale=de&limit=100",
      allLocales: "GET /localization/audit?all=true"
    },
    supportedLocales: SUPPORTED_LOCALES
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
