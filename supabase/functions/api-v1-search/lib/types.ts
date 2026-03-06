/**
 * Shared types, configuration, utilities, and transformers for the search API.
 */

import { transformLocation } from "../../_shared/transformers.ts";
import { calculateDistanceKm, roundDistance } from "../../_shared/distance.ts";
import type { VectorQueryResult } from "../../_shared/upstash-vector.ts";

// =============================================================================
// Configuration
// =============================================================================

export const VERSION = "2.0.0";
export const RRF_K = 60;
export const SEMANTIC_WEIGHT = 1.2;
export const TEXT_WEIGHT = 1.0;
export const MIN_SCORE_THRESHOLD = 0.3;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_BATCH_SIZE = 100;
export const EMBEDDING_BATCH_SIZE = 20;
export const QUERY_CACHE_TTL_MS = 60_000;

// =============================================================================
// Types
// =============================================================================

export type SearchMode = "semantic" | "text" | "hybrid" | "fuzzy";

export interface SearchFilters {
  category?: string;
  dietary?: string[];
  location?: GeoLocation;
  maxAgeHours?: number;
  profileId?: string;
  categoryIds?: number[];
}

export interface GeoLocation {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface SearchResultItem {
  id: string;
  score: number;
  post_name: string;
  post_description: string;
  category: string;
  pickup_address: string;
  location?: { lat: number; lng: number };
  distance_km?: number;
  posted_at: string;
  dietary_tags?: string[];
  images?: string[];
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  mode: SearchMode;
  took_ms: number;
  provider?: string;
  cached?: boolean;
}

export interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: PostRecord | null;
  old_record: PostRecord | null;
}

export interface PostRecord {
  id: string;
  post_name: string;
  post_description: string;
  post_address: string;
  post_type: string;
  category_id: number;
  category_name?: string;
  images?: string[];
  latitude?: number;
  longitude?: number;
  created_at: string;
  updated_at?: string;
  profile_id: string;
  is_active: boolean;
  is_arranged: boolean;
  pickup_time?: string;
  available_hours?: number;
}

export interface BatchIndexRequest {
  post_ids?: string[];
  limit?: number;
  offset?: number;
  force?: boolean;
}

export interface IndexResult {
  indexed: number;
  failed: number;
  deleted: number;
  skipped: number;
  errors: string[];
  duration_ms: number;
}

// =============================================================================
// Query Parsing (manual -- avoids Zod runtime issues on edge)
// =============================================================================

export interface SearchQuery {
  q?: string;
  mode: SearchMode;
  route?: "health" | "stats";
  lat?: number;
  lng?: number;
  radiusKm?: number;
  categoryIds?: number[];
  limit: number;
  offset: number;
}

