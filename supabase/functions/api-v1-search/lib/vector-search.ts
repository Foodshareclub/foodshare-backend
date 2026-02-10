/**
 * Semantic/vector search, hybrid search, and indexing implementations.
 */

import { logger } from "../../_shared/logger.ts";
import { ValidationError, AppError } from "../../_shared/errors.ts";
import {
  generateEmbedding,
  generateEmbeddings,
} from "../../_shared/embeddings.ts";
import {
  getVectorClient,
  buildVectorFilter,
  type VectorRecord,
} from "../../_shared/upstash-vector.ts";
import {
  type SearchResultItem,
  type SearchFilters,
  type SearchMode,
  type WebhookPayload,
  type PostRecord,
  type BatchIndexRequest,
  type IndexResult,
  MIN_SCORE_THRESHOLD,
  MAX_LIMIT,
  MAX_BATCH_SIZE,
  EMBEDDING_BATCH_SIZE,
  transformVectorResult,
  filterByDistance,
  applyRRF,
  validateUUID,
} from "./types.ts";
import { textSearch, fuzzySearch } from "./text-search.ts";

// =============================================================================
// Semantic Search (vector embeddings)
// =============================================================================

export async function semanticSearch(
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

// =============================================================================
// Hybrid Search (semantic + text with RRF fusion)
// =============================================================================

// deno-lint-ignore no-explicit-any
export async function hybridSearch(
  supabase: any,
  query: string,
  limit: number,
  offset: number,
  filters?: SearchFilters,
): Promise<{ results: SearchResultItem[]; total: number; provider?: string }> {
  // Run both searches in parallel -- calling internal functions directly (no double-serialization)
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
// Execute Search (mode dispatcher)
// =============================================================================

// deno-lint-ignore no-explicit-any
export async function executeSearch(
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

export async function verifyWebhookSignature(
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
// Webhook Index Handler
// =============================================================================

// deno-lint-ignore no-explicit-any
export async function handleWebhookIndex(
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
export async function handleBatchIndex(
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
    .from("posts_with_location")
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

