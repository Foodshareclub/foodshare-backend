/**
 * Upstash Vector Database Client
 *
 * Production-grade vector database client for semantic search with:
 * - Connection pooling (singleton pattern)
 * - Batch operations for efficient indexing
 * - Metadata filtering support
 * - Circuit breaker integration
 * - Retry with exponential backoff
 *
 * Configuration:
 * - Index: foodshare-vector (fluent-mollusk)
 * - Dimensions: 1536
 * - Metric: Cosine similarity
 *
 * @version 1.0.0
 */

import { logger } from "./logger.ts";
import { getCircuitStatus, withCircuitBreaker } from "./circuit-breaker.ts";
import { RETRY_PRESETS, withRetry } from "./retry.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface VectorClientConfig {
  /** Upstash Vector REST URL */
  url: string;
  /** Upstash Vector REST Token */
  token: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max vectors per batch upsert (default: 100) */
  maxBatchSize?: number;
  /** Circuit breaker failure threshold (default: 3) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  circuitBreakerResetMs?: number;
}

const DEFAULT_CONFIG = {
  timeoutMs: 30000,
  maxBatchSize: 100,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 30000,
};

// =============================================================================
// Types
// =============================================================================

export interface VectorMetadata {
  post_id?: string;
  post_name?: string;
  post_description?: string;
  category?: string;
  dietary_tags?: string[];
  pickup_address?: string;
  latitude?: number;
  longitude?: number;
  posted_at?: string;
  profile_id?: string;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata?: VectorMetadata;
}

export interface VectorQueryOptions {
  /** Number of results to return (default: 10) */
  topK?: number;
  /** Include metadata in results (default: true) */
  includeMetadata?: boolean;
  /** Include vectors in results (default: false) */
  includeVectors?: boolean;
  /** Metadata filter (Upstash filter syntax) */
  filter?: string;
}

export interface VectorQueryResult {
  id: string;
  score: number;
  metadata?: VectorMetadata;
  vector?: number[];
}

export interface VectorUpsertResult {
  upsertedCount: number;
}

export interface VectorDeleteResult {
  deleted: number;
}

export interface VectorStats {
  vectorCount: number;
  dimensions: number;
  indexFullness: number;
}

// =============================================================================
// Vector Client Error
// =============================================================================

export class VectorClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "VectorClientError";
  }
}

// =============================================================================
// Upstash Vector Client
// =============================================================================

export class UpstashVectorClient {
  private readonly config: Required<VectorClientConfig>;
  private readonly baseUrl: string;

  constructor(config: VectorClientConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Ensure URL doesn't have trailing slash
    this.baseUrl = this.config.url.replace(/\/$/, "");
  }

