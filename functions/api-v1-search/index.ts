/**
 * Unified Search & Indexing API v2
 *
 * Canonical search function consolidating foodshare-search and api-v1-search.
 *
 * Search routes:
 *   GET  ?q=pizza&mode=hybrid          → search
 *   POST (body: search request)        → search
 *
 * Admin routes:
 *   GET  ?route=health                 → health check
 *   GET  ?route=stats                  → search statistics
 *   POST ?route=index  (body: webhook) → index single post
 *   POST ?route=batch  (body: batch)   → batch index posts
 *
 * Modes: semantic | text | hybrid | fuzzy
 *
 * @version 2.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError, AppError } from "../_shared/errors.ts";
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
  type VectorRecord,
  type VectorQueryResult,
  VectorClientError,
} from "../_shared/upstash-vector.ts";
import { calculateDistanceKm, roundDistance } from "../_shared/distance.ts";
import { cache, CACHE_TTLS } from "../_shared/cache.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "2.0.0";
const RRF_K = 60;
const SEMANTIC_WEIGHT = 1.2;
const TEXT_WEIGHT = 1.0;
const MIN_SCORE_THRESHOLD = 0.3;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH_SIZE = 100;
const EMBEDDING_BATCH_SIZE = 20;
const QUERY_CACHE_TTL_MS = 60_000;

// =============================================================================
// Types
// =============================================================================

type SearchMode = "semantic" | "text" | "hybrid" | "fuzzy";

interface SearchFilters {
  category?: string;
  dietary?: string[];
  location?: GeoLocation;
  maxAgeHours?: number;
  profileId?: string;
  categoryIds?: number[];
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

// =============================================================================
// Schemas
// =============================================================================

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500).optional(),
  mode: z.enum(["semantic", "text", "hybrid", "fuzzy"]).default("hybrid"),
  route: z.enum(["health", "stats"]).optional(),
  lat: z.string().transform(Number).optional(),
  lng: z.string().transform(Number).optional(),
  radiusKm: z.string().transform(Number).optional(),
  categoryIds: z.string().transform((s) => s.split(",").map(Number)).optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIMIT))
    .default("20"),
  offset: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(0))
    .default("0"),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;

const postRouteSchema = z.object({
  route: z.enum(["index", "batch"]).optional(),
});

type PostRouteQuery = z.infer<typeof postRouteSchema>;

// =============================================================================
// Request Deduplication
// =============================================================================

const pendingRequests = new Map<string, Promise<SearchResponse>>();

function deduplicateRequest(
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

const stats = {
  total_searches: 0,
  cache_hits: 0,
  cache_misses: 0,
  avg_latency_ms: 0,
  provider_usage: {} as Record<string, number>,
};

function updateStats(latencyMs: number, cached: boolean, provider?: string): void {
  stats.total_searches++;
  if (cached) stats.cache_hits++;
  else stats.cache_misses++;
  stats.avg_latency_ms =
    (stats.avg_latency_ms * (stats.total_searches - 1) + latencyMs) /
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
  /[\x00-\x1f\x7f]/g,
];

function sanitizeInput(input: string): string {
  let sanitized = input;
  for (const pattern of DANGEROUS_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  return sanitized.trim().slice(0, 500);
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapePostgresLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function validateUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

// =============================================================================
// Cache Helpers
// =============================================================================

function getCacheKey(mode: string, q: string, filters: SearchFilters | undefined, limit: number, offset: number): string {
  return `search:${JSON.stringify({ m: mode, q: normalizeQuery(q), f: filters, l: limit, o: offset })}`;
}

// =============================================================================
// Search Implementations (return data, NOT Response)
// =============================================================================

async function semanticSearch(
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
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
  const requestLimit = Math.min((limit + offset) * 2, MAX_LIMIT * 2);

  const vectorResults = await vectorClient.query(embeddingResult.embedding, {
    topK: requestLimit,
    includeMetadata: true,
    filter: vectorFilter,
  });

  const filteredByScore = vectorResults.filter(
    (r) => r.score >= MIN_SCORE_THRESHOLD,
  );

  let results = filteredByScore.map(transformVectorResult);

  if (filters?.location) {
    results = filterByDistance(results, filters.location);
  }

  const paginatedResults = results.slice(offset, offset + limit);

  return {
    results: paginatedResults,
    total: results.length,
    provider: embeddingResult.provider,
  };
}

// deno-lint-ignore no-explicit-any
async function textSearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number }> {
  const normalizedQuery = normalizeQuery(query);

  let queryBuilder = supabase
    .from("posts")
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
    .from("posts")
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

// deno-lint-ignore no-explicit-any
async function fuzzySearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number }> {
  const escapedQuery = escapePostgresLike(sanitizeInput(query));

  let queryBuilder = supabase
    .from("posts")
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

  const { data: posts, count } = await queryBuilder;

  let results = transformPostsToResults(posts || []);

  if (filters?.location) {
    results = filterByDistance(results, filters.location);
  }

  return { results, total: count || 0 };
}

// deno-lint-ignore no-explicit-any
async function hybridSearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number; provider?: string }> {
  // Run both searches in parallel — calling internal functions directly (no double-serialization)
  const [semanticResult, textResult] = await Promise.allSettled([
    semanticSearch(query, limit * 2, 0, filters),
    textSearch(supabase, query, limit * 2, 0, filters),
  ]);

  const semanticResults =
    semanticResult.status === "fulfilled" ? semanticResult.value.results : [];
  const textResults =
    textResult.status === "fulfilled" ? textResult.value.results : [];

  if (semanticResult.status === "rejected") {
    logger.warn("Semantic search failed in hybrid mode", {
      error:
        semanticResult.reason instanceof Error
          ? semanticResult.reason.message
          : String(semanticResult.reason),
    });
  }
  if (textResult.status === "rejected") {
    logger.warn("Text search failed in hybrid mode", {
      error:
        textResult.reason instanceof Error
          ? textResult.reason.message
          : String(textResult.reason),
    });
  }

  if (semanticResults.length === 0 && textResults.length === 0) {
    if (
      semanticResult.status === "rejected" &&
      textResult.status === "rejected"
    ) {
      throw new AppError(
        "Search service temporarily unavailable",
        "SEARCH_FAILED",
        503,
      );
    }
    return { results: [], total: 0 };
  }

  const fusedResults = applyRRF(semanticResults, textResults);
  const paginatedResults = fusedResults.slice(offset, offset + limit);

  return {
    results: paginatedResults,
    total: fusedResults.length,
    provider:
      semanticResult.status === "fulfilled"
        ? semanticResult.value.provider
        : undefined,
  };
}

// =============================================================================
// Reciprocal Rank Fusion (weighted)
// =============================================================================

function applyRRF(
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
    location:
      m.latitude && m.longitude
        ? { lat: Number(m.latitude), lng: Number(m.longitude) }
        : undefined,
    posted_at: String(m.posted_at || ""),
    dietary_tags: Array.isArray(m.dietary_tags)
      ? (m.dietary_tags as string[])
      : undefined,
  };
}

function transformPostsToResults(
  posts: Record<string, unknown>[],
): SearchResultItem[] {
  return posts.map((row, idx) => ({
    id: String(row.id),
    score: 1 - idx * 0.01,
    post_name: String(row.post_name || ""),
    post_description: String(row.post_description || "").slice(0, 500),
    category:
      (row.categories as { name: string } | null)?.name || "",
    pickup_address: String(row.post_address || ""),
    location:
      row.latitude && row.longitude
        ? { lat: Number(row.latitude), lng: Number(row.longitude) }
        : undefined,
    posted_at: String(row.created_at || ""),
    images: Array.isArray(row.images) ? (row.images as string[]) : undefined,
  }));
}

// =============================================================================
// Geo Filtering
// =============================================================================

function filterByDistance(
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
// Indexing Functions
// =============================================================================

async function indexPost(post: PostRecord): Promise<void> {
  const category = post.category_name || `category_${post.category_id}`;
  const textToEmbed =
    `${post.post_name} ${post.post_description} ${category}`.slice(0, 8000);
  const embeddingResult = await generateEmbeddings([textToEmbed]);

  const vectorRecord: VectorRecord = {
    id: post.id,
    vector: embeddingResult.embeddings[0],
    metadata: {
      post_id: post.id,
      post_name: post.post_name,
      post_description: post.post_description?.slice(0, 1000),
      category,
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
  logger.debug("Post indexed", {
    postId: post.id,
    provider: embeddingResult.provider,
  });
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

  if (inactivePosts.length > 0) {
    try {
      const vectorClient = getVectorClient();
      await vectorClient.delete(inactivePosts.map((p) => p.id));
      result.deleted = inactivePosts.length;
    } catch (error) {
      result.errors.push(
        `Delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (let i = 0; i < activePosts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = activePosts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(activePosts.length / EMBEDDING_BATCH_SIZE);

    try {
      const textsToEmbed = batch.map((p) => {
        const cat = p.category_name || `category_${p.category_id}`;
        return `${p.post_name} ${p.post_description} ${cat}`.slice(0, 8000);
      });

      const embeddingResult = await generateEmbeddings(textsToEmbed);

      const vectorRecords: VectorRecord[] = batch.map((post, idx) => {
        const cat = post.category_name || `category_${post.category_id}`;
        return {
          id: post.id,
          vector: embeddingResult.embeddings[idx],
          metadata: {
            post_id: post.id,
            post_name: post.post_name,
            post_description: post.post_description?.slice(0, 1000),
            category: cat,
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
      logger.error("Batch indexing failed", new Error(errorMsg), {
        batch: batchNum,
      });
    }
  }

  result.duration_ms = Math.round(performance.now() - startTime);
  return result;
}

async function deletePostFromIndex(postId: string): Promise<void> {
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

async function verifyWebhookSignature(
  request: Request,
  rawBody: string,
): Promise<boolean> {
  const webhookSecret = Deno.env.get("WEBHOOK_SECRET");
  if (!webhookSecret) {
    logger.warn(
      "WEBHOOK_SECRET not configured - skipping signature verification",
    );
    return true;
  }

  const signature = request.headers.get("x-webhook-signature");
  if (!signature) return false;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(rawBody),
    );
    const expectedSignature = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison
    if (signature.length !== expectedSignature.length) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) {
      diff |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }
    return diff === 0;
  } catch (error) {
    logger.error(
      "Webhook signature verification failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  }
}

// =============================================================================
// GET Handler
// =============================================================================

async function handleGet(
  ctx: HandlerContext<unknown, SearchQuery>,
): Promise<Response> {
  const { supabase, query } = ctx;
  const { route } = query;

  // Sub-routes
  if (route === "health") return ok(handleHealth(), ctx);
  if (route === "stats") return ok(handleStats(), ctx);

  // Search requires q
  const { q, mode, lat, lng, radiusKm, categoryIds, limit, offset } = query;
  if (!q) throw new ValidationError("q is required for search");

  const sanitizedQ = sanitizeInput(q);
  const filters = buildFilters({ lat, lng, radiusKm, categoryIds });
  const cacheKey = getCacheKey(mode, sanitizedQ, filters, limit, offset);

  const startTime = performance.now();

  // Check cache
  const cached = cache.get<SearchResponse>(cacheKey);
  if (cached) {
    updateStats(Math.round(performance.now() - startTime), true, cached.provider);
    return ok({ ...cached, cached: true }, ctx);
  }

  const response = await deduplicateRequest(cacheKey, async () => {
    const searchResult = await executeSearch(
      supabase,
      sanitizedQ,
      mode,
      limit,
      offset,
      filters,
    );
    const tookMs = Math.round(performance.now() - startTime);
    const resp: SearchResponse = {
      results: searchResult.results,
      total: searchResult.total,
      mode,
      took_ms: tookMs,
      provider: searchResult.provider,
      cached: false,
    };
    cache.set(cacheKey, resp, QUERY_CACHE_TTL_MS);
    return resp;
  });

  updateStats(response.took_ms, false, response.provider);
  return ok(response, ctx);
}

// =============================================================================
// POST Handler
// =============================================================================

async function handlePost(
  ctx: HandlerContext<unknown, PostRouteQuery>,
): Promise<Response> {
  const { supabase, query, request, body } = ctx;
  const { route } = query;

  // POST ?route=index — webhook indexing
  // NOTE: createAPIHandler already consumed the request body, so we re-serialize.
  // Supabase DB webhooks send compact JSON, so JSON.stringify roundtrip is safe.
  if (route === "index") {
    const rawBody = JSON.stringify(body);
    const isValid = await verifyWebhookSignature(request, rawBody);
    if (!isValid) throw new ValidationError("Invalid webhook signature");

    const payload = body as WebhookPayload;
    if (
      !payload.type ||
      !["INSERT", "UPDATE", "DELETE"].includes(payload.type)
    ) {
      throw new ValidationError(
        "Invalid webhook payload: missing or invalid type",
      );
    }

    const result = await handleWebhookIndex(supabase, payload);
    return ok({ success: true, result }, ctx);
  }

  // POST ?route=batch — admin batch indexing
  if (route === "batch") {
    const authHeader = request.headers.get("Authorization");
    const expectedToken = Deno.env.get("ADMIN_API_KEY");
    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      throw new AppError("Unauthorized", "AUTH_ERROR", 401);
    }

    const result = await handleBatchIndex(supabase, body as BatchIndexRequest);
    return ok({ success: true, result }, ctx);
  }

  // Default POST — search (body-based)
  const searchBody = body as Record<string, unknown>;
  const q = searchBody.query as string | undefined;
  if (!q || typeof q !== "string" || q.trim().length < 1) {
    throw new ValidationError("query is required and must be a non-empty string");
  }

  const sanitizedQ = sanitizeInput(q);
  const mode = (
    ["semantic", "text", "hybrid", "fuzzy"].includes(
      searchBody.mode as string,
    )
      ? searchBody.mode
      : "hybrid"
  ) as SearchMode;
  const limit = Math.min(
    Math.max(1, Number(searchBody.limit) || DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Number(searchBody.offset) || 0);

  const bodyFilters = searchBody.filters as Record<string, unknown> | undefined;
  const filters: SearchFilters = {};
  if (bodyFilters) {
    if (bodyFilters.category && typeof bodyFilters.category === "string")
      filters.category = sanitizeInput(bodyFilters.category);
    if (Array.isArray(bodyFilters.dietary))
      filters.dietary = bodyFilters.dietary
        .filter((d): d is string => typeof d === "string")
        .map(sanitizeInput);
    if (bodyFilters.location && typeof bodyFilters.location === "object") {
      const loc = bodyFilters.location as Record<string, unknown>;
      if (
        typeof loc.lat === "number" &&
        typeof loc.lng === "number" &&
        typeof loc.radiusKm === "number"
      ) {
        filters.location = {
          lat: loc.lat,
          lng: loc.lng,
          radiusKm: loc.radiusKm,
        };
      }
    }
    if (
      typeof bodyFilters.maxAgeHours === "number" &&
      bodyFilters.maxAgeHours > 0
    )
      filters.maxAgeHours = bodyFilters.maxAgeHours;
    if (
      typeof bodyFilters.profileId === "string" &&
      validateUUID(bodyFilters.profileId)
    )
      filters.profileId = bodyFilters.profileId;
    if (Array.isArray(bodyFilters.categoryIds))
      filters.categoryIds = bodyFilters.categoryIds.filter(
        (id): id is number => typeof id === "number" && Number.isInteger(id),
      );
  }

  const startTime = performance.now();
  const cacheKey = getCacheKey(mode, sanitizedQ, filters, limit, offset);

  const cached = cache.get<SearchResponse>(cacheKey);
  if (cached) {
    updateStats(Math.round(performance.now() - startTime), true, cached.provider);
    return ok({ ...cached, cached: true }, ctx);
  }

  const response = await deduplicateRequest(cacheKey, async () => {
    const searchResult = await executeSearch(
      supabase,
      sanitizedQ,
      mode,
      limit,
      offset,
      filters,
    );
    const tookMs = Math.round(performance.now() - startTime);
    const resp: SearchResponse = {
      results: searchResult.results,
      total: searchResult.total,
      mode,
      took_ms: tookMs,
      provider: searchResult.provider,
      cached: false,
    };
    cache.set(cacheKey, resp, QUERY_CACHE_TTL_MS);
    return resp;
  });

  updateStats(response.took_ms, false, response.provider);
  return ok(response, ctx);
}

// =============================================================================
// Shared Helpers
// =============================================================================

function buildFilters(params: {
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

// deno-lint-ignore no-explicit-any
async function executeSearch(
  supabase: any,
  q: string,
  mode: SearchMode,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number; provider?: string }> {
  switch (mode) {
    case "semantic":
      return semanticSearch(q, limit, offset, filters);
    case "text":
      return textSearch(supabase, q, limit, offset, filters);
    case "fuzzy":
      return fuzzySearch(supabase, q, limit, offset, filters);
    case "hybrid":
    default:
      return hybridSearch(supabase, q, limit, offset, filters);
  }
}

// =============================================================================
// Webhook Index Handler
// =============================================================================

// deno-lint-ignore no-explicit-any
async function handleWebhookIndex(
  supabase: any,
  payload: WebhookPayload,
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
  logger.info("Webhook index", { type: payload.type, recordId });

  try {
    switch (payload.type) {
      case "INSERT":
      case "UPDATE":
        if (payload.record) {
          if (payload.record.is_active && !payload.record.is_arranged) {
            if (!payload.record.category_name && payload.record.category_id) {
              const { data: category } = await supabase
                .from("categories")
                .select("name")
                .eq("id", payload.record.category_id)
                .single();
              if (category) payload.record.category_name = category.name;
            }
            await indexPost(payload.record);
            result.indexed = 1;
          } else {
            await deletePostFromIndex(payload.record.id);
            result.deleted = 1;
          }
        }
        break;
      case "DELETE": {
        const postId = payload.old_record?.id || payload.record?.id;
        if (postId) {
          await deletePostFromIndex(postId);
          result.deleted = 1;
        }
        break;
      }
    }
  } catch (error) {
    result.failed = 1;
    result.errors.push(
      error instanceof Error ? error.message : String(error),
    );
    logger.error(
      "Webhook index failed",
      error instanceof Error ? error : new Error(String(error)),
      { recordId },
    );
  }

  result.duration_ms = Math.round(performance.now() - startTime);
  return result;
}

// =============================================================================
// Batch Index Handler
// =============================================================================

// deno-lint-ignore no-explicit-any
async function handleBatchIndex(
  supabase: any,
  request: BatchIndexRequest,
): Promise<IndexResult> {
  const limit = Math.min(request.limit || MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const offset = request.offset || 0;

  logger.info("Batch index starting", {
    limit,
    offset,
    postIds: request.post_ids?.length,
  });

  let query = supabase
    .from("posts")
    .select(
      `id, post_name, post_description, post_address, post_type, category_id, images, latitude, longitude, profile_id, is_active, is_arranged, created_at, updated_at, pickup_time, available_hours, categories(name)`,
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (!request.force) {
    query = query.eq("is_active", true).eq("is_arranged", false);
  }

  if (request.post_ids?.length) {
    const validIds = request.post_ids.filter(validateUUID);
    if (validIds.length !== request.post_ids.length) {
      throw new ValidationError("Invalid post ID format in post_ids array");
    }
    query = query.in("id", validIds);
  }

  const { data: posts, error } = await query;

  if (error) {
    throw new AppError(
      `Failed to fetch posts: ${error.message}`,
      "DB_ERROR",
      500,
    );
  }

  if (!posts || posts.length === 0) {
    return {
      indexed: 0,
      failed: 0,
      deleted: 0,
      skipped: 0,
      errors: [],
      duration_ms: 0,
    };
  }

  const transformedPosts: PostRecord[] = posts.map(
    (p: Record<string, unknown>) => ({
      id: p.id as string,
      post_name: p.post_name as string,
      post_description: p.post_description as string,
      post_address: p.post_address as string,
      post_type: p.post_type as string,
      category_id: p.category_id as number,
      category_name: (p.categories as { name: string } | null)?.name,
      images: p.images as string[],
      latitude: p.latitude as number | undefined,
      longitude: p.longitude as number | undefined,
      profile_id: p.profile_id as string,
      is_active: p.is_active as boolean,
      is_arranged: p.is_arranged as boolean,
      created_at: p.created_at as string,
      updated_at: p.updated_at as string | undefined,
      pickup_time: p.pickup_time as string | undefined,
      available_hours: p.available_hours as number | undefined,
    }),
  );

  return indexPostsBatch(transformedPosts);
}

// =============================================================================
// Health & Stats
// =============================================================================

function handleHealth(): Record<string, unknown> {
  const embeddingHealth = getEmbeddingHealth();
  const activeProvider = getActiveProvider();

  let vectorHealthy = true;
  try {
    vectorHealthy = getVectorClient().isHealthy();
  } catch {
    vectorHealthy = false;
  }

  const anyEmbeddingHealthy = Object.values(embeddingHealth).some(
    (e) => e.healthy,
  );

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
    vector: { healthy: vectorHealthy },
    cache: cache.getStats(),
  };
}

function handleStats(): Record<string, unknown> {
  return {
    version: VERSION,
    ...stats,
    cache: cache.getStats(),
    uptime_seconds: Math.round(performance.now() / 1000),
  };
}

// =============================================================================
// Router
// =============================================================================

export default createAPIHandler({
  service: "api-v1-search",
  version: VERSION,
  requireAuth: false,
  csrf: false,
  routes: {
    GET: {
      querySchema: searchQuerySchema,
      handler: handleGet,
    },
    POST: {
      querySchema: postRouteSchema,
      handler: handlePost,
    },
  },
});
