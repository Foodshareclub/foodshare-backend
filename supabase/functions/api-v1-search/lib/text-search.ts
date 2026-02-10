/**
 * Text and fuzzy search implementations.
 */

import { logger } from "../../_shared/logger.ts";
import { AppError } from "../../_shared/errors.ts";
import {
  type SearchResultItem,
  type SearchFilters,
  normalizeQuery,
  escapePostgresLike,
  sanitizeInput,
  transformPostsToResults,
  filterByDistance,
} from "./types.ts";

// =============================================================================
// Text Search (PostgreSQL full-text with ILIKE fallback)
// =============================================================================

// deno-lint-ignore no-explicit-any
export async function textSearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number }> {
  const normalizedQuery = normalizeQuery(query);

  let queryBuilder = supabase
    .from("posts_with_location")
    .select(
      `id, post_name, post_description, post_address, post_type, category_id, images, latitude, longitude, categories(name), profile_id, created_at, is_active`,
      { count: "exact" },
    )
    .eq("is_active", true)
    .eq("is_arranged", false);

  if (filters?.categoryIds?.length) {
    queryBuilder = queryBuilder.in("category_id", filters.categoryIds);
  }

  if (filters?.category) {
    const { data: categoryData } = await supabase
      .from("categories")
      .select("id")
      .ilike("name", filters.category)
      .maybeSingle();
    if (categoryData) {
      queryBuilder = queryBuilder.eq("category_id", categoryData.id);
    }
  }

  if (filters?.profileId) {
    queryBuilder = queryBuilder.eq("profile_id", filters.profileId);
  }

  if (filters?.maxAgeHours) {
    const cutoffDate = new Date(
      Date.now() - filters.maxAgeHours * 60 * 60 * 1000,
    );
    queryBuilder = queryBuilder.gte("created_at", cutoffDate.toISOString());
  }

  // Try PostgreSQL full-text search first, fall back to ILIKE
  try {
    const { data, error, count } = await queryBuilder
      .textSearch("post_name", normalizedQuery, {
        type: "websearch",
        config: "english",
      })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (!error && data && data.length > 0) {
      const results = transformPostsToResults(data);
      const filteredResults = filters?.location
        ? filterByDistance(results, filters.location)
        : results;
      return { results: filteredResults, total: count || filteredResults.length };
    }
  } catch (ftsError) {
    logger.warn("Full-text search failed, falling back to ILIKE", {
      error: ftsError instanceof Error ? ftsError.message : String(ftsError),
    });
  }

  // Fallback to ILIKE with properly escaped query
  const escapedQuery = escapePostgresLike(normalizedQuery);
  const { data: fallbackData, error: fallbackError, count } = await supabase
    .from("posts_with_location")
    .select(
      `id, post_name, post_description, post_address, post_type, category_id, images, latitude, longitude, categories(name), profile_id, created_at`,
      { count: "exact" },
    )
    .eq("is_active", true)
    .eq("is_arranged", false)
    .or(
      `post_name.ilike.%${escapedQuery}%,post_description.ilike.%${escapedQuery}%`,
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (fallbackError) {
    logger.error("Text search failed", fallbackError);
    throw new AppError("Search temporarily unavailable", "SEARCH_ERROR", 503);
  }

  const results = transformPostsToResults(fallbackData || []);
  const filteredResults = filters?.location
    ? filterByDistance(results, filters.location)
    : results;
  return { results: filteredResults, total: count || filteredResults.length };
}

// =============================================================================
// Fuzzy Search (ILIKE pattern matching)
// =============================================================================

// deno-lint-ignore no-explicit-any
export async function fuzzySearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number }> {
  const escapedQuery = escapePostgresLike(sanitizeInput(query));

  let queryBuilder = supabase
    .from("posts_with_location")
    .select(
      `id, post_name, post_description, post_address, post_type, category_id, images, latitude, longitude, categories(name), profile_id, created_at`,
      { count: "exact" },
    )
    .or(
      `post_name.ilike.%${escapedQuery}%,post_description.ilike.%${escapedQuery}%`,
    )
    .eq("is_active", true)
    .eq("is_arranged", false)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters?.categoryIds?.length) {
    queryBuilder = queryBuilder.in("category_id", filters.categoryIds);
  }

  const { data: posts, error: fuzzyError, count } = await queryBuilder;

  if (fuzzyError) {
    logger.error("Fuzzy search failed", fuzzyError);
    throw new AppError("Search temporarily unavailable", "SEARCH_ERROR", 503);
  }

  let results = transformPostsToResults(posts || []);

  if (filters?.location) {
    results = filterByDistance(results, filters.location);
  }

  return { results, total: count || 0 };
}
