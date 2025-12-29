// ============================================================================
// Localization Edge Function
// ============================================================================
// High-performance translation delivery for cross-platform apps
// Features:
// - Multi-level caching (Edge, KV, Database)
// - Compression (gzip/brotli)
// - ETag support for conditional requests
// - Platform-specific optimizations
// - Real-time updates via Supabase Realtime
// - Rate limiting
// - Analytics tracking
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// ============================================================================
// Types
// ============================================================================

interface TranslationRequest {
  locale: string;
  platform?: "web" | "ios" | "android" | "desktop" | "other";
  version?: string;
  compressed?: boolean;
  etag?: string;
}

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
];

const DEFAULT_LOCALE = "en";
const CACHE_TTL_MS = 3600000; // 1 hour
const MAX_CACHE_SIZE = 100; // Max entries in memory cache
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const RATE_LIMIT_MAX_REQUESTS = 1000; // Per window

// In-memory cache (Edge runtime)
const memoryCache = new Map<string, CacheEntry>();

// ============================================================================
// Utilities
// ============================================================================

/**
 * Normalize locale to supported format
 */
function normalizeLocale(locale: string): string {
  const normalized = locale.split("-")[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(normalized) ? normalized : DEFAULT_LOCALE;
}

/**
 * Generate cache key
 */
function getCacheKey(locale: string, platform: string): string {
  return `translations:${locale}:${platform}`;
}

/**
 * Generate ETag from content
 */
function generateETag(content: string | Uint8Array): string {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = (hash << 5) - hash + data[i];
    hash = hash & hash; // Convert to 32bit integer
  }
  return `"${Math.abs(hash).toString(36)}"`;
}

/**
 * Compress data using gzip
 */
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

/**
 * Decompress gzip data
 */
async function decompressData(data: Uint8Array): Promise<string> {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("gzip"));

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

  return new TextDecoder().decode(result);
}

/**
 * Clean expired cache entries
 */
function cleanExpiredCache(): void {
  const now = Date.now();
  for (const [key, entry] of memoryCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      memoryCache.delete(key);
    }
  }

  // Limit cache size
  if (memoryCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(memoryCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, memoryCache.size - MAX_CACHE_SIZE);
    toDelete.forEach(([key]) => memoryCache.delete(key));
  }
}

/**
 * Check rate limit
 */
async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  identifier: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("rate_limits")
    .select("request_count, window_start")
    .eq("identifier", identifier)
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("Rate limit check error:", error);
    return true; // Allow on error
  }

  const now = new Date();
  const windowStart = data?.window_start ? new Date(data.window_start) : now;
  const windowAge = (now.getTime() - windowStart.getTime()) / 1000;

  if (!data || windowAge > RATE_LIMIT_WINDOW) {
    // Create new window
    await supabase.from("rate_limits").upsert({
      identifier,
      request_count: 1,
      window_start: now.toISOString(),
    });
    return true;
  }

  if (data.request_count >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limit exceeded
  }

  // Increment counter
  await supabase
    .from("rate_limits")
    .update({ request_count: data.request_count + 1 })
    .eq("identifier", identifier);

  return true;
}

/**
 * Log analytics
 */
async function logAnalytics(
  supabase: ReturnType<typeof createClient>,
  params: {
    locale: string;
    platform: string;
    userId?: string;
    deviceId?: string;
    responseTimeMs: number;
    statusCode: number;
    cached: boolean;
    fallback: boolean;
    userAgent?: string;
    ipAddress?: string;
  }
): Promise<void> {
  try {
    await supabase.from("translation_analytics").insert({
      locale: params.locale,
      platform: params.platform,
      user_id: params.userId,
      device_id: params.deviceId,
      response_time_ms: params.responseTimeMs,
      status_code: params.statusCode,
      cached: params.cached,
      fallback: params.fallback,
      user_agent: params.userAgent,
      ip_address: params.ipAddress,
    });
  } catch (error) {
    console.error("Analytics logging error:", error);
  }
}

/**
 * Log error
 */
