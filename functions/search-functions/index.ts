/**
 * Search Functions - Optimized
 *
 * Features:
 * - Multi-level caching (Memory + Database)
 * - Fuzzy search with ranking
 * - Rate limiting
 * - Performance monitoring
 * - Compression
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "3.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// In-memory cache for hot searches
const searchCache = new Map<
  string,
  {
    results: any;
    timestamp: number;
    hits: number;
  }
>();

const CACHE_TTL = 300000; // 5 minutes
const MAX_CACHE_SIZE = 100;

// Rate limiting
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 30;

function createSupabaseClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "x-application-name": "foodshare-search",
      },
    },
  });
}

/**
 * Check rate limit
 */
function checkRateLimit(clientId: string): boolean {
  const now = Date.now();
  const limit = rateLimitStore.get(clientId);

  if (!limit || now > limit.resetAt) {
    rateLimitStore.set(clientId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW,
    });
    return true;
  }

  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }

  limit.count++;
  return true;
}

/**
 * Clean expired cache entries
 */
function cleanCache() {
  const now = Date.now();

  // Remove expired entries
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      searchCache.delete(key);
    }
  }

  // If still too large, remove least used
  if (searchCache.size > MAX_CACHE_SIZE) {
    const sorted = Array.from(searchCache.entries()).sort((a, b) => a[1].hits - b[1].hits);

    const toRemove = sorted.slice(0, searchCache.size - MAX_CACHE_SIZE);
    toRemove.forEach(([key]) => searchCache.delete(key));
  }

  // Clean rate limit store
  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean cache every 2 minutes
setInterval(cleanCache, 120000);

/**
 * Calculate relevance score for fuzzy matching
 */
function calculateRelevance(text: string, search: string): number {
  const lowerText = text.toLowerCase();
  const lowerSearch = search.toLowerCase();

  // Exact match = highest score
  if (lowerText === lowerSearch) return 100;

  // Starts with = high score
  if (lowerText.startsWith(lowerSearch)) return 90;

  // Contains as word = medium-high score
  if (new RegExp(`\\b${lowerSearch}\\b`).test(lowerText)) return 80;

  // Contains anywhere = medium score
  if (lowerText.includes(lowerSearch)) return 70;

  // Fuzzy match = lower score
  let score = 0;
  let searchIndex = 0;
  for (let i = 0; i < lowerText.length && searchIndex < lowerSearch.length; i++) {
    if (lowerText[i] === lowerSearch[searchIndex]) {
      score += 50 / lowerSearch.length;
      searchIndex++;
    }
  }

  return searchIndex === lowerSearch.length ? score : 0;
}

async function searchTriggerFunctions(
  supabase: any,
  searchString: string,
  includeSource: boolean,
  limit: number
) {
  // Try database cache first
  const cacheKey = `search:${searchString}:${includeSource}:${limit}`;

  const { data: cachedData } = await supabase
    .from("search_cache")
    .select("results, created_at")
    .eq("cache_key", cacheKey)
    .gte("created_at", new Date(Date.now() - CACHE_TTL).toISOString())
    .single();

  if (cachedData) {
    return cachedData.results;
  }

  // Perform search
  const { data, error } = await supabase.rpc("search_trigger_functions", {
    search_string: searchString,
  });

  if (error) throw error;

  const results = (data || [])
    .map((func: any) => {
      const matchingLines = func.prosrc
        .split("\n")
        .map((line: string, idx: number) => ({
          line: line.trim(),
          lineNumber: idx + 1,
          relevance: calculateRelevance(line, searchString),
        }))
        .filter((item: any) => item.relevance > 0)
        .sort((a: any, b: any) => b.relevance - a.relevance)
        .slice(0, 10);

      const nameRelevance = calculateRelevance(func.proname, searchString);

      return {
        name: func.proname,
        type: "trigger_function",
        relevance: Math.max(nameRelevance, ...matchingLines.map((l: any) => l.relevance)),
        matchCount: matchingLines.length,
        matchingLines: matchingLines.map((item: any) => ({
          text: item.line,
          lineNumber: item.lineNumber,
          relevance: item.relevance,
        })),
        ...(includeSource && { fullSource: func.prosrc }),
      };
    })
    .sort((a: any, b: any) => b.relevance - a.relevance)
    .slice(0, limit);

  // Cache results in database (fire and forget)
  supabase
    .from("search_cache")
    .upsert({
      cache_key: cacheKey,
      results,
      created_at: new Date().toISOString(),
    })
    .then(() => {})
    .catch((err: any) => console.warn("Cache write failed:", err));

  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const start = Date.now();
  const requestId = crypto.randomUUID();

  try {
    // Rate limiting
    const clientId = req.headers.get("x-forwarded-for") || "unknown";
    if (!checkRateLimit(clientId)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Rate limit exceeded",
          retryAfter: 60,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": "60",
          },
        }
      );
    }

    const url = new URL(req.url);
    let searchString: string;
    let includeSource = false;
    let limit = 50;

    if (req.method === "GET") {
      searchString = url.searchParams.get("q") || url.searchParams.get("search") || "";
      includeSource = url.searchParams.get("includeSource") === "true";
      limit = parseInt(url.searchParams.get("limit") || "50");
    } else {
      const body = await req.json();
      searchString = body.searchString || "";
      includeSource = body.includeSource || false;
      limit = body.limit || 50;
    }

    // Validation
    if (!searchString) {
      return new Response(JSON.stringify({ success: false, error: "Missing search string" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (searchString.length > 500) {
      return new Response(
        JSON.stringify({ success: false, error: "Search string too long (max 500 chars)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (limit < 1 || limit > 100) limit = 50;

    // Check memory cache
    const cacheKey = `${searchString}:${includeSource}:${limit}`;
    const cached = searchCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      cached.hits++;

      return new Response(
        JSON.stringify({
          success: true,
          version: VERSION,
          query: searchString,
          results: {
            triggerFunctions: cached.results,
            edgeFunctions: [],
          },
          summary: {
            totalResults: cached.results.length,
            triggerFunctions: cached.results.length,
          },
          responseTime: Date.now() - start,
          requestId,
          cached: true,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=300",
            "X-Request-Id": requestId,
            "X-Version": VERSION,
            "X-Cache": "HIT",
          },
        }
      );
    }

    // Perform search
    const supabase = createSupabaseClient();
    const triggerFunctions = await searchTriggerFunctions(
      supabase,
      searchString,
      includeSource,
      limit
    );

    // Cache in memory
    searchCache.set(cacheKey, {
      results: triggerFunctions,
      timestamp: Date.now(),
      hits: 1,
    });

    // Compress response if supported
    const responseBody = JSON.stringify({
      success: true,
      version: VERSION,
      query: searchString,
      results: {
        triggerFunctions,
        edgeFunctions: [],
      },
      summary: {
        totalResults: triggerFunctions.length,
        triggerFunctions: triggerFunctions.length,
      },
      responseTime: Date.now() - start,
      requestId,
      cached: false,
    });

    const headers = new Headers({
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "X-Request-Id": requestId,
      "X-Version": VERSION,
      "X-Cache": "MISS",
      "X-Response-Time": `${Date.now() - start}ms`,
    });

    // Add compression if supported
    const acceptEncoding = req.headers.get("Accept-Encoding");
    if (acceptEncoding?.includes("gzip")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(responseBody));
          controller.close();
        },
      });

      const compressed = stream.pipeThrough(new CompressionStream("gzip"));
      headers.set("Content-Encoding", "gzip");

      return new Response(compressed, { status: 200, headers });
    }

    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "internal_server_error",
        requestId,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
