/**
 * FoodShare Search Edge Function
 *
 * Production-grade unified search and indexing endpoint for all FoodShare apps.
 *
 * Routes:
 * - POST /                → Search (semantic/text/hybrid modes)
 * - POST /index           → Index single post (webhook from DB)
 * - POST /batch           → Batch index posts (admin only)
 * - GET  /health          → Health check
 * - GET  /stats           → Search statistics
 *
 * Integrations:
 * - Upstash Vector (semantic search, 1536 dims)
 * - PostgreSQL FTS (full-text search)
 * - Embeddings: Zep.ai → Groq → HuggingFace → OpenAI fallback chain
 *
 * Security:
 * - Input sanitization and validation
 * - SQL injection prevention
 * - Rate limiting integration
 * - Webhook signature verification (HMAC-SHA256)
 *
 * @version 2.0.0
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "../_shared/cors.ts";
import { logger, configureLogger } from "../_shared/logger.ts";
import { createContext, clearContext } from "../_shared/context.ts";
import { ValidationError, AppError, createErrorResponse } from "../_shared/errors.ts";
import {
  generateEmbedding,
  generateEmbeddings,
  getEmbeddingHealth,
  getActiveProvider,
  EmbeddingError,
} from "../_shared/embeddings.ts";
import {
  getVectorClient,
  buildVectorFilter,
  VectorRecord,
  VectorQueryResult,
  VectorClientError,
} from "../_shared/upstash-vector.ts";
import {
  calculateDistanceKm,
  roundDistance,
} from "../_shared/distance.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "2.0.0";
const SERVICE_NAME = "foodshare-search";

// RRF constant (k=60 is standard for balanced ranking)
const RRF_K = 60;

// Search limits
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_SCORE_THRESHOLD = 0.3; // Minimum cosine similarity for results

// Batch processing limits
const MAX_BATCH_SIZE = 100;
const EMBEDDING_BATCH_SIZE = 20;

// Cache configuration
const QUERY_CACHE_TTL_MS = 60000;
const CACHE_MAX_SIZE = 500;

// Rate limiting
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;

// Configure logger
configureLogger({ service: SERVICE_NAME });

// =============================================================================
// Types
// =============================================================================

type SearchMode = "semantic" | "text" | "hybrid";

interface SearchRequest {
  mode: SearchMode;
  query: string;
  filters?: SearchFilters;
  limit: number;
  offset: number;
}

interface SearchFilters {
  category?: string;
  dietary?: string[];
  location?: GeoLocation;
  maxAgeHours?: number;
  profileId?: string;
}

interface GeoLocation {
  lat: number;
  lng: number;
  radiusKm: number;
}

interface SearchResultItem {
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

interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  mode: SearchMode;
  took_ms: number;
  provider?: string;
  cached?: boolean;
}

interface WebhookPayload {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: PostRecord | null;
  old_record: PostRecord | null;
}

interface PostRecord {
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

interface BatchIndexRequest {
  post_ids?: string[];
  limit?: number;
  offset?: number;
  force?: boolean;
}

interface IndexResult {
  indexed: number;
  failed: number;
  deleted: number;
  skipped: number;
  errors: string[];
  duration_ms: number;
}

interface SearchStats {
  total_searches: number;
  cache_hits: number;
  cache_misses: number;
  avg_latency_ms: number;
  provider_usage: Record<string, number>;
}

// =============================================================================
// LRU Cache Implementation
// =============================================================================

class LRUCache<K, V> {
  private cache = new Map<K, { value: V; timestamp: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Remove oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      } else {
        break;
      }
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  get stats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxSize };
  }
}

// =============================================================================
// Request Deduplication
// =============================================================================

const pendingRequests = new Map<string, Promise<SearchResponse>>();

async function deduplicateRequest(
  key: string,
  fn: () => Promise<SearchResponse>
): Promise<SearchResponse> {
  const pending = pendingRequests.get(key);
  if (pending) {
    return pending;
  }

  const promise = fn().finally(() => {
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

// =============================================================================
// Statistics
// =============================================================================

const stats: SearchStats = {
  total_searches: 0,
  cache_hits: 0,
  cache_misses: 0,
  avg_latency_ms: 0,
  provider_usage: {},
};

function updateStats(latencyMs: number, cached: boolean, provider?: string): void {
  stats.total_searches++;
  if (cached) {
    stats.cache_hits++;
  } else {
    stats.cache_misses++;
  }

  // Rolling average
  stats.avg_latency_ms =
    (stats.avg_latency_ms * (stats.total_searches - 1) + latencyMs) / stats.total_searches;

  if (provider) {
    stats.provider_usage[provider] = (stats.provider_usage[provider] || 0) + 1;
  }
}

// =============================================================================
// Singleton Instances
// =============================================================================

const queryCache = new LRUCache<string, SearchResponse>(CACHE_MAX_SIZE, QUERY_CACHE_TTL_MS);
let supabaseAdmin: SupabaseClient | null = null;

function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) return supabaseAdmin;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    throw new AppError(
      "Database configuration missing",
      "CONFIG_ERROR",
      500
    );
  }

  supabaseAdmin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return supabaseAdmin;
}

// =============================================================================
// Input Sanitization
// =============================================================================

const DANGEROUS_PATTERNS = [
  /[<>]/g,                    // HTML tags
  /javascript:/gi,            // JS injection
  /on\w+=/gi,                 // Event handlers
  /[\x00-\x1f\x7f]/g,        // Control characters
];

function sanitizeInput(input: string): string {
  let sanitized = input;
  for (const pattern of DANGEROUS_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.trim().slice(0, 500);
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapePostgresLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function validateUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

// =============================================================================
// Request Validation
// =============================================================================

function validateSearchRequest(body: unknown): SearchRequest {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object");
  }

  const data = body as Record<string, unknown>;

  // Validate query
  if (!data.query || typeof data.query !== "string") {
    throw new ValidationError("query is required and must be a string");
  }

  const rawQuery = data.query.trim();
  if (rawQuery.length < 1) {
    throw new ValidationError("query cannot be empty");
  }
  if (rawQuery.length > 500) {
    throw new ValidationError("query must not exceed 500 characters");
  }

  const query = sanitizeInput(rawQuery);

  // Validate mode
  const validModes: SearchMode[] = ["semantic", "text", "hybrid"];
  const mode = (data.mode as SearchMode) || "hybrid";
  if (!validModes.includes(mode)) {
    throw new ValidationError(`mode must be one of: ${validModes.join(", ")}`);
  }

  // Validate limit
  let limit = DEFAULT_LIMIT;
  if (data.limit !== undefined) {
    if (typeof data.limit !== "number" || !Number.isInteger(data.limit)) {
      throw new ValidationError("limit must be an integer");
    }
    limit = Math.min(Math.max(1, data.limit), MAX_LIMIT);
  }

  // Validate offset
  let offset = 0;
  if (data.offset !== undefined) {
    if (typeof data.offset !== "number" || !Number.isInteger(data.offset)) {
      throw new ValidationError("offset must be an integer");
    }
    if (data.offset < 0 || data.offset > 10000) {
      throw new ValidationError("offset must be between 0 and 10000");
    }
    offset = data.offset;
  }

  // Validate filters
  let filters: SearchFilters | undefined;
  if (data.filters && typeof data.filters === "object") {
    const f = data.filters as Record<string, unknown>;
    filters = {};

    if (f.category !== undefined) {
      if (typeof f.category !== "string" || f.category.length > 100) {
        throw new ValidationError("filters.category must be a string (max 100 chars)");
      }
      filters.category = sanitizeInput(f.category);
    }

    if (f.dietary !== undefined) {
      if (!Array.isArray(f.dietary) || f.dietary.length > 10) {
        throw new ValidationError("filters.dietary must be an array (max 10 items)");
      }
      if (!f.dietary.every((d) => typeof d === "string" && d.length <= 50)) {
        throw new ValidationError("Each dietary tag must be a string (max 50 chars)");
      }
      filters.dietary = f.dietary.map(sanitizeInput);
    }

    if (f.location !== undefined) {
      const loc = f.location as Record<string, unknown>;
      if (
        typeof loc.lat !== "number" ||
        typeof loc.lng !== "number" ||
        typeof loc.radiusKm !== "number"
      ) {
        throw new ValidationError("filters.location requires lat, lng, and radiusKm as numbers");
      }
      if (loc.lat < -90 || loc.lat > 90) {
        throw new ValidationError("filters.location.lat must be between -90 and 90");
      }
      if (loc.lng < -180 || loc.lng > 180) {
        throw new ValidationError("filters.location.lng must be between -180 and 180");
      }
      if (loc.radiusKm < 0.1 || loc.radiusKm > 805) {
        throw new ValidationError("filters.location.radiusKm must be between 0.1 and 805");
      }
      filters.location = { lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm };
    }

    if (f.maxAgeHours !== undefined) {
      if (typeof f.maxAgeHours !== "number" || f.maxAgeHours < 1 || f.maxAgeHours > 8760) {
        throw new ValidationError("filters.maxAgeHours must be between 1 and 8760 (1 year)");
      }
      filters.maxAgeHours = f.maxAgeHours;
    }

    if (f.profileId !== undefined) {
      if (typeof f.profileId !== "string" || !validateUUID(f.profileId)) {
        throw new ValidationError("filters.profileId must be a valid UUID");
      }
      filters.profileId = f.profileId;
    }
  }

  return { mode, query, filters, limit, offset };
}

// =============================================================================
// Search Implementations
// =============================================================================

async function semanticSearch(
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters
): Promise<{ results: SearchResultItem[]; total: number; provider: string }> {
  const embeddingResult = await generateEmbedding(query);

  const vectorFilter = buildVectorFilter({
    category: filters?.category,
    dietary: filters?.dietary,
    isActive: true,
    profileId: filters?.profileId,
    postedAfter: filters?.maxAgeHours
      ? new Date(Date.now() - filters.maxAgeHours * 60 * 60 * 1000)
      : undefined,
  });

  const vectorClient = getVectorClient();

  // Request more results to account for filtering and offset
  const requestLimit = Math.min((limit + offset) * 2, MAX_LIMIT * 2);

  const vectorResults = await vectorClient.query(embeddingResult.embedding, {
    topK: requestLimit,
    includeMetadata: true,
    filter: vectorFilter,
  });

  // Filter by minimum score threshold
  const filteredByScore = vectorResults.filter((r) => r.score >= MIN_SCORE_THRESHOLD);

  // Transform results
  let results = filteredByScore.map((r) => transformVectorResult(r));

  // Apply geo filtering if needed
  if (filters?.location) {
    results = filterByDistance(results, filters.location);
  }

  // Apply pagination
  const paginatedResults = results.slice(offset, offset + limit);

  return {
    results: paginatedResults,
    total: results.length,
    provider: embeddingResult.provider,
  };
}

async function textSearch(
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters
): Promise<{ results: SearchResultItem[]; total: number }> {
  const supabase = getSupabaseAdmin();
  const normalizedQuery = normalizeQuery(query);

  // Build base query
  let queryBuilder = supabase
    .from("posts")
    .select(`
      id,
      post_name,
      post_description,
      post_address,
      post_type,
      category_id,
      images,
      categories(name),
      profile_id,
      created_at,
      is_active
    `, { count: "exact" })
    .eq("is_active", true)
    .eq("is_arranged", false);

  // Apply category filter first (before text search)
  if (filters?.category) {
    const { data: categoryData } = await supabase
      .from("categories")
      .select("id")
      .ilike("name", filters.category)
      .single();

    if (categoryData) {
      queryBuilder = queryBuilder.eq("category_id", categoryData.id);
    }
  }

  // Apply profile filter
  if (filters?.profileId) {
    queryBuilder = queryBuilder.eq("profile_id", filters.profileId);
  }

  // Apply age filter
  if (filters?.maxAgeHours) {
    const cutoffDate = new Date(Date.now() - filters.maxAgeHours * 60 * 60 * 1000);
    queryBuilder = queryBuilder.gte("created_at", cutoffDate.toISOString());
  }

  // Try PostgreSQL full-text search first
  try {
    const { data, error, count } = await queryBuilder
      .textSearch("post_name", normalizedQuery, { type: "websearch", config: "english" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (!error && data && data.length > 0) {
      const results = transformPostsToResults(data);
      const filteredResults = filters?.location
        ? filterByDistance(results, filters.location)
        : results;

      return { results: filteredResults, total: count || filteredResults.length };
    }
  } catch {
    // Fall through to ILIKE search
  }

  // Fallback to ILIKE search (safer, works with partial matches)
  const escapedQuery = escapePostgresLike(normalizedQuery);
  const { data: fallbackData, error: fallbackError, count } = await supabase
    .from("posts")
    .select(`
      id,
      post_name,
      post_description,
      post_address,
      post_type,
      category_id,
      images,
      categories(name),
      profile_id,
      created_at
    `, { count: "exact" })
    .eq("is_active", true)
    .eq("is_arranged", false)
    .or(`post_name.ilike.%${escapedQuery}%,post_description.ilike.%${escapedQuery}%`)
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

async function hybridSearch(
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters
): Promise<{ results: SearchResultItem[]; total: number; provider?: string }> {
  // Run both searches in parallel
  const [semanticResult, textResult] = await Promise.allSettled([
    semanticSearch(query, limit * 2, 0, filters), // Always start from 0 for fusion
    textSearch(query, limit * 2, 0, filters),
  ]);

  const semanticResults =
    semanticResult.status === "fulfilled" ? semanticResult.value.results : [];
  const textResults =
    textResult.status === "fulfilled" ? textResult.value.results : [];

  // Log failures but continue
  if (semanticResult.status === "rejected") {
    logger.warn("Semantic search failed in hybrid mode", {
      error: semanticResult.reason instanceof Error
        ? semanticResult.reason.message
        : String(semanticResult.reason),
    });
  }
  if (textResult.status === "rejected") {
    logger.warn("Text search failed in hybrid mode", {
      error: textResult.reason instanceof Error
        ? textResult.reason.message
        : String(textResult.reason),
    });
  }

  // Handle complete failure
  if (semanticResults.length === 0 && textResults.length === 0) {
    if (semanticResult.status === "rejected" && textResult.status === "rejected") {
      throw new AppError("Search service temporarily unavailable", "SEARCH_FAILED", 503);
    }
    return { results: [], total: 0 };
  }

  // Apply Reciprocal Rank Fusion
  const fusedResults = applyRRF(semanticResults, textResults);

  // Apply pagination after fusion
  const paginatedResults = fusedResults.slice(offset, offset + limit);

  return {
    results: paginatedResults,
    total: fusedResults.length,
    provider: semanticResult.status === "fulfilled"
      ? semanticResult.value.provider
      : undefined,
  };
}

function applyRRF(
  semanticResults: SearchResultItem[],
  textResults: SearchResultItem[]
): SearchResultItem[] {
  const scoreMap = new Map<string, { score: number; item: SearchResultItem }>();

  // Weight semantic results slightly higher (they understand intent better)
  const SEMANTIC_WEIGHT = 1.2;
  const TEXT_WEIGHT = 1.0;

  semanticResults.forEach((item, rank) => {
    const rrfScore = SEMANTIC_WEIGHT / (RRF_K + rank + 1);
    scoreMap.set(item.id, { score: rrfScore, item });
  });

  textResults.forEach((item, rank) => {
    const rrfScore = TEXT_WEIGHT / (RRF_K + rank + 1);
    const existing = scoreMap.get(item.id);
    if (existing) {
      // Boost items that appear in both result sets
      existing.score += rrfScore * 1.5;
    } else {
      scoreMap.set(item.id, { score: rrfScore, item });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.item, score: entry.score }));
}

// =============================================================================
// Result Transformers
// =============================================================================

function transformVectorResult(r: VectorQueryResult): SearchResultItem {
  const m = r.metadata || {};
  return {
    id: r.id,
    score: r.score,
    post_name: String(m.post_name || ""),
    post_description: String(m.post_description || "").slice(0, 500),
    category: String(m.category || ""),
    pickup_address: String(m.pickup_address || ""),
    location: m.latitude && m.longitude
      ? { lat: Number(m.latitude), lng: Number(m.longitude) }
      : undefined,
    posted_at: String(m.posted_at || ""),
    dietary_tags: Array.isArray(m.dietary_tags) ? m.dietary_tags as string[] : undefined,
  };
}

function transformPostsToResults(posts: Record<string, unknown>[]): SearchResultItem[] {
  return posts.map((row, idx) => ({
    id: String(row.id),
    score: 1 - idx * 0.01, // Descending relevance
    post_name: String(row.post_name || ""),
    post_description: String(row.post_description || "").slice(0, 500),
    category: (row.categories as { name: string } | null)?.name || "",
    pickup_address: String(row.post_address || ""),
    posted_at: String(row.created_at || ""),
    images: Array.isArray(row.images) ? row.images as string[] : undefined,
  }));
}

// =============================================================================
// Geo Filtering
// =============================================================================

function filterByDistance(
  results: SearchResultItem[],
  location: GeoLocation
): SearchResultItem[] {
  return results
    .map((r) => {
      if (!r.location) return null;
      const distance = calculateDistanceKm(
        location.lat, location.lng, r.location.lat, r.location.lng
      );
      if (distance > location.radiusKm) return null;
      return { ...r, distance_km: roundDistance(distance) };
    })
    .filter((r): r is SearchResultItem => r !== null)
    .sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0));
}

// =============================================================================
// Cache Helpers
// =============================================================================

function getCacheKey(request: SearchRequest): string {
  return JSON.stringify({
    m: request.mode,
    q: normalizeQuery(request.query),
    f: request.filters,
    l: request.limit,
    o: request.offset,
  });
}

// =============================================================================
// Indexing Functions
// =============================================================================

async function indexPost(post: PostRecord): Promise<void> {
  const category = post.category_name || `category_${post.category_id}`;
  const textToEmbed = `${post.post_name} ${post.post_description} ${category}`.slice(0, 8000);
  const embeddingResult = await generateEmbeddings([textToEmbed]);

  const vectorRecord: VectorRecord = {
    id: post.id,
    vector: embeddingResult.embeddings[0],
    metadata: {
      post_id: post.id,
      post_name: post.post_name,
      post_description: post.post_description?.slice(0, 1000),
      category: category,
      category_id: post.category_id,
      post_type: post.post_type,
      pickup_address: post.post_address,
      latitude: post.latitude,
      longitude: post.longitude,
      posted_at: post.created_at,
      profile_id: post.profile_id,
      is_active: post.is_active,
    },
  };

  const vectorClient = getVectorClient();
  await vectorClient.upsert(vectorRecord);

  logger.debug("Post indexed", { postId: post.id, provider: embeddingResult.provider });
}

async function indexPostsBatch(posts: PostRecord[]): Promise<IndexResult> {
  const startTime = performance.now();
  const result: IndexResult = {
    indexed: 0,
    failed: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  if (posts.length === 0) {
    result.duration_ms = Math.round(performance.now() - startTime);
    return result;
  }

  const activePosts = posts.filter((p) => p.is_active && !p.is_arranged);
  const inactivePosts = posts.filter((p) => !p.is_active || p.is_arranged);

  // Delete inactive posts from index
  if (inactivePosts.length > 0) {
    const idsToDelete = inactivePosts.map((p) => p.id);
    try {
      const vectorClient = getVectorClient();
      await vectorClient.delete(idsToDelete);
      result.deleted = idsToDelete.length;
      logger.info("Deleted inactive posts from index", { count: idsToDelete.length });
    } catch (error) {
      result.errors.push(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (activePosts.length === 0) {
    result.duration_ms = Math.round(performance.now() - startTime);
    return result;
  }

  // Process in batches
  for (let i = 0; i < activePosts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = activePosts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(activePosts.length / EMBEDDING_BATCH_SIZE);

    try {
      const textsToEmbed = batch.map((p) => {
        const category = p.category_name || `category_${p.category_id}`;
        return `${p.post_name} ${p.post_description} ${category}`.slice(0, 8000);
      });

      const embeddingResult = await generateEmbeddings(textsToEmbed);

      const vectorRecords: VectorRecord[] = batch.map((post, idx) => {
        const category = post.category_name || `category_${post.category_id}`;
        return {
          id: post.id,
          vector: embeddingResult.embeddings[idx],
          metadata: {
            post_id: post.id,
            post_name: post.post_name,
            post_description: post.post_description?.slice(0, 1000),
            category: category,
            category_id: post.category_id,
            post_type: post.post_type,
            pickup_address: post.post_address,
            latitude: post.latitude,
            longitude: post.longitude,
            posted_at: post.created_at,
            profile_id: post.profile_id,
            is_active: post.is_active,
          },
        };
      });

      const vectorClient = getVectorClient();
      await vectorClient.upsertBatch(vectorRecords);

      result.indexed += batch.length;
      logger.info("Batch indexed", {
        batch: `${batchNum}/${totalBatches}`,
        count: batch.length,
        provider: embeddingResult.provider,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Batch ${batchNum} failed: ${errorMsg}`);
      result.failed += batch.length;
      logger.error("Batch indexing failed", new Error(errorMsg), { batch: batchNum });
    }
  }

  result.duration_ms = Math.round(performance.now() - startTime);
  return result;
}

async function deletePost(postId: string): Promise<void> {
  if (!validateUUID(postId)) {
    throw new ValidationError("Invalid post ID format");
  }

  const vectorClient = getVectorClient();
  await vectorClient.delete([postId]);
  logger.debug("Post deleted from index", { postId });
}

// =============================================================================
// Webhook Signature Verification
// =============================================================================

async function verifyWebhookSignature(request: Request, rawBody: string): Promise<boolean> {
  const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
  if (!webhookSecret) {
    logger.warn("WEBHOOK_SECRET not configured - skipping signature verification");
    return true;
  }

  const signature = request.headers.get("x-webhook-signature");
  if (!signature) {
    logger.warn("Missing webhook signature header");
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }

    return result === 0;
  } catch (error) {
    logger.error("Webhook signature verification failed", error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleSearch(body: unknown, requestId: string): Promise<SearchResponse> {
  const request = validateSearchRequest(body);
  const cacheKey = getCacheKey(request);

  logger.info("Search request", {
    requestId,
    mode: request.mode,
    queryLength: request.query.length,
    hasFilters: !!request.filters,
    limit: request.limit,
    offset: request.offset,
  });

  // Check cache first
  const cachedResponse = queryCache.get(cacheKey);
  if (cachedResponse) {
    logger.debug("Cache hit", { requestId });
    return { ...cachedResponse, cached: true };
  }

  // Deduplicate concurrent identical requests
  return deduplicateRequest(cacheKey, async () => {
    let searchResult: { results: SearchResultItem[]; total: number; provider?: string };

    switch (request.mode) {
      case "semantic":
        searchResult = await semanticSearch(request.query, request.limit, request.offset, request.filters);
        break;
      case "text":
        searchResult = await textSearch(request.query, request.limit, request.offset, request.filters);
        break;
      case "hybrid":
      default:
        searchResult = await hybridSearch(request.query, request.limit, request.offset, request.filters);
        break;
    }

    const response: SearchResponse = {
      results: searchResult.results,
      total: searchResult.total,
      mode: request.mode,
      took_ms: 0,
      provider: searchResult.provider,
      cached: false,
    };

    // Cache successful responses
    queryCache.set(cacheKey, response);

    return response;
  });
}

async function handleWebhookIndex(
  payload: WebhookPayload,
  requestId: string
): Promise<IndexResult> {
  const startTime = performance.now();
  const result: IndexResult = {
    indexed: 0,
    failed: 0,
    deleted: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  const recordId = payload.record?.id || payload.old_record?.id;
  logger.info("Webhook index", { requestId, type: payload.type, recordId });

  try {
    switch (payload.type) {
      case "INSERT":
      case "UPDATE":
        if (payload.record) {
          if (payload.record.is_active && !payload.record.is_arranged) {
            // Fetch category name if needed
            if (!payload.record.category_name && payload.record.category_id) {
              const supabase = getSupabaseAdmin();
              const { data: category } = await supabase
                .from("categories")
                .select("name")
                .eq("id", payload.record.category_id)
                .single();
              if (category) {
                payload.record.category_name = category.name;
              }
            }
            await indexPost(payload.record);
            result.indexed = 1;
          } else {
            await deletePost(payload.record.id);
            result.deleted = 1;
          }
        }
        break;
      case "DELETE":
        const postId = payload.old_record?.id || payload.record?.id;
        if (postId) {
          await deletePost(postId);
          result.deleted = 1;
        }
        break;
    }
  } catch (error) {
    result.failed = 1;
    result.errors.push(error instanceof Error ? error.message : String(error));
    logger.error("Webhook index failed", error instanceof Error ? error : new Error(String(error)), { recordId });
  }

  result.duration_ms = Math.round(performance.now() - startTime);
  return result;
}

async function handleBatchIndex(request: BatchIndexRequest, requestId: string): Promise<IndexResult> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(request.limit || MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const offset = request.offset || 0;

  logger.info("Batch index starting", { requestId, limit, offset, postIds: request.post_ids?.length });

  // Build query
  let query = supabase
    .from("posts")
    .select(`
      id,
      post_name,
      post_description,
      post_address,
      post_type,
      category_id,
      images,
      profile_id,
      is_active,
      is_arranged,
      created_at,
      updated_at,
      pickup_time,
      available_hours,
      categories(name)
    `)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Apply filters
  if (!request.force) {
    query = query.eq("is_active", true).eq("is_arranged", false);
  }

  if (request.post_ids && request.post_ids.length > 0) {
    // Validate all UUIDs
    const validIds = request.post_ids.filter(validateUUID);
    if (validIds.length !== request.post_ids.length) {
      throw new ValidationError("Invalid post ID format in post_ids array");
    }
    query = query.in("id", validIds);
  }

  const { data: posts, error } = await query;

  if (error) {
    throw new AppError(`Failed to fetch posts: ${error.message}`, "DB_ERROR", 500);
  }

  if (!posts || posts.length === 0) {
    return { indexed: 0, failed: 0, deleted: 0, skipped: 0, errors: [], duration_ms: 0 };
  }

  // Transform to PostRecord format
  const transformedPosts: PostRecord[] = posts.map((p: Record<string, unknown>) => ({
    id: p.id as string,
    post_name: p.post_name as string,
    post_description: p.post_description as string,
    post_address: p.post_address as string,
    post_type: p.post_type as string,
    category_id: p.category_id as number,
    category_name: (p.categories as { name: string } | null)?.name,
    images: p.images as string[],
    profile_id: p.profile_id as string,
    is_active: p.is_active as boolean,
    is_arranged: p.is_arranged as boolean,
    created_at: p.created_at as string,
    updated_at: p.updated_at as string,
    pickup_time: p.pickup_time as string,
    available_hours: p.available_hours as number,
  }));

  return await indexPostsBatch(transformedPosts);
}

function handleHealth(): Record<string, unknown> {
  const embeddingHealth = getEmbeddingHealth();
  const activeProvider = getActiveProvider();

  let vectorHealthy = true;
  let vectorStats: { vectorCount?: number } = {};

  try {
    vectorHealthy = getVectorClient().isHealthy();
  } catch {
    vectorHealthy = false;
  }

  const anyEmbeddingHealthy = Object.values(embeddingHealth).some((e) => e.healthy);

  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (!vectorHealthy || !anyEmbeddingHealthy) {
    status = "unhealthy";
  } else if (Object.values(embeddingHealth).some((e) => !e.healthy)) {
    status = "degraded";
  }

  return {
    status,
    version: VERSION,
    activeProvider,
    embeddings: embeddingHealth,
    vector: { healthy: vectorHealthy, ...vectorStats },
    cache: queryCache.stats,
  };
}

function handleStats(): Record<string, unknown> {
  return {
    version: VERSION,
    ...stats,
    cache: queryCache.stats,
    uptime_seconds: Math.round(performance.now() / 1000),
  };
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleMobileCorsPrelight(req);
  }

  const corsHeaders = getCorsHeadersWithMobile(req);
  const startTime = performance.now();
  const ctx = createContext(req, SERVICE_NAME);
  const requestId = ctx.requestId;

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/foodshare-search\/?/, "/").replace(/\/$/, "") || "/";

    // GET routes
    if (req.method === "GET") {
      if (path === "/health") {
        const health = handleHealth();
        return new Response(JSON.stringify(health), {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId },
        });
      }

      if (path === "/stats") {
        const statsResponse = handleStats();
        return new Response(JSON.stringify(statsResponse), {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId },
        });
      }

      // Default GET returns health
      if (path === "/") {
        const health = handleHealth();
        return new Response(JSON.stringify(health), {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId },
        });
      }
    }

    // All other routes require POST
    if (req.method !== "POST") {
      throw new ValidationError(`Method ${req.method} not allowed for ${path}`);
    }

    const rawBody = await req.text();
    let body: unknown;

    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ValidationError("Invalid JSON in request body");
    }

    let responseData: unknown;

    // POST / - Search
    if (path === "/" || path === "") {
      const searchResponse = await handleSearch(body, requestId);
      const tookMs = Math.round(performance.now() - startTime);
      searchResponse.took_ms = tookMs;

      updateStats(tookMs, searchResponse.cached || false, searchResponse.provider);
      responseData = searchResponse;
    }
    // POST /index - Webhook
    else if (path === "/index") {
      const isValid = await verifyWebhookSignature(req, rawBody);
      if (!isValid) {
        throw new ValidationError("Invalid webhook signature");
      }

      const payload = body as WebhookPayload;
      if (!payload.type || !["INSERT", "UPDATE", "DELETE"].includes(payload.type)) {
        throw new ValidationError("Invalid webhook payload: missing or invalid type");
      }

      const result = await handleWebhookIndex(payload, requestId);
      responseData = { success: true, result };
    }
    // POST /batch - Admin batch index
    else if (path === "/batch") {
      const authHeader = req.headers.get("Authorization");
      const expectedToken = Deno.env.get("ADMIN_API_KEY");

      if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
        throw new AppError("Unauthorized", "AUTH_ERROR", 401);
      }

      const result = await handleBatchIndex(body as BatchIndexRequest, requestId);
      responseData = { success: true, result };
    }
    // Unknown route
    else {
      throw new ValidationError(`Unknown route: ${path}`);
    }

    const tookMs = Math.round(performance.now() - startTime);
    logger.info("Request completed", { requestId, path, tookMs });

    return new Response(JSON.stringify(responseData), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        "X-Version": VERSION,
        "X-Response-Time": `${tookMs}ms`,
      },
    });
  } catch (error) {
    const tookMs = Math.round(performance.now() - startTime);
    const isRetryable =
      error instanceof EmbeddingError ||
      error instanceof VectorClientError ||
      (error instanceof AppError && error.statusCode >= 500);

    logger.error("Request failed", error instanceof Error ? error : new Error(String(error)), {
      requestId,
      tookMs,
      retryable: isRetryable,
    });

    const errorResponse = createErrorResponse(error, corsHeaders);
    const newHeaders = new Headers(errorResponse.headers);
    newHeaders.set("X-Request-Id", requestId);
    newHeaders.set("X-Version", VERSION);

    if (isRetryable) {
      newHeaders.set("Retry-After", "5");
    }

    return new Response(errorResponse.body, {
      status: errorResponse.status,
      headers: newHeaders,
    });
  } finally {
    clearContext();
  }
});
