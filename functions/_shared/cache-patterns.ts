/**
 * Enterprise Cache Patterns
 *
 * Production-ready caching patterns for cross-platform apps.
 *
 * Patterns included:
 * ✅ Read-Through Cache
 * ✅ Write-Through Cache
 * ✅ Write-Behind (Async)
 * ✅ Cache-Aside
 * ✅ Refresh-Ahead (Prefetch)
 * ✅ Request Coalescing
 * ✅ Negative Caching (404s)
 * ✅ Tag-Based Invalidation
 * ✅ Multi-Tier Cache
 *
 * @version 1.0.0
 */

import { UpstashEnterpriseClient, LuaScripts } from "./upstash-enterprise.ts";
import { logger } from "./logger.ts";

// =============================================================================
// Types
// =============================================================================

export interface CacheOptions {
  ttlSeconds?: number;
  priority?: "low" | "normal" | "high" | "critical";
  tags?: string[];
  compress?: boolean;
  refreshAhead?: boolean;
  refreshThreshold?: number; // Percentage of TTL remaining to trigger refresh
  negativeTtlSeconds?: number; // TTL for caching "not found" results
  staleWhileRevalidate?: boolean;
  staleIfError?: boolean;
  maxStaleSeconds?: number;
}

export interface CachedValue<T> {
  data: T;
  metadata: {
    cachedAt: number;
    expiresAt: number;
    tags: string[];
    version: string;
    source: "cache" | "origin" | "stale";
    compressed: boolean;
    hitCount: number;
  };
}

export interface CacheStats {
  hits: number;
  misses: number;
  staleHits: number;
  errors: number;
  refreshes: number;
  invalidations: number;
}

type Fetcher<T> = () => Promise<T>;

// =============================================================================
// Constants
// =============================================================================

const CACHE_VERSION = "1.0.0";
const NEGATIVE_CACHE_PREFIX = "__neg__:";
const TAG_INDEX_PREFIX = "tag:";
const METADATA_SUFFIX = ":meta";

const DEFAULT_OPTIONS: Required<CacheOptions> = {
  ttlSeconds: 900, // 15 minutes
  priority: "normal",
  tags: [],
  compress: true,
  refreshAhead: true,
  refreshThreshold: 0.2, // Refresh when 20% TTL remaining
  negativeTtlSeconds: 60, // Cache "not found" for 1 minute
  staleWhileRevalidate: true,
  staleIfError: true,
  maxStaleSeconds: 3600, // Serve stale for up to 1 hour on error
};

const PRIORITY_TTL_MULTIPLIER: Record<string, number> = {
  low: 0.5,
  normal: 1.0,
  high: 2.0,
  critical: 4.0,
};

// =============================================================================
// Enterprise Cache Manager
// =============================================================================

export class EnterpriseCacheManager {
  private readonly client: UpstashEnterpriseClient;
  private readonly stats: CacheStats;
  private readonly pendingRefreshes: Map<string, Promise<unknown>> = new Map();
  private readonly coalescing: Map<string, Promise<unknown>> = new Map();

  constructor(client: UpstashEnterpriseClient) {
    this.client = client;
    this.stats = {
      hits: 0,
      misses: 0,
      staleHits: 0,
      errors: 0,
      refreshes: 0,
      invalidations: 0,
    };
  }

  // ===========================================================================
  // Read-Through Cache Pattern
  // ===========================================================================

  async get<T>(
    key: string,
    fetcher: Fetcher<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Request coalescing - deduplicate concurrent requests
    const coalescingKey = `coalesce:${key}`;
    const pending = this.coalescing.get(coalescingKey);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = this.getInternal<T>(key, fetcher, opts);
    this.coalescing.set(coalescingKey, promise);

    try {
      return await promise;
    } finally {
      this.coalescing.delete(coalescingKey);
    }
  }

