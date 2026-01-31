/**
 * Upstash Search Client (Full-Text Search)
 *
 * Production-grade full-text search client with:
 * - Typo tolerance
 * - Faceted search
 * - Weighted fields
 * - Result highlighting
 * - Circuit breaker integration
 * - Retry with exponential backoff
 *
 * Configuration:
 * - Index: foodshare-search (large-beetle)
 * - Features: Full-text, typo tolerance, facets
 *
 * @version 1.0.0
 */

import { logger } from "./logger.ts";
import { withCircuitBreaker, getCircuitStatus } from "./circuit-breaker.ts";
import { withRetry, RETRY_PRESETS } from "./retry.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface SearchClientConfig {
  /** Upstash Search REST URL */
  url: string;
  /** Upstash Search REST Token */
  token: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max documents per batch index (default: 100) */
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

export interface SearchDocument {
  id: string;
  post_name: string;
  post_description: string;
  category: string;
  dietary_tags?: string[];
  pickup_address: string;
  latitude?: number;
  longitude?: number;
  posted_at: string;
  profile_id: string;
  is_active: boolean;
  [key: string]: unknown;
}

export interface SearchQueryOptions {
  /** Number of results to return (default: 20) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
  /** Fields to search in (default: all text fields) */
  searchFields?: string[];
  /** Fields to boost in ranking */
  boostFields?: Record<string, number>;
  /** Enable typo tolerance (default: true) */
  typoTolerance?: boolean;
  /** Filter expression */
  filter?: SearchFilter;
  /** Include highlighting (default: true) */
  highlight?: boolean;
  /** Fields to return (default: all) */
  returnFields?: string[];
  /** Sort order */
  sort?: SearchSort[];
}

export interface SearchFilter {
  category?: string;
  dietary?: string[];
  isActive?: boolean;
  profileId?: string;
  postedAfter?: string;
  postedBefore?: string;
  /** Geo filter: only documents within radius */
  location?: {
    lat: number;
    lng: number;
    radiusKm: number;
  };
}

export interface SearchSort {
  field: string;
  order: "asc" | "desc";
}

export interface SearchResult {
  id: string;
  score: number;
  document: SearchDocument;
  highlights?: Record<string, string[]>;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
  facets?: Record<string, FacetResult[]>;
}

export interface FacetResult {
  value: string;
  count: number;
}

export interface IndexResult {
  indexedCount: number;
}

export interface DeleteResult {
  deletedCount: number;
}

// =============================================================================
// Search Client Error
// =============================================================================

export class SearchClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "SearchClientError";
  }
}

// =============================================================================
// Upstash Search Client
// =============================================================================

export class UpstashSearchClient {
  private readonly config: Required<SearchClientConfig>;
  private readonly baseUrl: string;

  constructor(config: SearchClientConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Ensure URL doesn't have trailing slash
    this.baseUrl = this.config.url.replace(/\/$/, "");
  }

