/**
 * Distributed rate limiting service using Supabase
 * Persists across cold starts and works with multiple instances
 */

import { logger } from "../../_shared/logger.ts";
import { getSupabaseClient } from "./supabase.ts";

const DEFAULT_MAX_REQUESTS = 30; // requests per window
const DEFAULT_WINDOW_MS = 60000; // 1 minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
}

/**
 * Check rate limit using distributed Supabase storage
 * Returns detailed result for proper 429 response
 */
export async function checkRateLimitDistributed(
  userId: number,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS
): Promise<RateLimitResult> {
  const supabase = getSupabaseClient();
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  try {
    // Try to get existing rate limit record
    const { data: existing } = await supabase
      .from("telegram_rate_limits")
      .select("request_count, window_start")
      .eq("user_id", userId)
      .single();

    if (existing) {
      const existingWindowStart = new Date(existing.window_start);

      // Check if window has expired
      if (existingWindowStart < windowStart) {
        // Reset window
        await supabase.from("telegram_rate_limits").upsert({
          user_id: userId,
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

      // Window still active - check count
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

      // Increment count
      await supabase
        .from("telegram_rate_limits")
        .update({
          request_count: existing.request_count + 1,
          updated_at: now.toISOString(),
        })
        .eq("user_id", userId);

      return {
        allowed: true,
        remaining: maxRequests - existing.request_count - 1,
        resetAt: new Date(existingWindowStart.getTime() + windowMs),
      };
    }

    // No existing record - create new
    await supabase.from("telegram_rate_limits").insert({
      user_id: userId,
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
    // On database error, allow the request (fail open for availability)
    logger.error("Rate limit check failed, allowing request", { error: String(error) });
    return {
      allowed: true,
      remaining: maxRequests,
      resetAt: new Date(now.getTime() + windowMs),
    };
  }
}

/**
 * Simple synchronous check (falls back to in-memory for performance)
 * Used where async is not practical, with distributed as backup
 */
const inMemoryLimits = new Map<number, { count: number; resetAt: number }>();

export function checkRateLimit(
  userId: number,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS
): boolean {
  const now = Date.now();
  const userLimit = inMemoryLimits.get(userId);

  if (!userLimit || now > userLimit.resetAt) {
    inMemoryLimits.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (userLimit.count >= maxRequests) {
    return false;
  }

  userLimit.count++;
  return true;
}

/**
 * Get remaining requests for user
 */
export function getRemainingRequests(userId: number, maxRequests = DEFAULT_MAX_REQUESTS): number {
  const userLimit = inMemoryLimits.get(userId);
  if (!userLimit || Date.now() > userLimit.resetAt) {
    return maxRequests;
  }
  return Math.max(0, maxRequests - userLimit.count);
}

/**
 * Clean up old rate limit entries from database
 */
export async function cleanupOldRateLimits(): Promise<number> {
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

  try {
    const { data, error } = await supabase
      .from("telegram_rate_limits")
      .delete()
      .lt("updated_at", cutoff.toISOString())
      .select("user_id");

    if (error) {
      logger.error("Error cleaning up rate limits", { error: String(error) });
      return 0;
    }

    return data?.length || 0;
  } catch (error) {
    logger.error("Error in cleanupOldRateLimits", { error: String(error) });
    return 0;
  }
}
