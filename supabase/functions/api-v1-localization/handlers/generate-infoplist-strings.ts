/**
 * InfoPlist.strings Generation Handler
 *
 * High-performance localized InfoPlist.strings generator for iOS permission descriptions.
 * Uses parallel translation with the 5-tier LLM fallback chain.
 *
 * Features:
 * - Parallel translation across all locales (20 concurrent)
 * - Content-hash caching to skip unchanged strings
 * - Graceful degradation with partial success
 * - Comprehensive error reporting
 *
 * POST /localization/generate-infoplist-strings
 */

import { logger } from "../../_shared/logger.ts";
import { llmTranslationService } from "../services/llm-translation.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

const VERSION = "2.0.0";
const CONCURRENCY_LIMIT = 5; // Parallel locale translations
const CACHE_TABLE = "infoplist_translation_cache";

// All 21 supported locales
const ALL_LOCALES = [
  "en", "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi",
  "ar", "it", "pl", "nl", "ja", "ko", "tr", "vi", "id", "th", "sv"
] as const;

type Locale = typeof ALL_LOCALES[number];

const TARGET_LOCALES = ALL_LOCALES.filter((l): l is Exclude<Locale, "en"> => l !== "en");

const LOCALE_NAMES: Record<Locale, string> = {
  en: "English", cs: "Czech", de: "German", es: "Spanish", fr: "French",
  pt: "Portuguese", ru: "Russian", uk: "Ukrainian", zh: "Chinese (Simplified)",
  hi: "Hindi", ar: "Arabic", it: "Italian", pl: "Polish", nl: "Dutch",
  ja: "Japanese", ko: "Korean", tr: "Turkish", vi: "Vietnamese",
  id: "Indonesian", th: "Thai", sv: "Swedish",
};

const LPROJ_FOLDERS: Record<Locale, string> = {
  en: "en", cs: "cs", de: "de", es: "es", fr: "fr", pt: "pt-BR",
  ru: "ru", uk: "uk", zh: "zh-Hans", hi: "hi", ar: "ar", it: "it",
  pl: "pl", nl: "nl", ja: "ja", ko: "ko", tr: "tr", vi: "vi",
  id: "id", th: "th", sv: "sv",
};

const KEY_COMMENTS: Record<string, string> = {
  NSCameraUsageDescription: "Camera - Required for food photos",
  NSFaceIDUsageDescription: "Face ID - Biometric authentication",
  NSLocationAlwaysAndWhenInUseUsageDescription: "Location (Always) - Nearby food notifications",
  NSLocationWhenInUseUsageDescription: "Location (When In Use) - Find nearby food",
  NSMicrophoneUsageDescription: "Microphone - Voice search",
  NSPhotoLibraryUsageDescription: "Photo Library - Select food images",
  NSSpeechRecognitionUsageDescription: "Speech Recognition - Voice commands",
};

interface GenerateRequest {
  strings: Record<string, string>;
  skipCache?: boolean;
}

interface LocaleResult {
  locale: string;
  translations: Record<string, string>;
  cached: boolean;
  duration: number;
  error?: string;
}

interface GenerateResponse {
  success: boolean;
  version: string;
  locales: Record<string, Record<string, string>>;
  files: Record<string, string>;
  lprojFolders: Record<string, string>;
  stats: {
    totalLocales: number;
    totalStrings: number;
    fromCache: number;
    translated: number;
    failed: number;
    durationMs: number;
  };
  errors: string[];
}

/**
 * Generate content hash for cache invalidation
 */
function hashContent(strings: Record<string, string>): string {
  const sorted = Object.entries(strings).sort(([a], [b]) => a.localeCompare(b));
  const content = JSON.stringify(sorted);
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check cache for existing translations
 */
async function getCachedTranslations(
  contentHash: string,
  locale: string
): Promise<Record<string, string> | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from(CACHE_TABLE)
      .select("translations")
      .eq("content_hash", contentHash)
      .eq("locale", locale)
      .single();

    if (error || !data) return null;
    return data.translations as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Store translations in cache
 */
async function cacheTranslations(
  contentHash: string,
  locale: string,
  translations: Record<string, string>
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    await supabase.from(CACHE_TABLE).upsert({
      content_hash: contentHash,
      locale,
      translations,
      updated_at: new Date().toISOString(),
    }, { onConflict: "content_hash,locale" });
  } catch (e) {
    logger.warn("Cache write failed", { locale, error: (e as Error).message });
  }
}

/**
 * Format as InfoPlist.strings file
 */
