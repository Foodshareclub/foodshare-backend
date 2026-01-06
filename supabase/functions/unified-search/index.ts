/**
 * Unified Search Infrastructure
 *
 * Provides consistent search experience across Web, iOS, and Android
 * with intelligent ranking, filtering, and suggestions.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rankResults, RankingConfig } from "./ranking.ts";
import { getSuggestions, SuggestionConfig } from "./suggestions.ts";
import { applyFilters, parseFilters, SearchFilters } from "./filters.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Search types
type SearchType = "listings" | "users" | "all";

// Search request
interface SearchRequest {
  query: string;
  type?: SearchType;
  filters?: SearchFilters;
  location?: {
    latitude: number;
    longitude: number;
    radiusKm?: number;
  };
  pagination?: {
    page: number;
    limit: number;
  };
  userId?: string;
  includeRanking?: boolean;
  includeSuggestions?: boolean;
}

// Search result item
interface SearchResultItem {
  id: string;
  type: "listing" | "user";
  title: string;
  subtitle?: string;
  imageUrl?: string;
  distance?: number;
  score?: number;
  highlights?: Record<string, string>;
  data: Record<string, unknown>;
}

// Search response
interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  page: number;
  totalPages: number;
  suggestions?: string[];
  didYouMean?: string;
  filters?: Record<string, FilterOption[]>;
  searchId: string;
  processingTimeMs: number;
}

interface FilterOption {
  value: string;
  label: string;
  count: number;
}

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.replace("/unified-search", "");

    // Route handling
    if (req.method === "POST" && path === "/search") {
      return await handleSearch(req, supabase, startTime);
    }

    if (req.method === "GET" && path === "/suggestions") {
      return await handleSuggestions(req, supabase);
    }

    if (req.method === "GET" && path === "/trending") {
      return await handleTrending(req, supabase);
    }

    if (req.method === "GET" && path === "/recent") {
      return await handleRecent(req, supabase);
    }

    if (req.method === "POST" && path === "/track") {
      return await handleTrackSearch(req, supabase);
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Search error:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Search failed",
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Main search handler
async function handleSearch(
  req: Request,
  supabase: any,
  startTime: number
): Promise<Response> {
  const request: SearchRequest = await req.json();
  const searchId = crypto.randomUUID();

  // Validate query
  if (!request.query || request.query.trim().length < 2) {
    return new Response(
      JSON.stringify({
        error: { code: "INVALID_QUERY", message: "Query must be at least 2 characters" },
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const query = sanitizeQuery(request.query);
  const searchType = request.type ?? "all";
  const page = request.pagination?.page ?? 1;
  const limit = Math.min(request.pagination?.limit ?? 20, 100);
  const offset = (page - 1) * limit;

  // Parse and validate filters
  const filters = request.filters ? parseFilters(request.filters) : {};

  // Execute searches based on type
  let listingResults: SearchResultItem[] = [];
  let userResults: SearchResultItem[] = [];
  let totalListings = 0;
  let totalUsers = 0;

  if (searchType === "listings" || searchType === "all") {
    const listingSearch = await searchListings(supabase, query, filters, request.location, limit, offset);
    listingResults = listingSearch.results;
    totalListings = listingSearch.total;
  }

  if (searchType === "users" || searchType === "all") {
    const userSearch = await searchUsers(supabase, query, filters, request.location, limit, offset);
    userResults = userSearch.results;
    totalUsers = userSearch.total;
  }

  // Combine and rank results
  let results = [...listingResults, ...userResults];
  const total = searchType === "all"
    ? totalListings + totalUsers
    : (searchType === "listings" ? totalListings : totalUsers);

  // Apply ranking if enabled
  if (request.includeRanking !== false) {
    const rankingConfig: RankingConfig = {
      userLocation: request.location,
      userId: request.userId,
      boostRecent: true,
      boostNearby: true,
      diversityFactor: 0.3,
    };
    results = await rankResults(results, query, rankingConfig, supabase);
  }

  // Get suggestions if requested
  let suggestions: string[] | undefined;
  let didYouMean: string | undefined;

  if (request.includeSuggestions !== false) {
    const suggestionConfig: SuggestionConfig = {
      maxSuggestions: 5,
      includeSpellCheck: true,
    };
    const suggestionResult = await getSuggestions(query, suggestionConfig, supabase);
    suggestions = suggestionResult.suggestions;
    didYouMean = suggestionResult.didYouMean;
  }

  // Get available filters
  const availableFilters = await getAvailableFilters(supabase, query, searchType);

  // Log search for analytics
  await logSearch(supabase, {
    searchId,
    query,
    type: searchType,
    filters,
    location: request.location,
    userId: request.userId,
    resultCount: results.length,
    processingTimeMs: Date.now() - startTime,
  });

  const response: SearchResponse = {
    results: results.slice(0, limit),
    total,
    page,
    totalPages: Math.ceil(total / limit),
    suggestions,
    didYouMean,
    filters: availableFilters,
    searchId,
    processingTimeMs: Date.now() - startTime,
  };

  return new Response(
    JSON.stringify(response),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Search listings
async function searchListings(
  supabase: any,
  query: string,
  filters: Record<string, unknown>,
  location: SearchRequest["location"],
  limit: number,
  offset: number
): Promise<{ results: SearchResultItem[]; total: number }> {
  // Build base query
  let dbQuery = supabase
    .from("posts")
    .select("*, profiles!posts_user_id_fkey(id, display_name, avatar_url)", { count: "exact" })
    .eq("status", "active")
    .or(`title.ilike.%${query}%,description.ilike.%${query}%`);

  // Apply filters
  dbQuery = applyFilters(dbQuery, filters, "listing");

  // Apply location filter if provided
  if (location) {
    const radiusKm = location.radiusKm ?? 25;
    dbQuery = dbQuery
      .gte("latitude", location.latitude - (radiusKm / 111))
      .lte("latitude", location.latitude + (radiusKm / 111))
      .gte("longitude", location.longitude - (radiusKm / (111 * Math.cos(location.latitude * Math.PI / 180))))
      .lte("longitude", location.longitude + (radiusKm / (111 * Math.cos(location.latitude * Math.PI / 180))));
  }

  // Execute query
  const { data, count, error } = await dbQuery
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Listing search error:", error);
    return { results: [], total: 0 };
  }

  // Transform to SearchResultItem
  const results: SearchResultItem[] = (data ?? []).map((listing: any) => {
    const distance = location
      ? calculateDistance(
          location.latitude,
          location.longitude,
          listing.latitude,
          listing.longitude
        )
      : undefined;

    return {
      id: listing.id,
      type: "listing" as const,
      title: listing.title,
      subtitle: listing.profiles?.display_name,
      imageUrl: listing.image_urls?.[0],
      distance,
      highlights: highlightMatches(listing, query),
      data: {
        description: listing.description,
        quantity: listing.quantity,
        category: listing.category,
        dietaryInfo: listing.dietary_info,
        expiresAt: listing.expires_at,
        location: listing.location_name,
        userId: listing.user_id,
      },
    };
  });

  return { results, total: count ?? 0 };
}

// Search users
async function searchUsers(
  supabase: any,
  query: string,
  filters: Record<string, unknown>,
  location: SearchRequest["location"],
  limit: number,
  offset: number
): Promise<{ results: SearchResultItem[]; total: number }> {
  let dbQuery = supabase
    .from("profiles")
    .select("*", { count: "exact" })
    .or(`display_name.ilike.%${query}%,bio.ilike.%${query}%`);

  // Apply filters
  dbQuery = applyFilters(dbQuery, filters, "user");

  // Apply location filter
  if (location) {
    const radiusKm = location.radiusKm ?? 50;
    dbQuery = dbQuery
      .gte("latitude", location.latitude - (radiusKm / 111))
      .lte("latitude", location.latitude + (radiusKm / 111))
      .gte("longitude", location.longitude - (radiusKm / (111 * Math.cos(location.latitude * Math.PI / 180))))
      .lte("longitude", location.longitude + (radiusKm / (111 * Math.cos(location.latitude * Math.PI / 180))));
  }

  const { data, count, error } = await dbQuery
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("User search error:", error);
    return { results: [], total: 0 };
  }

  const results: SearchResultItem[] = (data ?? []).map((user: any) => {
    const distance = location && user.latitude && user.longitude
      ? calculateDistance(
          location.latitude,
          location.longitude,
          user.latitude,
          user.longitude
        )
      : undefined;

    return {
      id: user.id,
      type: "user" as const,
      title: user.display_name ?? "Anonymous",
      subtitle: user.bio?.substring(0, 100),
      imageUrl: user.avatar_url,
      distance,
      highlights: highlightMatches(user, query),
      data: {
        bio: user.bio,
        itemsShared: user.items_shared ?? 0,
        rating: user.average_rating,
        memberSince: user.created_at,
      },
    };
  });

  return { results, total: count ?? 0 };
}

// Handle suggestions endpoint
async function handleSuggestions(
  req: Request,
  supabase: any
): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get("q") ?? "";

  if (query.length < 2) {
    return new Response(
      JSON.stringify({ suggestions: [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const config: SuggestionConfig = {
    maxSuggestions: 8,
    includeSpellCheck: true,
  };

  const result = await getSuggestions(query, config, supabase);

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Handle trending searches
async function handleTrending(
  req: Request,
  supabase: any
): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "10");

  const { data } = await supabase
    .from("search_analytics")
    .select("query")
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("result_count", { ascending: false })
    .limit(limit * 2);

  // Deduplicate and count
  const queryCounts = new Map<string, number>();
  for (const row of data ?? []) {
    const q = row.query.toLowerCase().trim();
    queryCounts.set(q, (queryCounts.get(q) ?? 0) + 1);
  }

  const trending = Array.from(queryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query, count]) => ({ query, count }));

  return new Response(
    JSON.stringify({ trending }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Handle recent searches for user
async function handleRecent(
  req: Request,
  supabase: any
): Promise<Response> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  const limit = parseInt(url.searchParams.get("limit") ?? "10");

  if (!userId) {
    return new Response(
      JSON.stringify({ error: "userId required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data } = await supabase
    .from("search_analytics")
    .select("query, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit * 2);

  // Deduplicate keeping most recent
  const seen = new Set<string>();
  const recent = (data ?? [])
    .filter((row: any) => {
      const q = row.query.toLowerCase().trim();
      if (seen.has(q)) return false;
      seen.add(q);
      return true;
    })
    .slice(0, limit)
    .map((row: any) => ({
      query: row.query,
      timestamp: row.created_at,
    }));

  return new Response(
    JSON.stringify({ recent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Track search interaction
async function handleTrackSearch(
  req: Request,
  supabase: any
): Promise<Response> {
  const { searchId, action, itemId, position } = await req.json();

  if (!searchId || !action) {
    return new Response(
      JSON.stringify({ error: "searchId and action required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  await supabase.from("search_interactions").insert({
    search_id: searchId,
    action,
    item_id: itemId,
    position,
  });

  return new Response(
    JSON.stringify({ success: true }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Get available filters for search results
async function getAvailableFilters(
  supabase: any,
  query: string,
  searchType: SearchType
): Promise<Record<string, FilterOption[]>> {
  const filters: Record<string, FilterOption[]> = {};

  if (searchType === "listings" || searchType === "all") {
    // Get category counts
    const { data: categories } = await supabase
      .from("posts")
      .select("category")
      .eq("status", "active")
      .or(`title.ilike.%${query}%,description.ilike.%${query}%`);

    if (categories) {
      const categoryCounts = new Map<string, number>();
      for (const row of categories) {
        if (row.category) {
          categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
        }
      }

      filters.category = Array.from(categoryCounts.entries())
        .map(([value, count]) => ({
          value,
          label: formatCategoryLabel(value),
          count,
        }))
        .sort((a, b) => b.count - a.count);
    }

    // Get dietary info counts
    const { data: dietary } = await supabase
      .from("posts")
      .select("dietary_info")
      .eq("status", "active")
      .or(`title.ilike.%${query}%,description.ilike.%${query}%`);

    if (dietary) {
      const dietaryCounts = new Map<string, number>();
      for (const row of dietary) {
        for (const tag of row.dietary_info ?? []) {
          dietaryCounts.set(tag, (dietaryCounts.get(tag) ?? 0) + 1);
        }
      }

      filters.dietary = Array.from(dietaryCounts.entries())
        .map(([value, count]) => ({
          value,
          label: formatDietaryLabel(value),
          count,
        }))
        .sort((a, b) => b.count - a.count);
    }
  }

  return filters;
}

// Helper functions
function sanitizeQuery(query: string): string {
  return query
    .trim()
    .replace(/[<>'"]/g, "")
    .substring(0, 200);
}

function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function highlightMatches(
  item: Record<string, unknown>,
  query: string
): Record<string, string> {
  const highlights: Record<string, string> = {};
  const queryLower = query.toLowerCase();

  for (const [key, value] of Object.entries(item)) {
    if (typeof value === "string" && value.toLowerCase().includes(queryLower)) {
      const start = value.toLowerCase().indexOf(queryLower);
      const before = value.substring(Math.max(0, start - 20), start);
      const match = value.substring(start, start + query.length);
      const after = value.substring(start + query.length, start + query.length + 20);
      highlights[key] = `${before}<mark>${match}</mark>${after}`;
    }
  }

  return highlights;
}

function formatCategoryLabel(category: string): string {
  return category
    .replace(/_/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatDietaryLabel(dietary: string): string {
  const labels: Record<string, string> = {
    vegetarian: "Vegetarian",
    vegan: "Vegan",
    gluten_free: "Gluten Free",
    dairy_free: "Dairy Free",
    nut_free: "Nut Free",
    halal: "Halal",
    kosher: "Kosher",
  };
  return labels[dietary] ?? formatCategoryLabel(dietary);
}

async function logSearch(
  supabase: any,
  data: {
    searchId: string;
    query: string;
    type: SearchType;
    filters: Record<string, unknown>;
    location?: SearchRequest["location"];
    userId?: string;
    resultCount: number;
    processingTimeMs: number;
  }
): Promise<void> {
  try {
    await supabase.from("search_analytics").insert({
      id: data.searchId,
      query: data.query,
      search_type: data.type,
      filters: data.filters,
      has_location: !!data.location,
      user_id: data.userId,
      result_count: data.resultCount,
      processing_time_ms: data.processingTimeMs,
    });
  } catch (error) {
    console.error("Failed to log search:", error);
  }
}
