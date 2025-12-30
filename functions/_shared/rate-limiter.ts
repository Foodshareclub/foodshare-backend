/**
 * Rate Limiter
 *
 * Enterprise-grade rate limiting with support for:
 * - In-memory rate limiting (fast, single-instance)
 * - Distributed rate limiting (database-backed, multi-instance)
 * - Multiple key strategies (IP, user, device, custom)
 * - Sliding window algorithm
 * - Configurable response behavior
 *
 * @module rate-limiter
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { RateLimitError } from "./errors.ts";
import { logger } from "./logger.ts";

// =============================================================================
// Types
// =============================================================================

export interface RateLimitConfig {
  /** Maximum requests allowed in window */
  limit: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Use distributed store (database) vs in-memory */
  distributed?: boolean;
  /** Key prefix for namespacing */
  keyPrefix?: string;
}

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** When the window resets (Unix timestamp ms) */
  resetAt: number;
  /** Time until window resets (ms) */
  retryAfterMs: number;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: number;
}

// =============================================================================
// In-Memory Store (Single Instance)
// =============================================================================

interface MemoryEntry {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryEntry>();

// Periodic cleanup of expired entries
const CLEANUP_INTERVAL = 60000; // 1 minute
let cleanupTimer: number | null = null;

function startCleanup() {
  if (cleanupTimer === null) {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of memoryStore.entries()) {
        if (entry.resetAt < now) {
          memoryStore.delete(key);
        }
      }
    }, CLEANUP_INTERVAL) as unknown as number;
  }
}

/**
 * Check rate limit using in-memory store
 * Fast but not suitable for distributed environments
 */
export function checkMemoryRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  startCleanup();

  const now = Date.now();
  const fullKey = config.keyPrefix ? `${config.keyPrefix}:${key}` : key;
  const existing = memoryStore.get(fullKey);

  // Window expired or first request
  if (!existing || existing.resetAt < now) {
    const resetAt = now + config.windowMs;
    memoryStore.set(fullKey, { count: 1, resetAt });
    return {
      allowed: true,
      remaining: config.limit - 1,
      resetAt,
      retryAfterMs: 0,
    };
  }

  // Within window, check limit
  if (existing.count >= config.limit) {
    const retryAfterMs = existing.resetAt - now;
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterMs,
    };
  }

  // Increment and allow
  existing.count++;
  return {
    allowed: true,
    remaining: config.limit - existing.count,
    resetAt: existing.resetAt,
    retryAfterMs: 0,
  };
}

// =============================================================================
// Distributed Store (Database-backed)
// =============================================================================

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      throw new Error("Missing Supabase configuration for distributed rate limiting");
    }
    supabaseClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return supabaseClient;
}

/**
 * Check rate limit using distributed database store
 * Suitable for multi-instance deployments
 *
 * Requires the following RPC function:
 * ```sql
 * CREATE OR REPLACE FUNCTION check_rate_limit(
 *   p_key TEXT,
 *   p_limit INTEGER,
 *   p_window_ms BIGINT
 * ) RETURNS JSONB AS $$
 * DECLARE
 *   v_now BIGINT := EXTRACT(EPOCH FROM NOW()) * 1000;
 *   v_window_start BIGINT := v_now - p_window_ms;
 *   v_count INTEGER;
 *   v_reset_at BIGINT;
 * BEGIN
 *   -- Clean old entries and count current
 *   DELETE FROM rate_limit_entries
 *   WHERE key = p_key AND created_at < v_window_start;
 *
 *   SELECT COUNT(*) INTO v_count
 *   FROM rate_limit_entries
 *   WHERE key = p_key AND created_at >= v_window_start;
 *
 *   IF v_count >= p_limit THEN
 *     SELECT MIN(created_at) + p_window_ms INTO v_reset_at
 *     FROM rate_limit_entries
 *     WHERE key = p_key AND created_at >= v_window_start;
 *
 *     RETURN jsonb_build_object(
 *       'allowed', false,
 *       'remaining', 0,
 *       'reset_at', v_reset_at,
 *       'retry_after_ms', v_reset_at - v_now
 *     );
 *   END IF;
 *
 *   -- Insert new entry
 *   INSERT INTO rate_limit_entries (key, created_at)
 *   VALUES (p_key, v_now);
 *
 *   RETURN jsonb_build_object(
 *     'allowed', true,
 *     'remaining', p_limit - v_count - 1,
 *     'reset_at', v_now + p_window_ms,
 *     'retry_after_ms', 0
 *   );
 * END;
 * $$ LANGUAGE plpgsql;
 * ```
 */
