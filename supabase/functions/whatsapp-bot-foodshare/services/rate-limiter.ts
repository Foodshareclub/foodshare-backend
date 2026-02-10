/**
 * Distributed rate limiting service for WhatsApp
 * Uses phone number as identifier
 */

import { logger } from "../../_shared/logger.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60000; // 1 minute

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds?: number;
}

/**
 * Check rate limit using distributed Supabase storage
 */
export async function checkRateLimitDistributed(
  phoneNumber: string,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<RateLimitResult> {
  const supabase = getSupabaseClient();
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  try {
    const { data: existing } = await supabase
      .from("whatsapp_rate_limits")
      .select("request_count, window_start")
      .eq("phone_number", phoneNumber)
      .single();

    if (existing) {
      const existingWindowStart = new Date(existing.window_start);

      // Check if window has expired
      if (existingWindowStart < windowStart) {
        // Reset window
        await supabase.from("whatsapp_rate_limits").upsert({
          phone_number: phoneNumber,
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
        .from("whatsapp_rate_limits")
        .update({
          request_count: existing.request_count + 1,
          updated_at: now.toISOString(),
        })
        .eq("phone_number", phoneNumber);

      return {
        allowed: true,
        remaining: maxRequests - existing.request_count - 1,
        resetAt: new Date(existingWindowStart.getTime() + windowMs),
      };
    }

    // No existing record - create new
    await supabase.from("whatsapp_rate_limits").insert({
      phone_number: phoneNumber,
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
 * In-memory rate limiting for sync checks
 */
const inMemoryLimits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(
  phoneNumber: string,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowMs = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const userLimit = inMemoryLimits.get(phoneNumber);

  if (!userLimit || now > userLimit.resetAt) {
    inMemoryLimits.set(phoneNumber, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (userLimit.count >= maxRequests) {
    return false;
  }

  userLimit.count++;
  return true;
}
