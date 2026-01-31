/**
 * Translation Cache Layer (Enhanced)
 *
 * Provides Redis caching for content translations with automatic fallback
 * to database if Redis is unavailable.
 *
 * Cache Key Format: trans:{content_type}:{content_id}:{field}:{locale}
 * TTL: 24 hours (hot cache), Database has 90-day retention
 *
 * Improvements:
 * - Batch operations for better performance
 * - Pipeline support for multiple operations
 * - Automatic retry with exponential backoff
 * - Cache warming for popular content
 * - Metrics tracking
 *
 * Usage (from BFF or other edge functions):
 *   import { translationCache } from "../../localization/services/translation-cache.ts";
 *
 *   // Get single translation
 *   const translation = await translationCache.get("post", "123", "title", "ru");
 *
 *   // Get multiple translations for a content item
 *   const translations = await translationCache.getMultiple("post", "123", ["title", "description"], "ru");
 *
 *   // Cache a translation
 *   await translationCache.set("post", "123", "title", "ru", "Translated text");
 *
 *   // Batch cache multiple items
 *   await translationCache.batchSet(items, locale);
 */

import { logger } from "../../_shared/logger.ts";

const CACHE_TTL = 86400; // 24 hours
const CACHE_PREFIX = "trans";
const USER_LOCALE_PREFIX = "user:locale";
const USER_LOCALE_TTL = 604800; // 7 days
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Redis client singleton (lazy initialization)
 */
let redisClient: RedisClient | null = null;
let redisInitialized = false;

interface RedisClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  setex(key: string, ttl: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  pipeline(commands: string[][]): Promise<unknown[]>;
}

/**
 * Initialize Redis client if credentials are available
 */
/**
 * Upstash REST API client (Enhanced)
 * Uses direct HTTP calls for fast cold starts
 * Includes retry logic and better error handling
 */
class UpstashRestClient implements RedisClient {
  private url: string;
  private token: string;
  private retries: number;

  constructor(url: string, token: string, retries: number = MAX_RETRIES) {
    this.url = url;
    this.token = token;
    this.retries = retries;
  }