function formatInfoPlistStrings(locale: string, strings: Record<string, string>): string {
  const lines = [
    `/* Localized Info.plist - ${LOCALE_NAMES[locale as Locale] || locale} */`,
    `/* Generated: ${new Date().toISOString()} */`,
    "",
  ];

  const sortedKeys = Object.keys(strings).sort();
  for (const key of sortedKeys) {
    const comment = KEY_COMMENTS[key];
    if (comment) lines.push(`/* ${comment} */`);
    const escaped = strings[key].replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(`"${key}" = "${escaped}";`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Translate all strings for a locale with batch optimization
 */
async function translateLocale(
  strings: Record<string, string>,
  targetLocale: string,
  contentHash: string,
  skipCache: boolean
): Promise<LocaleResult> {
  const start = performance.now();

  // Check cache first
  if (!skipCache) {
    const cached = await getCachedTranslations(contentHash, targetLocale);
    if (cached && Object.keys(cached).length === Object.keys(strings).length) {
      return {
        locale: targetLocale,
        translations: cached,
        cached: true,
        duration: Math.round(performance.now() - start),
      };
    }
  }

  // Translate all strings in parallel with concurrency limit
  const entries = Object.entries(strings);
  const translations: Record<string, string> = {};
  const errors: string[] = [];

  // Process in batches of 3 to avoid overwhelming the LLM service
  const BATCH_SIZE = 3;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async ([key, value]) => {
        const result = await llmTranslationService.translate(
          value,
          "en",
          targetLocale,
          `iOS permission dialog for "${key}". Keep "Foodshare" untranslated. Clear, friendly tone.`
        );
        return { key, translation: result.text, quality: result.quality };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { key, translation, quality } = result.value;
        translations[key] = quality > 0.5 ? translation : strings[key];
      } else {
        const key = batch[results.indexOf(result)][0];
        errors.push(`${key}: ${result.reason}`);
        translations[key] = strings[key]; // Fallback to English
      }
    }
  }

  // Cache successful translations
  if (errors.length === 0) {
    await cacheTranslations(contentHash, targetLocale, translations);
  }

  return {
    locale: targetLocale,
    translations,
    cached: false,
    duration: Math.round(performance.now() - start),
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

/**
 * Process locales with controlled concurrency
 */
async function processLocalesParallel(
  strings: Record<string, string>,
  contentHash: string,
  skipCache: boolean
): Promise<LocaleResult[]> {
  const results: LocaleResult[] = [];
  const queue = [...TARGET_LOCALES];

  // Process with concurrency limit
  const workers = Array(CONCURRENCY_LIMIT).fill(null).map(async () => {
    while (queue.length > 0) {
      const locale = queue.shift();
      if (!locale) break;

      try {
        const result = await translateLocale(strings, locale, contentHash, skipCache);
        results.push(result);
        logger.info("Locale complete", {
          locale,
          cached: result.cached,
          duration: result.duration,
        });
      } catch (e) {
        results.push({
          locale,
          translations: { ...strings }, // Fallback
          cached: false,
          duration: 0,
          error: (e as Error).message,
        });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export default async function generateInfoPlistStringsHandler(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = performance.now();
  const requestId = crypto.randomUUID().slice(0, 8);

  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "method_not_allowed",
      message: "Use POST",
    }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json() as GenerateRequest;
    const { strings, skipCache = false } = body;

    // Validate input
    if (!strings || typeof strings !== "object" || Object.keys(strings).length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "invalid_request",
        message: "strings object is required with at least one key",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const stringCount = Object.keys(strings).length;
    const contentHash = hashContent(strings);

    logger.info("Starting InfoPlist generation", {
      requestId,
      stringCount,
      localeCount: ALL_LOCALES.length,
      contentHash,
      skipCache,
    });

    // Initialize with English (source)
    const locales: Record<string, Record<string, string>> = { en: { ...strings } };
    const files: Record<string, string> = { en: formatInfoPlistStrings("en", strings) };
    const errors: string[] = [];

    // Translate all other locales in parallel
    const results = await processLocalesParallel(strings, contentHash, skipCache);

    let fromCache = 0;
    let translated = 0;
    let failed = 0;

    for (const result of results) {
      locales[result.locale] = result.translations;
      files[result.locale] = formatInfoPlistStrings(result.locale, result.translations);

      if (result.cached) {
        fromCache++;
      } else if (result.error) {
        failed++;
        errors.push(`${result.locale}: ${result.error}`);
      } else {
        translated++;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    const response: GenerateResponse = {
      success: true,
      version: VERSION,
      locales,
      files,
      lprojFolders: LPROJ_FOLDERS,
      stats: {
        totalLocales: ALL_LOCALES.length,
        totalStrings: stringCount,
        fromCache,
        translated,
        failed,
        durationMs,
      },
      errors,
    };

    logger.info("InfoPlist generation complete", {
      requestId,
      ...response.stats,
    });

    return new Response(JSON.stringify(response), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-Duration-Ms": durationMs.toString(),
      },
    });

  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    logger.error("InfoPlist generation failed", {
      requestId,
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    return new Response(JSON.stringify({
      success: false,
      error: "generation_failed",
      message: (error as Error).message,
      requestId,
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-Duration-Ms": durationMs.toString(),
      },
    });
  }
}
