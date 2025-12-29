/**
 * In-memory cache service with automatic cleanup
 */

interface CacheEntry<T> {
  data: T;
  expires: number;
  createdAt: number;
}

// Use unknown instead of any for type safety
const cache = new Map<string, CacheEntry<unknown>>();

// Track cache statistics
let cacheHits = 0;
let cacheMisses = 0;

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);

  if (!entry) {
    cacheMisses++;
    return null;
  }

  if (entry.expires < Date.now()) {
    cache.delete(key);
    cacheMisses++;
    return null;
  }

  cacheHits++;
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttlMs: number = 300000): void {
  cache.set(key, {
    data,
    expires: Date.now() + ttlMs,
    createdAt: Date.now(),
  });
}

export function clearCache(key?: string): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/**
 * Cleanup expired cache entries
 * Returns the number of entries cleaned up
 */
export function cleanupExpiredCache(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of cache.entries()) {
    if (entry.expires < now) {
      cache.delete(key);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = cacheHits + cacheMisses;
  return {
    size: cache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? Math.round((cacheHits / total) * 100) / 100 : 0,
  };
}