  /**
   * Execute a request to Upstash Vector
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new VectorClientError(
          `Upstash Vector API error: ${response.status} - ${errorText}`,
          `HTTP_${response.status}`,
          response.status >= 500 || response.status === 429,
        );
      }

      const data = await response.json();
      return data.result ?? data;
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof VectorClientError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        throw new VectorClientError("Request timeout", "TIMEOUT", true);
      }

      throw new VectorClientError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        "NETWORK_ERROR",
        true,
      );
    }
  }

  /**
   * Execute request with circuit breaker and retry
   */
  private async safeRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return withCircuitBreaker(
      "upstash-vector",
      async () => {
        return withRetry(
          () => this.request<T>(method, path, body),
          {
            ...RETRY_PRESETS.quick,
            maxRetries: 2,
            shouldRetry: (error) => {
              return error instanceof VectorClientError && error.retryable;
            },
          },
        );
      },
      {
        failureThreshold: this.config.circuitBreakerThreshold,
        resetTimeoutMs: this.config.circuitBreakerResetMs,
      },
    );
  }

  /**
   * Upsert a single vector
   */
  async upsert(record: VectorRecord): Promise<VectorUpsertResult> {
    const startTime = performance.now();

    await this.safeRequest("POST", "/upsert", [record]);

    logger.debug("Vector upserted", {
      id: record.id,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { upsertedCount: 1 };
  }

  /**
   * Upsert multiple vectors in batches
   */
  async upsertBatch(records: VectorRecord[]): Promise<VectorUpsertResult> {
    if (records.length === 0) {
      return { upsertedCount: 0 };
    }

    const startTime = performance.now();
    let totalUpserted = 0;

    // Process in batches
    for (let i = 0; i < records.length; i += this.config.maxBatchSize) {
      const batch = records.slice(i, i + this.config.maxBatchSize);
      await this.safeRequest("POST", "/upsert", batch);
      totalUpserted += batch.length;

      logger.debug("Batch upserted", {
        batchIndex: Math.floor(i / this.config.maxBatchSize),
        batchSize: batch.length,
        totalProgress: `${totalUpserted}/${records.length}`,
      });
    }

    logger.info("Batch upsert complete", {
      totalUpserted,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { upsertedCount: totalUpserted };
  }

  /**
   * Query vectors by similarity
   */
  async query(
    vector: number[],
    options: VectorQueryOptions = {},
  ): Promise<VectorQueryResult[]> {
    const startTime = performance.now();

    const { topK = 10, includeMetadata = true, includeVectors = false, filter } = options;

    const body: {
      vector: number[];
      topK: number;
      includeMetadata: boolean;
      includeVectors: boolean;
      filter?: string;
    } = {
      vector,
      topK,
      includeMetadata,
      includeVectors,
    };

    if (filter) {
      body.filter = filter;
    }

    const results = await this.safeRequest<VectorQueryResult[]>("POST", "/query", body);

    logger.debug("Vector query executed", {
      topK,
      resultCount: results.length,
      hasFilter: !!filter,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return results;
  }

  /**
   * Fetch vectors by IDs
   */
  async fetch(ids: string[], includeMetadata = true): Promise<(VectorRecord | null)[]> {
    const startTime = performance.now();

    const results = await this.safeRequest<(VectorRecord | null)[]>("POST", "/fetch", {
      ids,
      includeMetadata,
    });

    logger.debug("Vectors fetched", {
      requestedCount: ids.length,
      foundCount: results.filter((r) => r !== null).length,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return results;
  }

  /**
   * Delete vectors by IDs
   */
  async delete(ids: string[]): Promise<VectorDeleteResult> {
    if (ids.length === 0) {
      return { deleted: 0 };
    }

    const startTime = performance.now();

    const result = await this.safeRequest<{ deleted: number }>("POST", "/delete", {
      ids,
    });

    logger.info("Vectors deleted", {
      deleted: result.deleted,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return result;
  }

  /**
   * Delete all vectors (use with caution)
   */
  async deleteAll(): Promise<void> {
    const startTime = performance.now();

    await this.safeRequest("POST", "/reset", {});

    logger.warn("All vectors deleted", {
      latencyMs: Math.round(performance.now() - startTime),
    });
  }

  /**
   * Get index statistics
   */
  async stats(): Promise<VectorStats> {
    const result = await this.safeRequest<{
      vectorCount: number;
      dimension: number;
      indexFullness: number;
    }>("GET", "/stats", undefined);

    return {
      vectorCount: result.vectorCount,
      dimensions: result.dimension,
      indexFullness: result.indexFullness,
    };
  }

  /**
   * Check if the client is healthy
   */
  isHealthy(): boolean {
    const circuitStatus = getCircuitStatus("upstash-vector");
    return circuitStatus?.state !== "open";
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let clientInstance: UpstashVectorClient | null = null;

/**
 * Get or create the Upstash Vector client (singleton)
 */
export function getVectorClient(config?: Partial<VectorClientConfig>): UpstashVectorClient {
  if (!clientInstance) {
    const url = config?.url || Deno.env.get("UPSTASH_VECTOR_REST_URL");
    const token = config?.token || Deno.env.get("UPSTASH_VECTOR_REST_TOKEN");

    if (!url || !token) {
      throw new VectorClientError(
        "UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN must be configured",
        "CONFIG_ERROR",
      );
    }

    clientInstance = new UpstashVectorClient({
      url,
      token,
      ...config,
    });
  }

  return clientInstance;
}

/**
 * Create a new client instance (for testing or multi-index scenarios)
 */
export function createVectorClient(config: VectorClientConfig): UpstashVectorClient {
  return new UpstashVectorClient(config);
}

/**
 * Reset the singleton client (for testing)
 */
export function resetVectorClient(): void {
  clientInstance = null;
}

// =============================================================================
// Filter Builder Helpers
// =============================================================================

/**
 * Build Upstash Vector filter from structured criteria
 */
export function buildVectorFilter(criteria: {
  category?: string;
  dietary?: string[];
  isActive?: boolean;
  profileId?: string;
  postedAfter?: Date;
}): string | undefined {
  const conditions: string[] = [];

  if (criteria.category) {
    conditions.push(`category = '${escapeFilterValue(criteria.category)}'`);
  }

  if (criteria.dietary && criteria.dietary.length > 0) {
    // Match any of the dietary tags
    const dietaryConditions = criteria.dietary.map(
      (tag) => `dietary_tags CONTAINS '${escapeFilterValue(tag)}'`,
    );
    conditions.push(`(${dietaryConditions.join(" OR ")})`);
  }

  if (criteria.isActive !== undefined) {
    conditions.push(`is_active = ${criteria.isActive}`);
  }

  if (criteria.profileId) {
    conditions.push(`profile_id = '${escapeFilterValue(criteria.profileId)}'`);
  }

  if (criteria.postedAfter) {
    conditions.push(`posted_at > '${criteria.postedAfter.toISOString()}'`);
  }

  return conditions.length > 0 ? conditions.join(" AND ") : undefined;
}

/**
 * Escape special characters in filter values
 */
function escapeFilterValue(value: string): string {
  return value.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
}