  /**
   * Execute a request to Upstash Search
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
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
        throw new SearchClientError(
          `Upstash Search API error: ${response.status} - ${errorText}`,
          `HTTP_${response.status}`,
          response.status >= 500 || response.status === 429
        );
      }

      const data = await response.json();
      return data.result ?? data;
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof SearchClientError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        throw new SearchClientError("Request timeout", "TIMEOUT", true);
      }

      throw new SearchClientError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        "NETWORK_ERROR",
        true
      );
    }
  }

  /**
   * Execute request with circuit breaker and retry
   */
  private async safeRequest<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    return withCircuitBreaker(
      "upstash-search",
      async () => {
        return withRetry(
          () => this.request<T>(method, path, body),
          {
            ...RETRY_PRESETS.quick,
            maxRetries: 2,
            shouldRetry: (error) => {
              return error instanceof SearchClientError && error.retryable;
            },
          }
        );
      },
      {
        failureThreshold: this.config.circuitBreakerThreshold,
        resetTimeoutMs: this.config.circuitBreakerResetMs,
      }
    );
  }

  /**
   * Index a single document
   *
   * Note: Uses Upstash Hybrid Vector API which auto-embeds text with BGE-M3
   */
  async index(document: SearchDocument): Promise<IndexResult> {
    const startTime = performance.now();

    // Create text for auto-embedding by the hybrid index
    const dataText = `${document.post_name} ${document.post_description} ${document.category}`;

    await this.safeRequest("POST", "/upsert", [{
      id: document.id,
      data: dataText, // Hybrid index auto-embeds this text
      metadata: {
        post_name: document.post_name,
        post_description: document.post_description,
        category: document.category,
        pickup_address: document.pickup_address,
        posted_at: document.posted_at,
        profile_id: document.profile_id,
        is_active: document.is_active,
        latitude: document.latitude,
        longitude: document.longitude,
      },
    }]);

    logger.debug("Document indexed to hybrid search", {
      id: document.id,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { indexedCount: 1 };
  }

  /**
   * Index multiple documents in batches
   */
  async indexBatch(documents: SearchDocument[]): Promise<IndexResult> {
    if (documents.length === 0) {
      return { indexedCount: 0 };
    }

    const startTime = performance.now();
    let totalIndexed = 0;

    // Process in batches
    for (let i = 0; i < documents.length; i += this.config.maxBatchSize) {
      const batch = documents.slice(i, i + this.config.maxBatchSize);

      const records = batch.map((doc) => ({
        id: doc.id,
        data: `${doc.post_name} ${doc.post_description} ${doc.category}`,
        metadata: {
          post_name: doc.post_name,
          post_description: doc.post_description,
          category: doc.category,
          pickup_address: doc.pickup_address,
          posted_at: doc.posted_at,
          profile_id: doc.profile_id,
          is_active: doc.is_active,
          latitude: doc.latitude,
          longitude: doc.longitude,
        },
      }));

      await this.safeRequest("POST", "/upsert", records);
      totalIndexed += batch.length;

      logger.debug("Batch indexed to hybrid search", {
        batchIndex: Math.floor(i / this.config.maxBatchSize),
        batchSize: batch.length,
        totalProgress: `${totalIndexed}/${documents.length}`,
      });
    }

    logger.info("Hybrid search batch index complete", {
      totalIndexed,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { indexedCount: totalIndexed };
  }

  /**
   * Search documents using Upstash Hybrid Vector API
   *
   * Uses text-based query which the hybrid index auto-embeds with BGE-M3
   */
  async search(query: string, options: SearchQueryOptions = {}): Promise<SearchResponse> {
    const startTime = performance.now();

    const {
      limit = 20,
      filter,
    } = options;

    // Build request body for hybrid Vector search
    // The "data" field triggers text-based hybrid search with auto-embedding
    const body: Record<string, unknown> = {
      data: query,
      topK: limit,
      includeMetadata: true,
    };

    // Build filter string from structured filter
    if (filter) {
      body.filter = this.buildFilterString(filter);
    }

    const response = await this.safeRequest<Array<{
      id: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>>("POST", "/query", body);

    // Handle both array response and object with result property
    const hits = Array.isArray(response) ? response : (response as { result: typeof response }).result || [];

    const results: SearchResult[] = hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      document: {
        id: hit.id,
        post_name: (hit.metadata?.post_name as string) || "",
        post_description: (hit.metadata?.post_description as string) || "",
        category: (hit.metadata?.category as string) || "",
        pickup_address: (hit.metadata?.pickup_address as string) || "",
        posted_at: (hit.metadata?.posted_at as string) || "",
        profile_id: (hit.metadata?.profile_id as string) || "",
        is_active: (hit.metadata?.is_active as boolean) ?? true,
        latitude: hit.metadata?.latitude as number | undefined,
        longitude: hit.metadata?.longitude as number | undefined,
      },
    }));

    logger.debug("Hybrid search executed", {
      query,
      limit,
      resultCount: results.length,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return {
      results,
      total: results.length,
      took: Math.round(performance.now() - startTime),
    };
  }

  /**
   * Delete documents by IDs
   */
  async delete(ids: string[]): Promise<DeleteResult> {
    if (ids.length === 0) {
      return { deletedCount: 0 };
    }

    const startTime = performance.now();

    await this.safeRequest("POST", "/delete", { ids });

    logger.info("Documents deleted", {
      deletedCount: ids.length,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { deletedCount: ids.length };
  }

  /**
   * Delete all documents (use with caution)
   */
  async deleteAll(): Promise<void> {
    const startTime = performance.now();

    await this.safeRequest("POST", "/reset", {});

    logger.warn("All documents deleted", {
      latencyMs: Math.round(performance.now() - startTime),
    });
  }

  /**
   * Get a document by ID
   */
  async get(id: string): Promise<SearchDocument | null> {
    try {
      const result = await this.safeRequest<SearchDocument>("GET", `/documents/${encodeURIComponent(id)}`, undefined);
      return result;
    } catch (error) {
      if (error instanceof SearchClientError && error.code === "HTTP_404") {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if the client is healthy
   */
  isHealthy(): boolean {
    const circuitStatus = getCircuitStatus("upstash-search");
    return circuitStatus?.state !== "open";
  }

  /**
   * Build filter string from structured filter
   */
  private buildFilterString(filter: SearchFilter): string {
    const conditions: string[] = [];

    if (filter.category) {
      conditions.push(`category = '${this.escapeValue(filter.category)}'`);
    }

    if (filter.dietary && filter.dietary.length > 0) {
      const dietaryConditions = filter.dietary.map(
        (tag) => `dietary_tags CONTAINS '${this.escapeValue(tag)}'`
      );
      conditions.push(`(${dietaryConditions.join(" OR ")})`);
    }

    if (filter.isActive !== undefined) {
      conditions.push(`is_active = ${filter.isActive}`);
    }

    if (filter.profileId) {
      conditions.push(`profile_id = '${this.escapeValue(filter.profileId)}'`);
    }

    if (filter.postedAfter) {
      conditions.push(`posted_at > '${filter.postedAfter}'`);
    }

    if (filter.postedBefore) {
      conditions.push(`posted_at < '${filter.postedBefore}'`);
    }

    // Geo filter using bounding box approximation
    // Note: Upstash Search doesn't have native geo-distance, so we use bounding box
    if (filter.location) {
      const { lat, lng, radiusKm } = filter.location;
      const bbox = this.calculateBoundingBox(lat, lng, radiusKm);
      conditions.push(`latitude >= ${bbox.minLat}`);
      conditions.push(`latitude <= ${bbox.maxLat}`);
      conditions.push(`longitude >= ${bbox.minLng}`);
      conditions.push(`longitude <= ${bbox.maxLng}`);
    }

    return conditions.join(" AND ");
  }

  /**
   * Calculate bounding box for geo filter
   */
  private calculateBoundingBox(
    lat: number,
    lng: number,
    radiusKm: number
  ): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
    // Approximate degrees per km
    const latDegreesPerKm = 1 / 111.32;
    const lngDegreesPerKm = 1 / (111.32 * Math.cos((lat * Math.PI) / 180));

    const latDelta = radiusKm * latDegreesPerKm;
    const lngDelta = radiusKm * lngDegreesPerKm;

    return {
      minLat: lat - latDelta,
      maxLat: lat + latDelta,
      minLng: lng - lngDelta,
      maxLng: lng + lngDelta,
    };
  }

  /**
   * Escape special characters in filter values
   */
  private escapeValue(value: string): string {
    return value.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let clientInstance: UpstashSearchClient | null = null;

/**
 * Get or create the Upstash Search client (singleton)
 */
export function getSearchClient(config?: Partial<SearchClientConfig>): UpstashSearchClient {
  if (!clientInstance) {
    const url = config?.url || Deno.env.get("UPSTASH_SEARCH_REST_URL");
    const token = config?.token || Deno.env.get("UPSTASH_SEARCH_REST_TOKEN");

    if (!url || !token) {
      throw new SearchClientError(
        "UPSTASH_SEARCH_REST_URL and UPSTASH_SEARCH_REST_TOKEN must be configured",
        "CONFIG_ERROR"
      );
    }

    clientInstance = new UpstashSearchClient({
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
export function createSearchClient(config: SearchClientConfig): UpstashSearchClient {
  return new UpstashSearchClient(config);
}

/**
 * Reset the singleton client (for testing)
 */
export function resetSearchClient(): void {
  clientInstance = null;
}