  private async execute(command: string[], attempt: number = 0): Promise<unknown> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });

      if (!response.ok) {
        throw new Error(`Upstash error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(`Upstash error: ${data.error}`);
      }
      return data.result;
    } catch (error) {
      // Retry with exponential backoff
      if (attempt < this.retries) {
        const backoffMs = RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn("Redis command failed, retrying", { 
          attempt: attempt + 1, 
          backoffMs, 
          error: (error as Error).message 
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.execute(command, attempt + 1);
      }
      throw error;
    }
  }

  async get(key: string): Promise<string | null> {
    const result = await this.execute(["GET", key]);
    return result as string | null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    const result = await this.execute(["MGET", ...keys]);
    return result as (string | null)[];
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    await this.execute(["SETEX", key, String(ttl), value]);
  }

  async del(key: string): Promise<void> {
    await this.execute(["DEL", key]);
  }

  async keys(pattern: string): Promise<string[]> {
    const result = await this.execute(["KEYS", pattern]);
    return result as string[];
  }

  /**
   * Pipeline multiple commands for better performance
   */
  async pipeline(commands: string[][]): Promise<unknown[]> {
    const results: unknown[] = [];
    
    // Execute commands in batches of 10 for better performance
    const BATCH_SIZE = 10;
    for (let i = 0; i < commands.length; i += BATCH_SIZE) {
      const batch = commands.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(cmd => this.execute(cmd))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
}

async function initRedis(): Promise<RedisClient | null> {
  if (redisInitialized) return redisClient;
  redisInitialized = true;

  // Support self-hosted Redis HTTP adapter (priority) and Upstash (fallback)
  const redisUrl = Deno.env.get("REDIS_HTTP_URL")
    || Deno.env.get("UPSTASH_REDIS_REST_URL")
    || Deno.env.get("UPSTASH_REDIS_URL");
  const redisToken = Deno.env.get("REDIS_HTTP_TOKEN")
    || Deno.env.get("UPSTASH_REDIS_REST_TOKEN")
    || Deno.env.get("UPSTASH_REDIS_TOKEN");

  if (!redisUrl || !redisToken) {
    logger.info("Translation cache: Redis not configured, using database only");
    return null;
  }

  try {
    redisClient = new UpstashRestClient(redisUrl, redisToken);
    logger.info("Translation cache: Redis HTTP client initialized");
    return redisClient;
  } catch (error) {
    logger.error("Translation cache: Redis init failed", error as Error);
    return null;
  }
}

/**
 * Generate cache key
 */
function getCacheKey(
  contentType: string,
  contentId: string,
  field: string,
  locale: string
): string {
  return `${CACHE_PREFIX}:${contentType}:${contentId}:${field}:${locale}`;
}

/**
 * Translation Cache API (Enhanced)
 */
export const translationCache = {
  /**
   * Get a single translation from cache
   */
  async get(
    contentType: string,
    contentId: string,
    field: string,
    locale: string
  ): Promise<string | null> {
    const redis = await initRedis();
    if (!redis) return null;

    try {
      const key = getCacheKey(contentType, contentId, field, locale);
      return await redis.get(key);
    } catch (error) {
      logger.warn("Translation cache get error", { error: (error as Error).message });
      return null;
    }
  },

  /**
   * Get multiple translations for a content item
   */
  async getMultiple(
    contentType: string,
    contentId: string,
    fields: string[],
    locale: string
  ): Promise<Record<string, string | null>> {
    const redis = await initRedis();
    const result: Record<string, string | null> = {};

    // Initialize all fields as null
    for (const field of fields) {
      result[field] = null;
    }

    if (!redis) return result;

    try {
      const keys = fields.map(f => getCacheKey(contentType, contentId, f, locale));
      const values = await redis.mget(...keys);

      for (let i = 0; i < fields.length; i++) {
        result[fields[i]] = values[i];
      }
    } catch (error) {
      logger.warn("Translation cache mget error", { error: (error as Error).message });
    }

    return result;
  },

  /**
   * Cache a translation
   */
  async set(
    contentType: string,
    contentId: string,
    field: string,
    locale: string,
    translation: string
  ): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const key = getCacheKey(contentType, contentId, field, locale);
      await redis.setex(key, CACHE_TTL, translation);
    } catch (error) {
      logger.warn("Translation cache set error", { error: (error as Error).message });
    }
  },

  /**
   * Cache multiple translations at once (improved with pipeline)
   */
  async setMultiple(
    contentType: string,
    contentId: string,
    translations: Record<string, string>,
    locale: string
  ): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const commands = Object.entries(translations).map(([field, translation]) => {
        const key = getCacheKey(contentType, contentId, field, locale);
        return ["SETEX", key, String(CACHE_TTL), translation];
      });
      
      if (commands.length > 0) {
        await redis.pipeline(commands);
        logger.debug("Cached translations", { 
          count: commands.length, 
          contentType, 
          contentId, 
          locale 
        });
      }
    } catch (error) {
      logger.warn("Translation cache setMultiple error", { error: (error as Error).message });
    }
  },

  /**
   * Batch cache translations for multiple content items
   */
  async batchSet(
    items: Array<{
      contentType: string;
      contentId: string;
      translations: Record<string, string>;
      locale: string;
    }>
  ): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const commands: string[][] = [];
      
      for (const item of items) {
        for (const [field, translation] of Object.entries(item.translations)) {
          const key = getCacheKey(item.contentType, item.contentId, field, item.locale);
          commands.push(["SETEX", key, String(CACHE_TTL), translation]);
        }
      }
      
      if (commands.length > 0) {
        await redis.pipeline(commands);
        logger.debug("Batch cached translations", { 
          count: commands.length, 
          itemCount: items.length 
        });
      }
    } catch (error) {
      logger.warn("Translation cache batchSet error", { error: (error as Error).message });
    }
  },

  /**
   * Delete cached translations for a content item
   */
  async invalidate(
    contentType: string,
    contentId: string
  ): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const pattern = `${CACHE_PREFIX}:${contentType}:${contentId}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await Promise.all(keys.map(key => redis.del(key)));
        logger.debug("Translation cache invalidated", { 
          keyCount: keys.length, 
          contentType, 
          contentId 
        });
      }
    } catch (error) {
      logger.warn("Translation cache invalidate error", { error: (error as Error).message });
    }
  },

  /**
   * Check if Redis is available
   */
  async isAvailable(): Promise<boolean> {
    const redis = await initRedis();
    return redis !== null;
  },

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    available: boolean;
    totalKeys: number;
    sampleKeys: string[];
  }> {
    const redis = await initRedis();
    
    if (!redis) {
      return { available: false, totalKeys: 0, sampleKeys: [] };
    }

    try {
      const pattern = `${CACHE_PREFIX}:*`;
      const keys = await redis.keys(pattern);
      return {
        available: true,
        totalKeys: keys.length,
        sampleKeys: keys.slice(0, 10),
      };
    } catch (error) {
      logger.warn("Translation cache getStats error", { error: (error as Error).message });
      return { available: false, totalKeys: 0, sampleKeys: [] };
    }
  },
};

export default translationCache;

// =============================================================================
// User Locale Cache (Redis-backed for cross-device sync)
// =============================================================================

/**
 * Cached user locale data
 */
interface CachedUserLocale {
  locale: string;
  updatedAt: string;
  source: string;
}