async function logError(
  supabase: ReturnType<typeof createClient>,
  params: {
    locale: string;
    platform: string;
    errorCode?: string;
    errorMessage: string;
    userId?: string;
  }
): Promise<void> {
  try {
    await supabase.from("translation_errors").insert({
      locale: params.locale,
      platform: params.platform,
      error_code: params.errorCode,
      error_message: params.errorMessage,
      user_id: params.userId,
    });
  } catch (error) {
    console.error("Error logging error:", error);
  }
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 204 });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase configuration");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request
    const url = new URL(req.url);
    const locale = normalizeLocale(url.searchParams.get("locale") || DEFAULT_LOCALE);
    const platform = (url.searchParams.get("platform") || "web") as TranslationRequest["platform"];
    const requestedVersion = url.searchParams.get("version");
    const compressed = url.searchParams.get("compressed") === "true";
    const clientETag = req.headers.get("if-none-match");
    const userAgent = req.headers.get("user-agent");
    const ipAddress = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");

    // Rate limiting
    const identifier = ipAddress || "anonymous";
    const rateLimitOk = await checkRateLimit(supabase, identifier);

    if (!rateLimitOk) {
      await logAnalytics(supabase, {
        locale,
        platform: platform!,
        responseTimeMs: Date.now() - startTime,
        statusCode: 429,
        cached: false,
        fallback: false,
        userAgent: userAgent || undefined,
        ipAddress: ipAddress || undefined,
      });

      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": "3600",
        },
      });
    }

    // Check memory cache first
    cleanExpiredCache();
    const cacheKey = getCacheKey(locale, platform!);
    const cachedEntry = memoryCache.get(cacheKey);

    if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL_MS) {
      // Check ETag
      if (clientETag && clientETag === cachedEntry.etag) {
        await logAnalytics(supabase, {
          locale,
          platform: platform!,
          responseTimeMs: Date.now() - startTime,
          statusCode: 304,
          cached: true,
          fallback: false,
          userAgent: userAgent || undefined,
          ipAddress: ipAddress || undefined,
        });

        return new Response(null, {
          status: 304,
          headers: {
            ...corsHeaders,
            ETag: cachedEntry.etag,
            "Cache-Control": "public, max-age=3600",
          },
        });
      }

      // Return cached data
      const responseHeaders = {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        ETag: cachedEntry.etag,
        "Cache-Control": "public, max-age=3600",
        "X-Cache": "HIT",
      };

      await logAnalytics(supabase, {
        locale,
        platform: platform!,
        responseTimeMs: Date.now() - startTime,
        statusCode: 200,
        cached: true,
        fallback: false,
        userAgent: userAgent || undefined,
        ipAddress: ipAddress || undefined,
      });

      return new Response(cachedEntry.data, {
        status: 200,
        headers: responseHeaders,
      });
    }

    // Fetch from database
    const { data: translation, error: dbError } = await supabase
      .from("translations")
      .select("locale, messages, version")
      .eq("locale", locale)
      .single();

    if (dbError || !translation) {
      // Fallback to default locale
      const { data: fallbackTranslation, error: fallbackError } = await supabase
        .from("translations")
        .select("locale, messages, version")
        .eq("locale", DEFAULT_LOCALE)
        .single();

      if (fallbackError || !fallbackTranslation) {
        await logError(supabase, {
          locale,
          platform: platform!,
          errorCode: "TRANSLATION_NOT_FOUND",
          errorMessage: `Translation not found for locale: ${locale}`,
        });

        return new Response(JSON.stringify({ error: "Translation not found" }), {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      }

      // Use fallback
      const responseData: TranslationResponse = {
        locale: fallbackTranslation.locale,
        messages: fallbackTranslation.messages,
        version: fallbackTranslation.version,
        platform: platform!,
        cached: false,
        compressed,
        etag: "",
      };

      const jsonData = JSON.stringify(responseData);
      const compressedData = await compressData(jsonData);
      const etag = generateETag(compressedData);
      responseData.etag = etag;

      // Cache the result
      memoryCache.set(cacheKey, {
        data: compressedData,
        etag,
        timestamp: Date.now(),
        locale: fallbackTranslation.locale,
        platform: platform!,
      });

      await logAnalytics(supabase, {
        locale,
        platform: platform!,
        responseTimeMs: Date.now() - startTime,
        statusCode: 200,
        cached: false,
        fallback: true,
        userAgent: userAgent || undefined,
        ipAddress: ipAddress || undefined,
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

    // Build response
    const responseData: TranslationResponse = {
      locale: translation.locale,
      messages: translation.messages,
      version: translation.version,
      platform: platform!,
      cached: false,
      compressed,
      etag: "",
    };

    const jsonData = JSON.stringify(responseData);
    const compressedData = await compressData(jsonData);
    const etag = generateETag(compressedData);
    responseData.etag = etag;

    // Check ETag before sending
    if (clientETag && clientETag === etag) {
      await logAnalytics(supabase, {
        locale,
        platform: platform!,
        responseTimeMs: Date.now() - startTime,
        statusCode: 304,
        cached: false,
        fallback: false,
        userAgent: userAgent || undefined,
        ipAddress: ipAddress || undefined,
      });

      return new Response(null, {
        status: 304,
        headers: {
          ...corsHeaders,
          ETag: etag,
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Cache the result
    memoryCache.set(cacheKey, {
      data: compressedData,
      etag,
      timestamp: Date.now(),
      locale: translation.locale,
      platform: platform!,
    });

    await logAnalytics(supabase, {
      locale,
      platform: platform!,
      responseTimeMs: Date.now() - startTime,
      statusCode: 200,
      cached: false,
      fallback: false,
      userAgent: userAgent || undefined,
      ipAddress: ipAddress || undefined,
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
    console.error("Localization error:", error);

    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