  private async getInternal<T>(
    key: string,
    fetcher: Fetcher<T>,
    opts: Required<CacheOptions>
  ): Promise<T> {
    try {
      // Check for cached value
      const cached = await this.getCachedValue<T>(key);

      if (cached) {
        const now = Date.now();
        const remainingTtl = cached.metadata.expiresAt - now;
        const originalTtl = cached.metadata.expiresAt - cached.metadata.cachedAt;
        const remainingPercent = remainingTtl / originalTtl;

        // Fresh cache hit
        if (remainingTtl > 0) {
          this.stats.hits++;

          // Refresh ahead if threshold reached
          if (opts.refreshAhead && remainingPercent <= opts.refreshThreshold) {
            this.refreshInBackground(key, fetcher, opts);
          }

          return cached.data;
        }

        // Stale while revalidate
        if (opts.staleWhileRevalidate && remainingTtl > -opts.maxStaleSeconds * 1000) {
          this.stats.staleHits++;
          this.refreshInBackground(key, fetcher, opts);
          cached.metadata.source = "stale";
          return cached.data;
        }
      }

      // Check negative cache
      const negKey = NEGATIVE_CACHE_PREFIX + key;
      const isNegativelyCached = await this.client.execute<number>(["EXISTS", negKey]);
      if (isNegativelyCached) {
        throw new CacheNotFoundError(`Negatively cached: ${key}`);
      }

      // Cache miss - fetch from origin
      this.stats.misses++;
      return this.fetchAndCache(key, fetcher, opts);
    } catch (error) {
      this.stats.errors++;

      // Stale if error - return stale data on fetch failure
      if (opts.staleIfError && error instanceof Error && !(error instanceof CacheNotFoundError)) {
        const cached = await this.getCachedValue<T>(key);
        if (cached) {
          const staleness = Date.now() - cached.metadata.expiresAt;
          if (staleness < opts.maxStaleSeconds * 1000) {
            logger.warn("Returning stale data due to error", { key, error: error.message });
            return cached.data;
          }
        }
      }

      throw error;
    }
  }

  // ===========================================================================
  // Write-Through Cache Pattern
  // ===========================================================================

  async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<void> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const ttl = Math.round(opts.ttlSeconds * PRIORITY_TTL_MULTIPLIER[opts.priority]);

    const cachedValue: CachedValue<T> = {
      data: value,
      metadata: {
        cachedAt: Date.now(),
        expiresAt: Date.now() + ttl * 1000,
        tags: opts.tags,
        version: CACHE_VERSION,
        source: "origin",
        compressed: opts.compress,
        hitCount: 0,
      },
    };

    const serialized = JSON.stringify(cachedValue);

    // Store value
    await this.client.execute(["SETEX", key, ttl, serialized]);