export async function checkDistributedRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const fullKey = config.keyPrefix ? `${config.keyPrefix}:${key}` : key;

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_key: fullKey,
      p_limit: config.limit,
      p_window_ms: config.windowMs,
    });

    if (error) {
      logger.error("Distributed rate limit check failed", new Error(error.message));
      // Fail open - allow request if rate limiting fails
      return {
        allowed: true,
        remaining: config.limit,
        resetAt: Date.now() + config.windowMs,
        retryAfterMs: 0,
      };
    }

    return {
      allowed: data.allowed,
      remaining: data.remaining,
      resetAt: data.reset_at,
      retryAfterMs: data.retry_after_ms,
    };
  } catch (error) {
    logger.error("Rate limit error", error instanceof Error ? error : new Error(String(error)));
    // Fail open
    return {
      allowed: true,
      remaining: config.limit,
      resetAt: Date.now() + config.windowMs,
      retryAfterMs: 0,
    };
  }
}

// =============================================================================
// Unified Rate Limit Check
// =============================================================================

/**
 * Check rate limit using configured store
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (config.distributed) {
    return checkDistributedRateLimit(key, config);
  }
  return checkMemoryRateLimit(key, config);
}

/**
 * Check rate limit and throw RateLimitError if exceeded
 */
export async function enforceRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitInfo> {
  const result = await checkRateLimit(key, config);

  if (!result.allowed) {
    throw new RateLimitError("Rate limit exceeded", result.retryAfterMs);
  }

  return {
    limit: config.limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
  };
}

// =============================================================================
// Key Generators
// =============================================================================

/**
 * Generate rate limit key from IP address
 */
export function keyByIp(request: Request, prefix?: string): string {
  const ip = getClientIp(request);
  return prefix ? `${prefix}:ip:${ip}` : `ip:${ip}`;
}

/**
 * Generate rate limit key from user ID
 */
export function keyByUser(userId: string, prefix?: string): string {
  return prefix ? `${prefix}:user:${userId}` : `user:${userId}`;
}

/**
 * Generate rate limit key from device ID
 */
export function keyByDevice(request: Request, prefix?: string): string {
  const deviceId =
    request.headers.get("x-device-id") ||
    request.headers.get("x-client-id") ||
    getClientIp(request);
  return prefix ? `${prefix}:device:${deviceId}` : `device:${deviceId}`;
}

/**
 * Generate composite key from multiple identifiers
 */
export function keyComposite(parts: string[], prefix?: string): string {
  const key = parts.join(":");
  return prefix ? `${prefix}:${key}` : key;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// =============================================================================
// Response Headers
// =============================================================================

/**
 * Add rate limit headers to response
 */
export function addRateLimitHeaders(
  headers: Record<string, string>,
  info: RateLimitInfo
): Record<string, string> {
  return {
    ...headers,
    "X-RateLimit-Limit": String(info.limit),
    "X-RateLimit-Remaining": String(info.remaining),
    "X-RateLimit-Reset": String(Math.ceil(info.resetAt / 1000)),
  };
}

/**
 * Create rate limit exceeded response with proper headers
 */
export function rateLimitResponse(
  result: RateLimitResult,
  config: RateLimitConfig,
  corsHeaders: Record<string, string>
): Response {
  const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);

  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please try again later.",
        details: {
          retryAfterMs: result.retryAfterMs,
          retryAfterSec,
        },
      },
      meta: {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        responseTime: 0,
      },
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Limit": String(config.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    }
  );
}

// =============================================================================
// Preset Configurations
// =============================================================================

export const RateLimitPresets = {
  /** Standard API rate limit: 100 req/min */
  standard: { limit: 100, windowMs: 60000 } as RateLimitConfig,

  /** Strict rate limit for auth endpoints: 10 req/min */
  auth: { limit: 10, windowMs: 60000 } as RateLimitConfig,

  /** Very strict for sensitive operations: 5 req/min */
  sensitive: { limit: 5, windowMs: 60000 } as RateLimitConfig,

  /** Relaxed for read-heavy endpoints: 300 req/min */
  relaxed: { limit: 300, windowMs: 60000 } as RateLimitConfig,

  /** Burst-friendly: 50 req/10sec */
  burst: { limit: 50, windowMs: 10000 } as RateLimitConfig,

  /** Hourly limit: 1000 req/hour */
  hourly: { limit: 1000, windowMs: 3600000 } as RateLimitConfig,

  /** Daily limit: 10000 req/day */
  daily: { limit: 10000, windowMs: 86400000 } as RateLimitConfig,
} as const;
