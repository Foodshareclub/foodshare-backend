/**
 * Enterprise Dynamic Content Translation Handler
 *
 * Translates user-generated content (forum posts, challenges, listings)
 * using self-hosted LLM at translate.foodshare.club
 *
 * Features:
 * - 3-layer caching: Memory → Database → LLM
 * - Content-hash deduplication
 * - Stale-while-revalidate
 * - Quality tracking
 * - Analytics
 * - Batch support
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";
import { getCorsHeaders } from "../../_shared/cors.ts";
import { logger } from "../../_shared/logger.ts";
import { llmTranslationService } from "../services/llm-translation.ts";

// In-memory cache (L1)
const memoryCache = new Map<string, {
  text: string;
  quality: number;
  timestamp: number;
}>();
const MEMORY_TTL = 3600000; // 1 hour
const MAX_MEMORY_SIZE = 10000;

// Supported locales (21 languages)
const SUPPORTED_LOCALES = [
  "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi", "ar",
  "it", "pl", "nl", "ja", "ko", "tr", "sv", "vi", "id", "th"
];

interface TranslateRequest {
  text: string;
  targetLocale: string;
  contentType?: string;
  batch?: { texts: string[] };
}

interface TranslateResponse {
  success: boolean;
  translatedText?: string;
  translations?: string[];
  cached: boolean;
  cacheLayer?: "memory" | "database" | "llm";
  quality: number;
  responseTimeMs: number;
}

export default async function translateContentHandler(req: Request): Promise<Response> {
  const startTime = performance.now();
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      success: false,
      error: "Method not allowed"
    }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const body: TranslateRequest = await req.json();
    const { text, targetLocale, contentType = "general", batch } = body;

    // Validate locale
    if (!SUPPORTED_LOCALES.includes(targetLocale)) {
      return new Response(JSON.stringify({
        success: false,
        error: `Unsupported locale: ${targetLocale}`,
        supportedLocales: SUPPORTED_LOCALES
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Handle batch translation
    if (batch?.texts && batch.texts.length > 0) {
      const translations = await translateBatch(batch.texts, targetLocale, contentType);
      return new Response(JSON.stringify({
        success: true,
        translations,
        cached: false,
        quality: 0.95,
        responseTimeMs: Math.round(performance.now() - startTime)
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Validate single text
    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "Text is required"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // L1: Check memory cache
    const cacheKey = `${targetLocale}:${hashText(text)}`;
    const memoryCached = memoryCache.get(cacheKey);
    if (memoryCached && Date.now() - memoryCached.timestamp < MEMORY_TTL) {
      logger.debug("Translation cache hit (memory)", { locale: targetLocale });
      return new Response(JSON.stringify({
        success: true,
        translatedText: memoryCached.text,
        cached: true,
        cacheLayer: "memory",
        quality: memoryCached.quality,
        responseTimeMs: Math.round(performance.now() - startTime)
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // L2: Check database cache
    const supabase = getSupabaseClient();

    const { data: dbResult, error: dbError } = await supabase.rpc("get_or_translate", {
      p_source_text: text,
      p_target_locale: targetLocale,
      p_content_type: contentType
    });

    if (dbError) {
      logger.warn("Database cache lookup error", dbError);
      // Continue to LLM if database fails
    }

    if (dbResult?.[0]?.cache_hit) {
      const translatedText = dbResult[0].translated_text;
      const quality = dbResult[0].quality_score || 0.95;

      // Promote to memory cache
      updateMemoryCache(cacheKey, translatedText, quality);

      logger.debug("Translation cache hit (database)", { locale: targetLocale });
      return new Response(JSON.stringify({
        success: true,
        translatedText,
        cached: true,
        cacheLayer: "database",
        quality,
        responseTimeMs: Math.round(performance.now() - startTime)
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // L3: Call LLM (with fallback chain: LLM → DeepL → Google → Microsoft → Amazon)
    logger.debug("Translation cache miss, calling LLM", { locale: targetLocale, contentType });
    const llmResult = await llmTranslationService.translate(text, "en", targetLocale, contentType);

    // Determine cache layer from service used
    const cacheLayer = llmResult.service === 'llm' ? 'llm' :
                       llmResult.service === 'none' ? 'failed' :
                       llmResult.service || 'llm';

    // Only cache high-quality translations (quality > 0.5)
    // This prevents cache poisoning from failed/low-quality translations
    if (llmResult.quality > 0.5) {
      // Store in database cache (fire and forget)
      (async () => {
        try {
          await supabase.rpc("store_translation", {
            p_source_text: text,
            p_translated_text: llmResult.text,
            p_target_locale: targetLocale,
            p_content_type: contentType,
            p_quality_score: llmResult.quality
          });
          logger.debug("Translation stored in database cache", { service: llmResult.service });
        } catch (err) {
          logger.warn("Failed to store translation", err as Error);
        }
      })();

      // Store in memory cache
      updateMemoryCache(cacheKey, llmResult.text, llmResult.quality);
    } else {
      logger.warn("Translation quality too low, not caching", { quality: llmResult.quality.toFixed(2), service: llmResult.service });
    }

    // Track analytics (fire and forget)
    (async () => {
      try {
        await supabase.from("translation_usage_analytics").insert({
          target_locale: targetLocale,
          content_type: contentType,
          cache_hit: false,
          response_time_ms: Math.round(performance.now() - startTime),
          tokens_used: llmResult.tokensUsed
        });
      } catch (err) {
        logger.warn("Failed to track analytics", { error: (err as Error).message });
      }
    })();

    // Return actual success status from LLM service
    const success = llmResult.success !== false && llmResult.quality > 0;

    return new Response(JSON.stringify({
      success,
      translatedText: llmResult.text,
      cached: false,
      cacheLayer,
      quality: llmResult.quality,
      service: llmResult.service,
      responseTimeMs: Math.round(performance.now() - startTime),
      ...(llmResult.error && { error: llmResult.error.message || 'Translation failed' })
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    logger.error("Translation error", { error: (error as Error).message });
    return new Response(JSON.stringify({
      success: false,
      error: (error as Error).message
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}

/**
 * Simple hash function for cache keys
 */
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Update memory cache with LRU eviction
 */
function updateMemoryCache(key: string, text: string, quality: number): void {
  if (memoryCache.size >= MAX_MEMORY_SIZE) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(key, { text, quality, timestamp: Date.now() });
}

/**
 * Batch translate multiple texts
 */
async function translateBatch(
  texts: string[],
  targetLocale: string,
  contentType: string
): Promise<string[]> {
  return llmTranslationService.batchTranslate(texts, "en", targetLocale, contentType);
}