export function parseSearchQuery(params: Record<string, string>): SearchQuery {
  const mode =
    (["semantic", "text", "hybrid", "fuzzy"].includes(params.mode)
      ? params.mode
      : "hybrid") as SearchMode;

  const limit = Math.min(Math.max(1, parseInt(params.limit, 10) || DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);

  const q = params.q?.slice(0, 500) || undefined;
  const route = (["health", "stats"].includes(params.route) ? params.route : undefined) as
    | "health"
    | "stats"
    | undefined;

  const lat = params.lat ? Number(params.lat) : undefined;
  const lng = params.lng ? Number(params.lng) : undefined;
  const radiusKm = params.radiusKm ? Number(params.radiusKm) : undefined;
  const categoryIds = params.categoryIds
    ? params.categoryIds.split(",").map(Number).filter((n) => !isNaN(n))
    : undefined;

  return { q, mode, route, lat, lng, radiusKm, categoryIds, limit, offset };
}

export interface PostRouteQuery {
  route?: "index" | "batch";
}

export function parsePostRouteQuery(params: Record<string, string>): PostRouteQuery {
  const route = (["index", "batch"].includes(params.route) ? params.route : undefined) as
    | "index"
    | "batch"
    | undefined;
  return { route };
}

// =============================================================================
// Request Deduplication
// =============================================================================

const pendingRequests = new Map<string, Promise<SearchResponse>>();

export function deduplicateRequest(
  key: string,
  fn: () => Promise<SearchResponse>,
): Promise<SearchResponse> {
  const pending = pendingRequests.get(key);
  if (pending) return pending;

  const promise = fn().finally(() => {
    pendingRequests.delete(key);
  });
  pendingRequests.set(key, promise);
  return promise;
}

// =============================================================================
// Statistics
// =============================================================================

export const stats = {
  total_searches: 0,
  cache_hits: 0,
  cache_misses: 0,
  avg_latency_ms: 0,
  provider_usage: {} as Record<string, number>,
};

export function updateStats(latencyMs: number, cached: boolean, provider?: string): void {
  stats.total_searches++;
  if (cached) stats.cache_hits++;
  else stats.cache_misses++;
  stats.avg_latency_ms = (stats.avg_latency_ms * (stats.total_searches - 1) + latencyMs) /
    stats.total_searches;
  if (provider) {
    stats.provider_usage[provider] = (stats.provider_usage[provider] || 0) + 1;
  }
}

// =============================================================================
// Input Sanitization
// =============================================================================

const DANGEROUS_PATTERNS = [
  /[<>]/g,
  /javascript:/gi,
  /on\w+=/gi,
  // deno-lint-ignore no-control-regex
  /[\x00-\x1f\x7f]/g,
];

export function sanitizeInput(input: string): string {
  let sanitized = input;
  for (const pattern of DANGEROUS_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.trim().slice(0, 500);
}

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export function escapePostgresLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export function validateUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

// =============================================================================
// Cache Helpers
// =============================================================================

export function getCacheKey(
  mode: string,
  q: string,
  filters: SearchFilters | undefined,
  limit: number,
  offset: number,
): string {
  return `search:${
    JSON.stringify({ m: mode, q: normalizeQuery(q), f: filters, l: limit, o: offset })
  }`;
}

// =============================================================================
// Shared Helpers
// =============================================================================

export function buildFilters(params: {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  categoryIds?: number[];
}): SearchFilters {
  const filters: SearchFilters = {};
  if (params.lat && params.lng) {
    filters.location = {
      lat: params.lat,
      lng: params.lng,
      radiusKm: params.radiusKm || 50,
    };
  }
  if (params.categoryIds?.length) {
    filters.categoryIds = params.categoryIds;
  }
  return filters;
}

// =============================================================================
// Result Transformers
// =============================================================================

export function transformVectorResult(r: VectorQueryResult): SearchResultItem {
  const m = r.metadata || {};
  return {
    id: r.id,
    score: r.score,
    post_name: String(m.post_name || ""),
    post_description: String(m.post_description || "").slice(0, 500),
    category: String(m.category || ""),
    pickup_address: String(m.pickup_address || ""),
    location: transformLocation(m.latitude, m.longitude) ?? undefined,
    posted_at: String(m.posted_at || ""),
    dietary_tags: Array.isArray(m.dietary_tags) ? (m.dietary_tags as string[]) : undefined,
  };
}

export function transformPostsToResults(
  posts: Record<string, unknown>[],
): SearchResultItem[] {
  return posts.map((row, idx) => ({
    id: String(row.id),
    score: 1 - idx * 0.01,
    post_name: String(row.post_name || ""),
    post_description: String(row.post_description || "").slice(0, 500),
    category: (row.categories as { name: string } | null)?.name || "",
    pickup_address: String(row.post_address || ""),
    location: transformLocation(row.latitude, row.longitude) ?? undefined,
    posted_at: String(row.created_at || ""),
    images: Array.isArray(row.images) ? (row.images as string[]) : undefined,
  }));
}

// =============================================================================
// Geo Filtering
// =============================================================================

export function filterByDistance(
  results: SearchResultItem[],
  location: GeoLocation,
): SearchResultItem[] {
  return results
    .map((r) => {
      if (!r.location) return null;
      const distance = calculateDistanceKm(
        location.lat,
        location.lng,
        r.location.lat,
        r.location.lng,
      );
      if (distance > location.radiusKm) return null;
      return { ...r, distance_km: roundDistance(distance) };
    })
    .filter((r): r is SearchResultItem => r !== null)
    .sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0));
}

// =============================================================================
// Reciprocal Rank Fusion (weighted)
// =============================================================================

export function applyRRF(
  semanticResults: SearchResultItem[],
  textResults: SearchResultItem[],
): SearchResultItem[] {
  const scoreMap = new Map<
    string,
    { score: number; item: SearchResultItem }
  >();

  semanticResults.forEach((item, rank) => {
    const rrfScore = SEMANTIC_WEIGHT / (RRF_K + rank + 1);
    scoreMap.set(item.id, { score: rrfScore, item });
  });

  textResults.forEach((item, rank) => {
    const rrfScore = TEXT_WEIGHT / (RRF_K + rank + 1);
    const existing = scoreMap.get(item.id);
    if (existing) {
      existing.score += rrfScore * 1.5; // Boost items appearing in both
    } else {
      scoreMap.set(item.id, { score: rrfScore, item });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.item, score: entry.score }));
}
