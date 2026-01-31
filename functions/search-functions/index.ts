/**
 * Search Functions Edge Function
 *
 * Features:
 * - Multi-level caching (Memory + Database)
 * - Fuzzy search with ranking
 * - Rate limiting
 * - Performance monitoring
 * - Compression
 *
 * Usage:
 * GET /search-functions?q=searchTerm&includeSource=true&limit=50
 * POST /search-functions { "searchString": "term", "includeSource": false, "limit": 50 }
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "3.0.0",
  cacheTTL: 300000, // 5 minutes
  maxCacheSize: 100,
};

// =============================================================================
// In-Memory Cache
// =============================================================================

const searchCache = new Map<
  string,
  {
    results: SearchResult[];
    timestamp: number;
    hits: number;
  }
>();

// Clean cache every 2 minutes
setInterval(() => {
  const now = Date.now();

  // Remove expired entries
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > CONFIG.cacheTTL) {
      searchCache.delete(key);
    }
  }

  // If still too large, remove least used
  if (searchCache.size > CONFIG.maxCacheSize) {
    const sorted = Array.from(searchCache.entries()).sort((a, b) => a[1].hits - b[1].hits);
    const toRemove = sorted.slice(0, searchCache.size - CONFIG.maxCacheSize);
    toRemove.forEach(([key]) => searchCache.delete(key));
  }
}, 120000);

// =============================================================================
// Request Schema
// =============================================================================

const searchQuerySchema = z.object({
  q: z.string().optional(),
  search: z.string().optional(),
  includeSource: z.enum(["true", "false"]).optional(),
  limit: z.string().optional(),
});

const searchBodySchema = z.object({
  searchString: z.string().optional(),
  includeSource: z.boolean().optional(),
  limit: z.number().optional(),
}).optional();

type SearchQuery = z.infer<typeof searchQuerySchema>;
type SearchBody = z.infer<typeof searchBodySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface MatchingLine {
  text: string;
  lineNumber: number;
  relevance: number;
}

interface SearchResult {
  name: string;
  type: string;
  relevance: number;
  matchCount: number;
  matchingLines: MatchingLine[];
  fullSource?: string;
}

interface SearchResponse {
  success: boolean;
  version: string;
  query: string;
  results: {
    triggerFunctions: SearchResult[];
    edgeFunctions: never[];
  };
  summary: {
    totalResults: number;
    triggerFunctions: number;
  };
  responseTime: number;
  requestId: string;
  cached: boolean;
}

// =============================================================================
// Search Logic
// =============================================================================

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
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  searchString: string,
  includeSource: boolean,
  limit: number
): Promise<SearchResult[]> {
  // Try database cache first
  const cacheKey = `search:${searchString}:${includeSource}:${limit}`;

  const { data: cachedData } = await supabase
    .from("search_cache")
    .select("results, created_at")
    .eq("cache_key", cacheKey)
    .gte("created_at", new Date(Date.now() - CONFIG.cacheTTL).toISOString())
    .single();

  if (cachedData) {
    return cachedData.results as SearchResult[];
  }

  // Perform search
  const { data, error } = await supabase.rpc("search_trigger_functions", {
    search_string: searchString,
  });

  if (error) throw error;

  const results = (data || [])
    .map((func: { proname: string; prosrc: string }) => {
      const matchingLines = func.prosrc
        .split("\n")
        .map((line: string, idx: number) => ({
          line: line.trim(),
          lineNumber: idx + 1,
          relevance: calculateRelevance(line, searchString),
        }))
        .filter((item: { relevance: number }) => item.relevance > 0)
        .sort((a: { relevance: number }, b: { relevance: number }) => b.relevance - a.relevance)
        .slice(0, 10);

      const nameRelevance = calculateRelevance(func.proname, searchString);

      return {
        name: func.proname,
        type: "trigger_function",
        relevance: Math.max(nameRelevance, ...matchingLines.map((l: { relevance: number }) => l.relevance)),
        matchCount: matchingLines.length,
        matchingLines: matchingLines.map((item: { line: string; lineNumber: number; relevance: number }) => ({
          text: item.line,
          lineNumber: item.lineNumber,
          relevance: item.relevance,
        })),
        ...(includeSource && { fullSource: func.prosrc }),
      };
    })
    .sort((a: SearchResult, b: SearchResult) => b.relevance - a.relevance)
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
    .catch((err: Error) => logger.warn("Cache write failed", { error: err.message }));

  return results;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleSearch(
  ctx: HandlerContext<SearchBody, SearchQuery>
): Promise<Response> {
  const { supabase, body, query, ctx: requestCtx, request } = ctx;
  const startTime = performance.now();

  // Determine search parameters from query or body
  let searchString: string;
  let includeSource = false;
  let limit = 50;

  if (request.method === "GET") {
    searchString = query?.q || query?.search || "";
    includeSource = query?.includeSource === "true";
    limit = parseInt(query?.limit || "50");
  } else {
    searchString = body?.searchString || "";
    includeSource = body?.includeSource || false;
    limit = body?.limit || 50;
  }

  // Validation
  if (!searchString) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing search string" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (searchString.length > 500) {
    return new Response(
      JSON.stringify({ success: false, error: "Search string too long (max 500 chars)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (limit < 1 || limit > 100) limit = 50;

  logger.info("Searching functions", {
    query: searchString.substring(0, 50),
    includeSource,
    limit,
    requestId: requestCtx?.requestId,
  });

  // Check memory cache
  const cacheKey = `${searchString}:${includeSource}:${limit}`;
  const cached = searchCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
    cached.hits++;

    const response: SearchResponse = {
      success: true,
      version: CONFIG.version,
      query: searchString,
      results: {
        triggerFunctions: cached.results,
        edgeFunctions: [],
      },
      summary: {
        totalResults: cached.results.length,
        triggerFunctions: cached.results.length,
      },
      responseTime: Math.round(performance.now() - startTime),
      requestId: requestCtx?.requestId || "",
      cached: true,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "X-Cache": "HIT",
        "X-Version": CONFIG.version,
      },
    });
  }

  // Perform search
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

  const response: SearchResponse = {
    success: true,
    version: CONFIG.version,
    query: searchString,
    results: {
      triggerFunctions,
      edgeFunctions: [],
    },
    summary: {
      totalResults: triggerFunctions.length,
      triggerFunctions: triggerFunctions.length,
    },
    responseTime: Math.round(performance.now() - startTime),
    requestId: requestCtx?.requestId || "",
    cached: false,
  };

  // Handle compression
  const acceptEncoding = request.headers.get("Accept-Encoding");
  if (acceptEncoding?.includes("gzip")) {
    const responseBody = JSON.stringify(response);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseBody));
        controller.close();
      },
    });

    const compressed = stream.pipeThrough(new CompressionStream("gzip"));

    return new Response(compressed, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=300",
        "X-Cache": "MISS",
        "X-Version": CONFIG.version,
        "X-Response-Time": `${Math.round(performance.now() - startTime)}ms`,
      },
    });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "X-Cache": "MISS",
      "X-Version": CONFIG.version,
      "X-Response-Time": `${Math.round(performance.now() - startTime)}ms`,
    },
  });
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "search-functions",
  version: CONFIG.version,
  requireAuth: false, // Public search endpoint
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 requests per minute
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema: searchQuerySchema,
      handler: handleSearch,
    },
    POST: {
      schema: searchBodySchema,
      querySchema: searchQuerySchema,
      handler: handleSearch,
    },
  },
});
