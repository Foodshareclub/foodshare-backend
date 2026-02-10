/**
 * Unified Search & Indexing API v2
 *
 * Canonical search function consolidating foodshare-search and api-v1-search.
 *
 * Search routes:
 *   GET  ?q=pizza&mode=hybrid          -> search
 *   POST (body: search request)        -> search
 *
 * Admin routes:
 *   GET  ?route=health                 -> health check
 *   GET  ?route=stats                  -> search statistics
 *   POST ?route=index  (body: webhook) -> index single post
 *   POST ?route=batch  (body: batch)   -> batch index posts
 *
 * Modes: semantic | text | hybrid | fuzzy
 *
 * @version 2.0.0
 */

import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { AppError, ValidationError } from "../_shared/errors.ts";
import { getActiveProvider, getEmbeddingHealth } from "../_shared/embeddings.ts";
import { getVectorClient } from "../_shared/upstash-vector.ts";
import { cache } from "../_shared/cache.ts";

// Shared types, utilities, and transformers
import {
  type BatchIndexRequest,
  buildFilters,
  deduplicateRequest,
  DEFAULT_LIMIT,
  getCacheKey,
  MAX_LIMIT,
  parsePostRouteQuery,
  parseSearchQuery,
  QUERY_CACHE_TTL_MS,
  sanitizeInput,
  type SearchFilters,
  type SearchMode,
  type SearchResponse,
  stats,
  updateStats,
  validateUUID,
  VERSION,
  type WebhookPayload,
} from "./lib/types.ts";

// Search handlers
import {
  executeSearch,
  handleBatchIndex,
  handleWebhookIndex,
  verifyWebhookSignature,
} from "./lib/vector-search.ts";

// =============================================================================
// GET Handler
// =============================================================================

async function handleGet(
  ctx: HandlerContext,
): Promise<Response> {
  const { supabase } = ctx;
  const url = new URL(ctx.request.url);
  const rawParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const query = parseSearchQuery(rawParams);
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
  ctx: HandlerContext,
): Promise<Response> {
  const { supabase, request, body } = ctx;
  const url = new URL(request.url);
  const rawParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    rawParams[k] = v;
  });
  const query = parsePostRouteQuery(rawParams);
  const { route } = query;

  // POST ?route=index -- webhook indexing
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

  // POST ?route=batch -- admin batch indexing
  if (route === "batch") {
    const authHeader = request.headers.get("Authorization");
    const expectedToken = Deno.env.get("ADMIN_API_KEY");
    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      throw new AppError("Unauthorized", "AUTH_ERROR", 401);
    }

    const result = await handleBatchIndex(supabase, body as BatchIndexRequest);
    return ok({ success: true, result }, ctx);
  }

  // Default POST -- search (body-based)
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
    if (bodyFilters.category && typeof bodyFilters.category === "string") {
      filters.category = sanitizeInput(bodyFilters.category);
    }
    if (Array.isArray(bodyFilters.dietary)) {
      filters.dietary = bodyFilters.dietary
        .filter((d): d is string => typeof d === "string")
        .map(sanitizeInput);
    }
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
    ) {
      filters.maxAgeHours = bodyFilters.maxAgeHours;
    }
    if (
      typeof bodyFilters.profileId === "string" &&
      validateUUID(bodyFilters.profileId)
    ) {
      filters.profileId = bodyFilters.profileId;
    }
    if (Array.isArray(bodyFilters.categoryIds)) {
      filters.categoryIds = bodyFilters.categoryIds.filter(
        (id): id is number => typeof id === "number" && Number.isInteger(id),
      );
    }
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

Deno.serve(createAPIHandler({
  service: "api-v1-search",
  version: VERSION,
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 60,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGet,
    },
    POST: {
      handler: handlePost,
    },
  },
}));
