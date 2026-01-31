/**
 * Database Query Optimizer
 * 
 * Provides query optimization utilities, N+1 detection, and batch loading
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { logger } from "./logger.ts";
import { trackQuery } from "./performance.ts";

// =============================================================================
// Types
// =============================================================================

export interface BatchLoaderOptions<K, V> {
  maxBatchSize?: number;
  batchDelayMs?: number;
  cacheResults?: boolean;
}

export interface QueryPlan {
  query: string;
  estimatedCost: number;
  estimatedRows: number;
  actualRows?: number;
  executionTimeMs?: number;
}

// =============================================================================
// DataLoader Pattern (Batch Loading)
// =============================================================================

/**
 * Generic batch loader to prevent N+1 queries
 * 
 * @example
 * const userLoader = createBatchLoader(async (userIds) => {
 *   const { data } = await supabase
 *     .from('users')
 *     .select('*')
 *     .in('id', userIds);
 *   return userIds.map(id => data.find(u => u.id === id));
 * });
 * 
 * // These will be batched into a single query
 * const user1 = await userLoader.load('id1');
 * const user2 = await userLoader.load('id2');
 */
export function createBatchLoader<K, V>(
  batchLoadFn: (keys: K[]) => Promise<V[]>,
  options: BatchLoaderOptions<K, V> = {}
): {
  load: (key: K) => Promise<V>;
  loadMany: (keys: K[]) => Promise<V[]>;
  clear: () => void;
  clearKey: (key: K) => void;
} {
  const {
    maxBatchSize = 100,
    batchDelayMs = 10,
    cacheResults = true,
  } = options;

  const cache = new Map<K, V>();
  const queue: Array<{
    key: K;
    resolve: (value: V) => void;
    reject: (error: Error) => void;
  }> = [];
  let batchTimer: number | null = null;

  async function executeBatch() {
    if (queue.length === 0) return;

    const batch = queue.splice(0, maxBatchSize);
    const keys = batch.map((item) => item.key);

    try {
      const results = await batchLoadFn(keys);

      if (results.length !== keys.length) {
        throw new Error(
          `Batch loader returned ${results.length} results for ${keys.length} keys`
        );
      }

      batch.forEach((item, index) => {
        const result = results[index];
        if (cacheResults) {
          cache.set(item.key, result);
        }
        item.resolve(result);
      });
    } catch (error) {
      batch.forEach((item) => {
        item.reject(error as Error);
      });
    }

    // Process remaining items
    if (queue.length > 0) {
      batchTimer = setTimeout(executeBatch, 0);
    } else {
      batchTimer = null;
    }
  }

  function scheduleBatch() {
    if (batchTimer !== null) return;
    batchTimer = setTimeout(executeBatch, batchDelayMs);
  }

  return {
    load: (key: K): Promise<V> => {
      // Check cache first
      if (cacheResults && cache.has(key)) {
        return Promise.resolve(cache.get(key)!);
      }

      return new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject });
        scheduleBatch();
      });
    },

    loadMany: async (keys: K[]): Promise<V[]> => {
      return Promise.all(keys.map((key) => {
        if (cacheResults && cache.has(key)) {
          return Promise.resolve(cache.get(key)!);
        }

        return new Promise<V>((resolve, reject) => {
          queue.push({ key, resolve, reject });
          scheduleBatch();
        });
      }));
    },

    clear: () => {
      cache.clear();
      queue.length = 0;
      if (batchTimer !== null) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
    },

    clearKey: (key: K) => {
      cache.delete(key);
    },
  };
}

// =============================================================================
// Query Plan Analysis
// =============================================================================

/**
 * Analyze query execution plan
 */
export async function analyzeQuery(
  supabase: SupabaseClient,
  query: string
): Promise<QueryPlan> {
  try {
    const { data, error } = await supabase.rpc("explain_query", {
      query_text: query,
    });

    if (error) {
      logger.warn("Failed to analyze query", { error: error.message });
      return {
        query,
        estimatedCost: 0,
        estimatedRows: 0,
      };
    }

    // Parse EXPLAIN output
    const plan = data as { plan: string };
    const costMatch = plan.plan.match(/cost=([\d.]+)\.\.([\d.]+)/);
    const rowsMatch = plan.plan.match(/rows=(\d+)/);

    return {
      query,
      estimatedCost: costMatch ? parseFloat(costMatch[2]) : 0,
      estimatedRows: rowsMatch ? parseInt(rowsMatch[1]) : 0,
    };
  } catch (error) {
    logger.error("Query analysis failed", error as Error);
    return {
      query,
      estimatedCost: 0,
      estimatedRows: 0,
    };
  }
}

// =============================================================================
// Optimized Query Builders
// =============================================================================

/**
 * Build an optimized pagination query with cursor-based pagination
 */