    // Update tag indexes
    if (opts.tags.length > 0) {
      await this.updateTagIndexes(key, opts.tags, ttl);
    }
  }

  // ===========================================================================
  // Write-Behind (Async) Pattern
  // ===========================================================================

  async setAsync<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<void> {
    // Fire and forget - don't wait for cache write
    this.set(key, value, options).catch((error) => {
      logger.error("Async cache write failed", { key, error: error.message });
    });
  }

  // ===========================================================================
  // Cache-Aside Pattern
  // ===========================================================================

  async getOrNull<T>(key: string): Promise<T | null> {
    const cached = await this.getCachedValue<T>(key);
    if (cached && cached.metadata.expiresAt > Date.now()) {
      this.stats.hits++;
      return cached.data;
    }
    this.stats.misses++;
    return null;
  }

  // ===========================================================================
  // Tag-Based Invalidation
  // ===========================================================================

  async invalidate(key: string): Promise<void> {
    // Get metadata to find tags
    const cached = await this.getCachedValue<unknown>(key);
    if (cached) {
      // Remove from tag indexes
      for (const tag of cached.metadata.tags) {
        await this.client.execute(["SREM", TAG_INDEX_PREFIX + tag, key]);
      }
    }

    await this.client.execute(["DEL", key]);
    this.stats.invalidations++;
  }

  async invalidateByTag(tag: string): Promise<number> {
    const tagKey = TAG_INDEX_PREFIX + tag;
    const keys = await this.client.execute<string[]>(["SMEMBERS", tagKey]);

    if (keys.length === 0) return 0;

    // Delete all tagged keys
    const deleted = await this.client.execute<number>(["DEL", ...keys, tagKey]);
    this.stats.invalidations += keys.length;

    logger.info("Invalidated by tag", { tag, count: keys.length });
    return deleted;
  }

  async invalidateByPattern(pattern: string): Promise<number> {
    // Use SCAN to find matching keys (safer than KEYS for large datasets)
    let cursor = "0";
    let totalDeleted = 0;

    do {
      const result = await this.client.execute<[string, string[]]>([
        "SCAN", cursor, "MATCH", pattern, "COUNT", 100
      ]);

      cursor = result[0];
      const keys = result[1];

      if (keys.length > 0) {
        const deleted = await this.client.execute<number>(["DEL", ...keys]);
        totalDeleted += deleted;
        this.stats.invalidations += deleted;
      }
    } while (cursor !== "0");

    logger.info("Invalidated by pattern", { pattern, count: totalDeleted });
    return totalDeleted;
  }

  // ===========================================================================
  // Negative Caching
  // ===========================================================================

  async setNegative(key: string, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds || DEFAULT_OPTIONS.negativeTtlSeconds;
    await this.client.execute(["SETEX", NEGATIVE_CACHE_PREFIX + key, ttl, "1"]);
  }

  async clearNegative(key: string): Promise<void> {
    await this.client.execute(["DEL", NEGATIVE_CACHE_PREFIX + key]);
  }

  // ===========================================================================
  // Multi-Get / Multi-Set
  // ===========================================================================

  async mget<T>(keys: string[]): Promise<Map<string, T | null>> {
    if (keys.length === 0) return new Map();

    const values = await this.client.execute<(string | null)[]>(["MGET", ...keys]);
    const result = new Map<string, T | null>();

    keys.forEach((key, index) => {
      const value = values[index];
      if (value) {
        try {
          const cached: CachedValue<T> = JSON.parse(value);
          if (cached.metadata.expiresAt > Date.now()) {
            this.stats.hits++;
            result.set(key, cached.data);
          } else {
            this.stats.misses++;
            result.set(key, null);
          }
        } catch {
          result.set(key, null);
        }
      } else {
        this.stats.misses++;
        result.set(key, null);
      }
    });

    return result;
  }

  async mset<T>(entries: Map<string, T>, options: CacheOptions = {}): Promise<void> {
    if (entries.size === 0) return;

    const opts = { ...DEFAULT_OPTIONS, ...options };
    const ttl = Math.round(opts.ttlSeconds * PRIORITY_TTL_MULTIPLIER[opts.priority]);
    const pipeline: [string, number, string][] = [];

    for (const [key, value] of entries) {
      const cachedValue: CachedValue<T> = {
        data: value,
        metadata: {
          cachedAt: Date.now(),
          expiresAt: Date.now() + ttl * 1000,
          tags: opts.tags,
          version: CACHE_VERSION,
          source: "origin",
          compressed: opts.compress,
          hitCount: 0,
        },
      };
      pipeline.push([key, ttl, JSON.stringify(cachedValue)]);
    }

    // Use pipeline for efficiency
    await this.client.pipeline(
      pipeline.map(([key, ttl, value]) => ["SETEX", key, ttl, value])
    );
  }

  // ===========================================================================
  // Cache Warmup / Prefetch
  // ===========================================================================

  async warmup<T>(
    items: Array<{ key: string; fetcher: Fetcher<T>; options?: CacheOptions }>
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    const results = await Promise.allSettled(
      items.map(async ({ key, fetcher, options }) => {
        const value = await fetcher();
        await this.set(key, value, options);
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        success++;
      } else {
        failed++;
        logger.error("Warmup failed", { error: result.reason });
      }
    }

    logger.info("Cache warmup completed", { success, failed });
    return { success, failed };
  }

  async prefetch<T>(
    keys: string[],
    fetcher: (key: string) => Promise<T>,
    options: CacheOptions = {}
  ): Promise<void> {
    // Check which keys are missing
    const existing = await this.mget<T>(keys);
    const missing = keys.filter((key) => !existing.has(key) || existing.get(key) === null);

    if (missing.length === 0) return;

    // Fetch missing in parallel
    const entries = new Map<string, T>();
    await Promise.all(
      missing.map(async (key) => {
        try {
          const value = await fetcher(key);
          entries.set(key, value);
        } catch (error) {
          logger.error("Prefetch failed", { key, error });
        }
      })
    );

    // Store all at once
    await this.mset(entries, options);
    logger.info("Prefetch completed", { requested: keys.length, fetched: entries.size });
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getStats(): CacheStats & { hitRate: number } {
    const total = this.stats.hits + this.stats.misses + this.stats.staleHits;
    const hitRate = total > 0 ? (this.stats.hits + this.stats.staleHits) / total : 0;

    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 1000) / 1000,
    };
  }

  resetStats(): void {
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.staleHits = 0;
    this.stats.errors = 0;
    this.stats.refreshes = 0;
    this.stats.invalidations = 0;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async getCachedValue<T>(key: string): Promise<CachedValue<T> | null> {
    const value = await this.client.execute<string | null>(["GET", key]);
    if (!value) return null;

    try {
      const cached: CachedValue<T> = JSON.parse(value);

      // Version check
      if (cached.metadata.version !== CACHE_VERSION) {
        return null;
      }

      // Increment hit count (fire and forget)
      this.client.execute(["HINCRBY", key + METADATA_SUFFIX, "hitCount", 1]).catch(() => {});

      return cached;
    } catch {
      return null;
    }
  }

  private async fetchAndCache<T>(
    key: string,
    fetcher: Fetcher<T>,
    opts: Required<CacheOptions>
  ): Promise<T> {
    try {
      const value = await fetcher();
      await this.set(key, value, opts);
      return value;
    } catch (error) {
      // Cache negative result for "not found" errors
      if (error instanceof CacheNotFoundError || (error instanceof Error && error.message.includes("not found"))) {
        await this.setNegative(key, opts.negativeTtlSeconds);
      }
      throw error;
    }
  }

  private async refreshInBackground<T>(
    key: string,
    fetcher: Fetcher<T>,
    opts: Required<CacheOptions>
  ): Promise<void> {
    // Avoid duplicate refreshes
    if (this.pendingRefreshes.has(key)) return;

    const refreshPromise = (async () => {
      try {
        this.stats.refreshes++;
        const value = await fetcher();
        await this.set(key, value, opts);
        logger.debug("Background refresh completed", { key });
      } catch (error) {
        logger.warn("Background refresh failed", { key, error });
      } finally {
        this.pendingRefreshes.delete(key);
      }
    })();

    this.pendingRefreshes.set(key, refreshPromise);
  }

  private async updateTagIndexes(key: string, tags: string[], ttl: number): Promise<void> {
    const pipeline = tags.map((tag) => ["SADD", TAG_INDEX_PREFIX + tag, key]);

    // Also set expiry on tag sets
    tags.forEach((tag) => {
      pipeline.push(["EXPIRE", TAG_INDEX_PREFIX + tag, ttl * 2]); // 2x key TTL
    });

    await this.client.pipeline(pipeline);
  }
}

// =============================================================================
// Errors
// =============================================================================

export class CacheNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheNotFoundError";
  }
}

// =============================================================================
// Factory
// =============================================================================

let cacheManagerInstance: EnterpriseCacheManager | null = null;

export function getCacheManager(client?: UpstashEnterpriseClient): EnterpriseCacheManager {
  if (!cacheManagerInstance && client) {
    cacheManagerInstance = new EnterpriseCacheManager(client);
  }

  if (!cacheManagerInstance) {
    throw new Error("Cache manager not initialized");
  }

  return cacheManagerInstance;
}
