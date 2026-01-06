/**
 * BFF Search Handler
 *
 * Aggregates search functionality:
 * - Full-text and geo-spatial search
 * - Faceted filtering (category, dietary, distance)
 * - Search suggestions and autocomplete
 * - Recent searches and popular queries
 *
 * Reduces client round-trips from 3-4 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";
import type {
  SearchResponse,
  SearchFilters,
  SearchSuggestion,
  ListingSummary,
  PaginationMeta,
} from "../_types/bff-responses.ts";

// =============================================================================
// Request Schema
// =============================================================================

const searchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  lat: z.string().transform(Number).pipe(z.number().min(-90).max(90)).optional(),
  lng: z.string().transform(Number).pipe(z.number().min(-180).max(180)).optional(),
  radiusKm: z.string().transform(Number).pipe(z.number().min(1).max(100)).optional(),
  categoryIds: z.string().transform((s) => s.split(",").map(Number)).optional(),
  dietaryTags: z.string().transform((s) => s.split(",")).optional(),
  sortBy: z.enum(["relevance", "distance", "newest", "expiring"]).optional(),
  status: z.enum(["available", "all"]).optional(),
  page: z.string().transform(Number).pipe(z.number().int().min(1)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  includeSuggestions: z.string().transform((v) => v === "true").optional(),
  includeFacets: z.string().transform((v) => v === "true").optional(),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleSearch(
  ctx: HandlerContext<unknown, SearchQuery>
): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const searchQuery = query.q?.trim() || "";
  const lat = query.lat;
  const lng = query.lng;
  const radiusKm = query.radiusKm ?? 25;
  const categoryIds = query.categoryIds || [];
  const dietaryTags = query.dietaryTags || [];
  const sortBy = query.sortBy ?? "relevance";
  const status = query.status ?? "available";
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const includeSuggestions = query.includeSuggestions ?? true;
  const includeFacets = query.includeFacets ?? true;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  const startTime = Date.now();

  // Call aggregated RPC for search
  const { data, error } = await supabase.rpc("get_bff_search_results", {
    p_user_id: userId,
    p_query: searchQuery,
    p_lat: lat || null,
    p_lng: lng || null,
    p_radius_km: radiusKm,
    p_category_ids: categoryIds.length > 0 ? categoryIds : null,
    p_dietary_tags: dietaryTags.length > 0 ? dietaryTags : null,
    p_sort_by: sortBy,
    p_status: status,
    p_page: page,
    p_limit: limit,
    p_include_suggestions: includeSuggestions,
    p_include_facets: includeFacets,
  });

  const searchTimeMs = Date.now() - startTime;

  if (error) {
    logger.error("Search failed", new Error(error.message));
    throw new Error("Search failed");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Transform listings
  const listings: ListingSummary[] = (result.listings || []).map(
    (item: Record<string, unknown>) => ({
      id: item.id as string,
      title: item.post_name as string,
      description: (item.post_description as string)?.substring(0, 150) || "",
      quantity: (item.quantity as number) || 1,
      unit: (item.unit as string) || "item",
      category: item.category_id
        ? {
            id: item.category_id as number,
            name: item.category_name as string,
            icon: item.category_icon as string,
            color: (item.category_color as string) || "#808080",
          }
        : null,
      images: ((item.images as string[]) || []).slice(0, 1).map((url) => ({
        url,
        thumbnailUrl: url.replace("/public/", "/public/thumbnails/"),
      })),
      location: {
        latitude: item.latitude as number,
        longitude: item.longitude as number,
        address: item.pickup_address as string | undefined,
        city: item.city as string | undefined,
        distanceKm: item.distance_km as number | undefined,
      },
      expiresAt: item.expires_at as string | undefined,
      status: "available" as const,
      createdAt: item.created_at as string,
      user: {
        id: item.owner_id as string,
        displayName: item.owner_name as string,
        avatarUrl: item.owner_avatar as string | undefined,
        rating: (item.owner_rating as number) || 0,
        reviewCount: (item.owner_review_count as number) || 0,
        isVerified: (item.owner_verified as boolean) || false,
        memberSince: item.owner_since as string,
      },
      isFavorited: (item.is_favorited as boolean) || false,
      favoriteCount: (item.favorite_count as number) || 0,
    })
  );

  // Build pagination
  const totalMatches = result.total_count || 0;
  const pagination: PaginationMeta = {
    page,
    limit,
    total: totalMatches,
    hasMore: page * limit < totalMatches,
  };

  // Build filters applied
  const filters: SearchFilters = {
    query: searchQuery || undefined,
    categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
    dietaryTags: dietaryTags.length > 0 ? dietaryTags : undefined,
    maxDistanceKm: radiusKm,
    latitude: lat,
    longitude: lng,
    sortBy,
    status,
  };

  // Transform suggestions
  const suggestions: SearchSuggestion[] = (result.suggestions || []).map(
    (s: Record<string, unknown>) => ({
      text: s.text as string,
      type: s.type as "query" | "category" | "dietary" | "recent",
      count: s.count as number | undefined,
    })
  );

  // Build facets
  const facets = {
    categories: (result.category_facets || []).map((f: Record<string, unknown>) => ({
      id: f.id as number,
      name: f.name as string,
      count: f.count as number,
    })),
    dietaryTags: (result.dietary_facets || []).map((f: Record<string, unknown>) => ({
      tag: f.tag as string,
      count: f.count as number,
    })),
  };

  // Build response
  const response: SearchResponse = {
    results: listings,
    pagination,
    filters,
    suggestions,
    facets,
    meta: {
      searchTimeMs,
      totalMatches,
    },
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(response, platform, {
    resourceType: "search",
    imageUseCase: "card",
    includeCapabilities: false,
  });

  // Log search for analytics (async, fire and forget)
  if (searchQuery) {
    supabase
      .rpc("log_search_query", {
        p_user_id: userId,
        p_query: searchQuery,
        p_result_count: listings.length,
        p_filters: JSON.stringify(filters),
      })
      .then(() => {})
      .catch((err) => logger.warn("Failed to log search", { error: err.message }));
  }

  logger.info("Search completed", {
    userId,
    query: searchQuery,
    resultsCount: listings.length,
    totalMatches,
    searchTimeMs,
    platform,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Suggestions Handler
// =============================================================================

async function handleSuggestions(
  ctx: HandlerContext<unknown, { q?: string }>
): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const prefix = query.q?.trim() || "";
  const platform = (requestCtx?.platform || "unknown") as Platform;

  if (prefix.length < 2) {
    // Return recent searches for empty/short queries
    const { data: recentData } = await supabase
      .from("search_history")
      .select("query")
      .eq("user_id", userId)
      .order("searched_at", { ascending: false })
      .limit(5);

    const suggestions: SearchSuggestion[] = (recentData || []).map((r) => ({
      text: r.query,
      type: "recent" as const,
    }));

    return ok({ suggestions }, ctx);
  }

  // Get autocomplete suggestions
  const { data, error } = await supabase.rpc("get_search_suggestions", {
    p_prefix: prefix,
    p_limit: 8,
  });

  if (error) {
    logger.warn("Suggestions failed", { error: error.message });
    return ok({ suggestions: [] }, ctx);
  }

  const result = typeof data === "string" ? JSON.parse(data) : data;

  const suggestions: SearchSuggestion[] = (result || []).map(
    (s: Record<string, unknown>) => ({
      text: s.text as string,
      type: s.type as "query" | "category" | "dietary",
      count: s.count as number | undefined,
    })
  );

  logger.debug("Suggestions fetched", { prefix, count: suggestions.length });

  return ok({ suggestions }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

const suggestionsQuerySchema = z.object({
  q: z.string().max(100).optional(),
});

export default createAPIHandler({
  service: "bff-search",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 120,
    windowMs: 60000, // 120 requests per minute (search is frequent)
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: searchQuerySchema,
      handler: handleSearch,
    },
  },
});

// Export suggestions handler separately for /bff/search/suggestions route
export const suggestionsHandler = createAPIHandler({
  service: "bff-search-suggestions",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 180,
    windowMs: 60000, // Higher limit for autocomplete
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: suggestionsQuerySchema,
      handler: handleSuggestions,
    },
  },
});
