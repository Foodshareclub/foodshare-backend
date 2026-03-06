/**
 * Shared Bot Rate Limiter Factory
 *
 * Generic distributed rate limiting for bot services.
 * Eliminates duplication between Telegram and WhatsApp bots.
 *
 * Usage:
 * ```ts
 * const rateLimiter = createBotRateLimiter({
 *   tableName: "telegram_rate_limits",
 *   idColumn: "user_id",
 * });
 * const result = await rateLimiter.checkDistributed(userId);
 * ```
 */

import { logger } from "../logger.ts";
import { getSupabaseClient } from "../supabase.ts";

// =============================================================================
// Types
// =============================================================================

export interface BotRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
}

export interface BotRateLimiterConfig {
  /** Database table name (e.g., "telegram_rate_limits") */
  tableName: string;
  /** Column name for the identifier (e.g., "user_id" or "phone_number") */
  idColumn: string;
  /** Default max requests per window */
  maxRequests?: number;
  /** Default window in milliseconds */
  windowMs?: number;
}

// =============================================================================
// Factory
// =============================================================================

const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const MAX_IN_MEMORY_ENTRIES = 5_000;

export function createBotRateLimiter(config: BotRateLimiterConfig) {
  const {
    tableName,
    idColumn,
    maxRequests: defaultMax = DEFAULT_MAX_REQUESTS,
    windowMs: defaultWindow = DEFAULT_WINDOW_MS,
  } = config;

  // In-memory fallback store (bounded)
  const inMemoryLimits = new Map<string, { count: number; resetAt: number }>();

  /**
   * Distributed rate limit check using Supabase
   */
  async function checkDistributed(
    id: string | number,
    maxRequests = defaultMax,
    windowMs = defaultWindow,
  ): Promise<BotRateLimitResult> {
    const supabase = getSupabaseClient();
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMs);

    try {
      const { data: existing } = await supabase
        .from(tableName)
        .select("request_count, window_start")
        .eq(idColumn, id)
        .single();

      if (existing) {
        const existingWindowStart = new Date(existing.window_start);

        // Window expired — reset
        if (existingWindowStart < windowStart) {
          await supabase.from(tableName).upsert({
            [idColumn]: id,
            request_count: 1,
            window_start: now.toISOString(),
            updated_at: now.toISOString(),
          });

          return {
            allowed: true,
            remaining: maxRequests - 1,
            resetAt: new Date(now.getTime() + windowMs),
          };
        }

        // Window active — check limit
        if (existing.request_count >= maxRequests) {
          const resetAt = new Date(existingWindowStart.getTime() + windowMs);
          const retryAfterSeconds = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);

          return {
            allowed: false,
            remaining: 0,
            resetAt,
            retryAfterSeconds: Math.max(1, retryAfterSeconds),
          };
        }

        // Increment
        await supabase
          .from(tableName)
          .update({
            request_count: existing.request_count + 1,
            updated_at: now.toISOString(),
          })
          .eq(idColumn, id);

        return {
          allowed: true,
          remaining: maxRequests - existing.request_count - 1,
          resetAt: new Date(existingWindowStart.getTime() + windowMs),
        };
      }

      // No existing record — create new
      await supabase.from(tableName).insert({
        [idColumn]: id,
        request_count: 1,
        window_start: now.toISOString(),
        updated_at: now.toISOString(),
      });

      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetAt: new Date(now.getTime() + windowMs),
      };
    } catch (error) {
      // Fail open for availability
      logger.error("Bot rate limit check failed, allowing request", { error: String(error) });
      return {
        allowed: true,
        remaining: maxRequests,
        resetAt: new Date(now.getTime() + windowMs),
      };
    }
  }

  /**
   * Synchronous in-memory rate limit check
   */
  function checkSync(
    id: string | number,
    maxRequests = defaultMax,
    windowMs = defaultWindow,
  ): boolean {
    const key = String(id);
    const now = Date.now();
    const userLimit = inMemoryLimits.get(key);

    if (!userLimit || now > userLimit.resetAt) {
      // Evict oldest if full
      if (inMemoryLimits.size >= MAX_IN_MEMORY_ENTRIES) {
        const firstKey = inMemoryLimits.keys().next().value;
        if (firstKey) inMemoryLimits.delete(firstKey);
      }
      inMemoryLimits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (userLimit.count >= maxRequests) {
      return false;
    }

    userLimit.count++;
    return true;
  }

  /**
   * Get remaining requests for an identifier
   */
  function getRemaining(id: string | number, maxRequests = defaultMax): number {
    const key = String(id);
    const userLimit = inMemoryLimits.get(key);
    if (!userLimit || Date.now() > userLimit.resetAt) {
      return maxRequests;
    }
    return Math.max(0, maxRequests - userLimit.count);
  }

  /**
   * Clean up old rate limit entries from database
   */
  async function cleanup(maxAgeMs = 5 * 60 * 1000): Promise<number> {
    const supabase = getSupabaseClient();
    const cutoff = new Date(Date.now() - maxAgeMs);

    try {
      const { data, error } = await supabase
        .from(tableName)
        .delete()
        .lt("updated_at", cutoff.toISOString())
        .select(idColumn);

      if (error) {
        logger.error("Error cleaning up rate limits", { table: tableName, error: String(error) });
        return 0;
      }

      return data?.length || 0;
    } catch (error) {
      logger.error("Error in rate limit cleanup", { table: tableName, error: String(error) });
      return 0;
    }
  }

  return {
    checkDistributed,
    checkSync,
    getRemaining,
    cleanup,
  };
}