export function buildCursorPaginationQuery<T>(
  supabase: SupabaseClient,
  table: string,
  options: {
    cursor?: string;
    limit?: number;
    orderBy?: string;
    orderDirection?: "asc" | "desc";
    filters?: Record<string, unknown>;
  }
) {
  const {
    cursor,
    limit = 20,
    orderBy = "created_at",
    orderDirection = "desc",
    filters = {},
  } = options;

  let query = supabase.from(table).select("*");

  // Apply filters
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      query = query.eq(key, value);
    }
  });

  // Apply cursor
  if (cursor) {
    const operator = orderDirection === "desc" ? "lt" : "gt";
    query = query[operator](orderBy, cursor);
  }

  // Apply ordering and limit
  query = query.order(orderBy, { ascending: orderDirection === "asc" }).limit(limit);

  return query;
}

/**
 * Build an optimized query with proper indexes
 */
export function buildOptimizedQuery<T>(
  supabase: SupabaseClient,
  table: string,
  options: {
    select?: string;
    filters?: Record<string, unknown>;
    orderBy?: string;
    limit?: number;
    offset?: number;
  }
) {
  const {
    select = "*",
    filters = {},
    orderBy,
    limit,
    offset,
  } = options;

  let query = supabase.from(table).select(select);

  // Apply filters (these should use indexed columns)
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        query = query.in(key, value);
      } else {
        query = query.eq(key, value);
      }
    }
  });

  // Apply ordering
  if (orderBy) {
    query = query.order(orderBy);
  }

  // Apply pagination
  if (limit !== undefined) {
    query = query.limit(limit);
  }
  if (offset !== undefined) {
    query = query.range(offset, offset + (limit || 10) - 1);
  }

  return query;
}

// =============================================================================
// N+1 Query Detection
// =============================================================================

const queryLog: Array<{ query: string; timestamp: number }> = [];
const DETECTION_WINDOW_MS = 1000;
const N_PLUS_ONE_THRESHOLD = 10;

/**
 * Log a query for N+1 detection
 */
export function logQuery(query: string): void {
  const now = Date.now();
  
  // Clean old entries
  const cutoff = now - DETECTION_WINDOW_MS;
  while (queryLog.length > 0 && queryLog[0].timestamp < cutoff) {
    queryLog.shift();
  }

  queryLog.push({ query, timestamp: now });

  // Detect N+1 pattern
  const recentQueries = queryLog.filter((q) => q.timestamp > cutoff);
  const queryGroups = new Map<string, number>();

  for (const { query } of recentQueries) {
    // Normalize query (remove specific IDs)
    const normalized = query.replace(/['"][\w-]+['"]/g, "'?'");
    queryGroups.set(normalized, (queryGroups.get(normalized) || 0) + 1);
  }

  // Alert on potential N+1
  for (const [normalizedQuery, count] of queryGroups.entries()) {
    if (count >= N_PLUS_ONE_THRESHOLD) {
      logger.warn("Potential N+1 query detected", {
        query: normalizedQuery,
        count,
        windowMs: DETECTION_WINDOW_MS,
        suggestion: "Consider using batch loading or JOIN",
      });
    }
  }
}

// =============================================================================
// Query Result Caching
// =============================================================================

interface CachedQuery<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

const queryCache = new Map<string, CachedQuery<unknown>>();

/**
 * Execute a query with caching
 */
export async function cachedQuery<T>(
  cacheKey: string,
  queryFn: () => Promise<T>,
  ttlMs = 60000
): Promise<T> {
  const now = Date.now();
  const cached = queryCache.get(cacheKey) as CachedQuery<T> | undefined;

  if (cached && now - cached.timestamp < cached.ttl) {
    logger.debug("Query cache hit", { cacheKey });
    return cached.data;
  }

  logger.debug("Query cache miss", { cacheKey });
  const data = await trackQuery(cacheKey, queryFn);

  queryCache.set(cacheKey, {
    data,
    timestamp: now,
    ttl: ttlMs,
  });

  // Clean old cache entries
  if (queryCache.size > 1000) {
    const entries = Array.from(queryCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < 100; i++) {
      queryCache.delete(entries[i][0]);
    }
  }

  return data;
}

/**
 * Invalidate cached query
 */
export function invalidateCache(cacheKey: string): void {
  queryCache.delete(cacheKey);
  logger.debug("Query cache invalidated", { cacheKey });
}

/**
 * Clear all cached queries
 */
export function clearQueryCache(): void {
  queryCache.clear();
  logger.debug("Query cache cleared");
}

// =============================================================================
// Batch Operations
// =============================================================================

/**
 * Execute operations in batches to avoid overwhelming the database
 */
export async function batchExecute<T, R>(
  items: T[],
  operation: (batch: T[]) => Promise<R[]>,
  batchSize = 100
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await operation(batch);
    results.push(...batchResults);
  }

  return results;
}
