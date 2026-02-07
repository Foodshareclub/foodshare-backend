/**
 * UI Strings Handler
 * High-performance translation delivery for static UI strings
 *
 * Features:
 * - Multi-level caching (Edge, Memory, Database)
 * - Compression (gzip)
 * - ETag support for conditional requests
 * - Rate limiting
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getCorsHeaders } from "../../_shared/cors.ts";

// ============================================================================
// Types
// ============================================================================

interface TranslationResponse {
  locale: string;
  messages: Record<string, string>;
  version: string;
  platform: string;
  cached: boolean;
  compressed: boolean;
  etag: string;
}

interface CacheEntry {
  data: Uint8Array;
  etag: string;
  timestamp: number;
  locale: string;
  platform: string;
}

// ============================================================================
// Configuration
// ============================================================================

const SUPPORTED_LOCALES = [
  "en", "cs", "de", "es", "fr", "pt", "ru", "uk", "zh", "hi",
  "ar", "it", "pl", "nl", "ja", "ko", "tr", "vi", "id", "th", "sv"
];

const DEFAULT_LOCALE = "en";
const CACHE_TTL_MS = 3600000; // 1 hour
const MAX_CACHE_SIZE = 100;
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const RATE_LIMIT_MAX_REQUESTS = 1000;

// In-memory cache (Edge runtime)
const memoryCache = new Map<string, CacheEntry>();

// ============================================================================
// Utilities
// ============================================================================

function normalizeLocale(locale: string): string {
  const normalized = locale.split("-")[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

function getCacheKey(locale: string, platform: string): string {
  return `translations:${locale}:${platform}`;
}

function generateETag(content: string | Uint8Array): string {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data[i];
    hash = hash & hash;
  }
  return `"${Math.abs(hash).toString(36)}"`;
}

async function compressData(data: string): Promise<Uint8Array> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip"));

  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      memoryCache.delete(key);
    }
  }

  if (memoryCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(memoryCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, memoryCache.size - MAX_CACHE_SIZE);
    toDelete.forEach(([key]) => memoryCache.delete(key));
  }
}

async function checkRateLimit(
  supabase: SupabaseClient,
  identifier: string
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("rate_limits")
      .select("request_count, window_start")
      .eq("identifier", identifier)
      .single();

    if (error && error.code !== "PGRST116") {
      logger.error("Rate limit check error", error as Error);
      return true;
    }

    const now = new Date();
    const windowStart = data?.window_start ? new Date(data.window_start) : now;
    const windowAge = (now.getTime() - windowStart.getTime()) / 1000;

    if (!data || windowAge > RATE_LIMIT_WINDOW) {
      await supabase.from("rate_limits").upsert({
        identifier,
        request_count: 1,
        window_start: now.toISOString(),
      });
      return true;
    }

    if (data.request_count >= RATE_LIMIT_MAX_REQUESTS) {
      return false;
    }

    await supabase
      .from("rate_limits")
      .update({ request_count: data.request_count + 1 })
      .eq("identifier", identifier);

    return true;
  } catch {
    return true; // Allow on error
  }
}

// ============================================================================
// Handler
// ============================================================================

export default async function uiStringsHandler(req: Request): Promise<Response> {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 204 });
  }

  try {
    const supabase = getSupabaseClient();

    const url = new URL(req.url);
    const locale = normalizeLocale(url.searchParams.get("locale") || DEFAULT_LOCALE);
    const platform = url.searchParams.get("platform") || "web";
    const clientETag = req.headers.get("if-none-match");
    const ipAddress = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");

    // Rate limiting
    const identifier = ipAddress || "anonymous";
    const rateLimitOk = await checkRateLimit(supabase, identifier);

    if (!rateLimitOk) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": "3600",
        },
      });
    }

    // Check memory cache
    cleanExpiredCache();
    const cacheKey = getCacheKey(locale, platform);
    const cachedEntry = memoryCache.get(cacheKey);

    if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL_MS) {
      if (clientETag && clientETag === cachedEntry.etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ...corsHeaders,
            ETag: cachedEntry.etag,
            "Cache-Control": "public, max-age=3600",
          },
        });
      }

      return new Response(cachedEntry.data, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          ETag: cachedEntry.etag,
          "Cache-Control": "public, max-age=3600",
          "X-Cache": "HIT",
        },
      });
    }

    // Fetch from database
    const { data: translation, error: dbError } = await supabase
      .from("translations")
      .select("locale, messages, version")
      .eq("locale", locale)
      .single();

    if (dbError || !translation) {
      // Fallback to English
      const { data: fallbackTranslation, error: fallbackError } = await supabase
        .from("translations")
        .select("locale, messages, version")
        .eq("locale", DEFAULT_LOCALE)
        .single();

      if (fallbackError || !fallbackTranslation) {
        return new Response(JSON.stringify({ error: "Translation not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const responseData: TranslationResponse = {
        locale: fallbackTranslation.locale,
        messages: fallbackTranslation.messages,
        version: fallbackTranslation.version,
        platform,
        cached: false,
        compressed: true,
        etag: "",
      };

      const jsonData = JSON.stringify(responseData);
      const compressedData = await compressData(jsonData);
      const etag = generateETag(compressedData);
      responseData.etag = etag;

      memoryCache.set(cacheKey, {
        data: compressedData,
        etag,
        timestamp: Date.now(),
        locale: fallbackTranslation.locale,
        platform,
      });

      return new Response(compressedData, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          ETag: etag,
          "Cache-Control": "public, max-age=3600",
          "X-Cache": "MISS",
          "X-Fallback": "true",
        },
      });
    }

    const responseData: TranslationResponse = {
      locale: translation.locale,
      messages: translation.messages,
      version: translation.version,
      platform,
      cached: false,
      compressed: true,
      etag: "",
    };

    const jsonData = JSON.stringify(responseData);
    const compressedData = await compressData(jsonData);
    const etag = generateETag(compressedData);
    responseData.etag = etag;

    if (clientETag && clientETag === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ...corsHeaders,
          ETag: etag,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    memoryCache.set(cacheKey, {
      data: compressedData,
      etag,
      timestamp: Date.now(),
      locale: translation.locale,
      platform,
    });

    return new Response(compressedData, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        ETag: etag,
        "Cache-Control": "public, max-age=3600",
        "X-Cache": "MISS",
      },
    });
  } catch (error) {
    logger.error("UI strings error", error as Error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}