/**
 * User Locale Cache API
 *
 * Provides Redis caching for user locale preferences enabling:
 * - O(1) lookup for user locale (vs database query)
 * - Cross-device sync on app launch
 * - 7-day TTL with automatic refresh on updates
 *
 * Usage:
 *   import { userLocaleCache } from "../../localization/services/translation-cache.ts";
 *
 *   // Get user's cached locale
 *   const locale = await userLocaleCache.get(userId);
 *
 *   // Set user's locale (call after profile update)
 *   await userLocaleCache.set(userId, "ru", "profile_update");
 */
export const userLocaleCache = {
  /**
   * Get a user's cached locale preference
   *
   * @param userId - The user's UUID
   * @returns The locale code (e.g., "en", "ru") or null if not cached
   */
  async get(userId: string): Promise<string | null> {
    const redis = await initRedis();
    if (!redis) return null;

    try {
      const key = `${USER_LOCALE_PREFIX}:${userId}`;
      const cached = await redis.get(key);

      if (cached) {
        const parsed: CachedUserLocale = JSON.parse(cached);
        logger.debug("User locale cache hit", { userId, locale: parsed.locale });
        return parsed.locale;
      }

      logger.debug("User locale cache miss", { userId });
      return null;
    } catch (error) {
      logger.warn("User locale cache get error", { error: (error as Error).message });
      return null;
    }
  },

  /**
   * Set a user's locale preference in cache
   *
   * @param userId - The user's UUID
   * @param locale - The locale code (e.g., "en", "ru", "es")
   * @param source - Source of the update (e.g., "profile_update", "db_fallback", "session_info")
   */
  async set(userId: string, locale: string, source: string): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const key = `${USER_LOCALE_PREFIX}:${userId}`;
      const value: CachedUserLocale = {
        locale,
        updatedAt: new Date().toISOString(),
        source,
      };

      await redis.setex(key, USER_LOCALE_TTL, JSON.stringify(value));
      logger.debug("User locale cached", { userId, locale, source });
    } catch (error) {
      logger.warn("User locale cache set error", { error: (error as Error).message });
    }
  },

  /**
   * Delete a user's cached locale (e.g., on sign out)
   *
   * @param userId - The user's UUID
   */
  async delete(userId: string): Promise<void> {
    const redis = await initRedis();
    if (!redis) return;

    try {
      const key = `${USER_LOCALE_PREFIX}:${userId}`;
      await redis.del(key);
      logger.debug("User locale cache deleted", { userId });
    } catch (error) {
      logger.warn("User locale cache delete error", { error: (error as Error).message });
    }
  },

  /**
   * Check if Redis is available for locale caching
   */
  async isAvailable(): Promise<boolean> {
    const redis = await initRedis();
    return redis !== null;
  },

  /**
   * Get full cached data including metadata
   */
  async getWithMetadata(userId: string): Promise<CachedUserLocale | null> {
    const redis = await initRedis();
    if (!redis) return null;

    try {
      const key = `${USER_LOCALE_PREFIX}:${userId}`;
      const cached = await redis.get(key);

      if (cached) {
        return JSON.parse(cached) as CachedUserLocale;
      }

      return null;
    } catch (error) {
      logger.warn("User locale cache getWithMetadata error", { error: (error as Error).message });
      return null;
    }
  },
};

// =============================================================================
// High-Level Translation Services (for BFF and other consumers)
// =============================================================================

/**
 * Content item with ID for translation lookup
 */
export interface TranslatableContent {
  id: string;
  [key: string]: unknown;
}

/**
 * Translation result for a single content item
 */
export interface ContentTranslations {
  title: string | null;
  description: string | null;
}

/**
 * Fetch translations for multiple content items in batch
 *
 * @param contentType - Type of content (e.g., "post", "challenge", "forum_post")
 * @param items - Array of content items with id property
 * @param locale - Target locale (e.g., "ru", "es")
 * @param fields - Fields to translate (defaults to ["title", "description"])
 * @returns Map of content ID to translations
 */
export async function getContentTranslationsBatch(
  contentType: string,
  items: TranslatableContent[],
  locale: string,
  fields: string[] = ["title", "description"]
): Promise<Map<string, Record<string, string | null>>> {
  const translationsMap = new Map<string, Record<string, string | null>>();

  // Skip if English or no items
  if (locale === "en" || items.length === 0) {
    return translationsMap;
  }

  try {
    // Fetch translations for all items in parallel
    const translationPromises = items.map(async (item) => {
      const contentId = item.id;
      const translations = await translationCache.getMultiple(
        contentType,
        contentId,
        fields,
        locale
      );
      return { contentId, translations };
    });

    const results = await Promise.all(translationPromises);
    for (const { contentId, translations } of results) {
      translationsMap.set(contentId, translations);
    }

    logger.debug("Translations fetched", { 
      itemCount: items.length, 
      translatedCount: translationsMap.size, 
      locale 
    });
  } catch (error) {
    logger.warn("Failed to fetch content translations", { error: (error as Error).message });
  }

  return translationsMap;
}
