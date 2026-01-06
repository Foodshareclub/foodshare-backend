/**
 * Unified Rate Limiter
 *
 * Enhanced rate limiting with:
 * - Tiered limits based on user type
 * - Per-endpoint configuration
 * - Sliding window + burst protection
 * - Distributed support for multi-instance
 * - Automatic config lookup
 *
 * @module rate-limiter-unified
 */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { RateLimitError } from "./errors.ts";
import { logger } from "./logger.ts";
import {
  type UserTier,
  type EndpointRateLimitConfig,
  type CategoryLimits,
  findEndpointConfig,
  getEffectiveLimits,
  getDefaultConfig,
} from "./rate-limit-config.ts";

// =============================================================================
// Types
// =============================================================================

export interface UnifiedRateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Remaining requests in hourly window */
  remainingHourly: number;
  /** When the minute window resets (Unix timestamp ms) */
  resetAt: number;
  /** When the hourly window resets (Unix timestamp ms) */
  resetAtHourly: number;
  /** Time until next request allowed (ms) */
  retryAfterMs: number;
  /** User's effective tier */
  tier: UserTier;
  /** The limits that were applied */
  limits: CategoryLimits;
  /** Whether burst limit was hit */
  burstLimitHit: boolean;
}

export interface UnifiedRateLimitHeaders {
  "X-RateLimit-Limit": string;
  "X-RateLimit-Remaining": string;
  "X-RateLimit-Reset": string;
  "X-RateLimit-Limit-Hour": string;
  "X-RateLimit-Remaining-Hour": string;
  "X-RateLimit-Reset-Hour": string;
  "X-RateLimit-Tier": string;
  "Retry-After"?: string;
}

export interface RateLimitContext {
  /** Request object */
  request: Request;
  /** Authenticated user ID (null for anonymous) */
  userId: string | null;
  /** User's tier (detected or provided) */
  userTier?: UserTier;
  /** Override endpoint path */
  endpointPath?: string;
  /** Supabase client for tier lookup */
  supabase?: SupabaseClient;
}

// =============================================================================
// In-Memory Store with Multi-Window Support
// =============================================================================

interface MultiWindowEntry {
  minuteCount: number;
  minuteResetAt: number;
  hourCount: number;
  hourResetAt: number;
  burstCount: number;
  burstResetAt: number;
}

const memoryStore = new Map<string, MultiWindowEntry>();

// Cleanup expired entries periodically
const CLEANUP_INTERVAL = 60000;
let cleanupTimer: number | null = null;

function startCleanup() {
  if (cleanupTimer === null) {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of memoryStore.entries()) {
        // Remove if all windows expired
        if (
          entry.minuteResetAt < now &&
          entry.hourResetAt < now &&
          entry.burstResetAt < now
        ) {
          memoryStore.delete(key);
        }
      }
    }, CLEANUP_INTERVAL) as unknown as number;
  }
}

// =============================================================================
// User Tier Detection
// =============================================================================

const tierCache = new Map<string, { tier: UserTier; expiresAt: number }>();
const TIER_CACHE_TTL = 300000; // 5 minutes

async function getUserTier(
  userId: string | null,
  supabase?: SupabaseClient
): Promise<UserTier> {
  if (!userId) return "anonymous";

  // Check cache
  const cached = tierCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tier;
  }

  if (!supabase) return "free";

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("tier, is_verified, is_admin")
      .eq("id", userId)
      .single();

    if (error || !data) return "free";

    let tier: UserTier = "free";
    if (data.is_admin) {
      tier = "admin";
    } else if (data.tier === "premium") {
      tier = "premium";
    } else if (data.is_verified) {
      tier = "verified";
    }

    // Cache the result
    tierCache.set(userId, {
      tier,
      expiresAt: Date.now() + TIER_CACHE_TTL,
    });

    return tier;
  } catch {
    return "free";
  }
}

// =============================================================================
// Unified Rate Limit Check
// =============================================================================

/**
 * Check rate limits for a request with unified configuration
 */
export async function checkUnifiedRateLimit(
  ctx: RateLimitContext
): Promise<UnifiedRateLimitResult> {
  startCleanup();

  const { request, userId, supabase } = ctx;
  const url = new URL(request.url);
  const path = ctx.endpointPath || url.pathname;
  const method = request.method;

  // Find endpoint config
  const endpointConfig = findEndpointConfig(path, method) || getDefaultConfig();

  // Skip if configured
  if (endpointConfig.skip) {
    return createAllowedResult("admin", getEffectiveLimits(endpointConfig, "admin"));
  }

  // Get user tier
  const userTier = ctx.userTier || await getUserTier(userId, supabase);

  // Get effective limits for this tier
  const limits = getEffectiveLimits(endpointConfig, userTier);

  // Generate rate limit key
  const key = generateKey(request, userId, path, method);

  // Check limits
  if (endpointConfig.distributed) {
    return checkDistributed(key, limits, userTier, supabase);
  }

  return checkMemory(key, limits, userTier);
}

/**
 * Generate rate limit key
 */
function generateKey(
  request: Request,
  userId: string | null,
  path: string,
  method: string
): string {
  const identifier = userId || getClientIp(request);
  return `rl:${method}:${path}:${identifier}`;
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

/**
 * Check rate limits using in-memory store
 */
function checkMemory(
  key: string,
  limits: CategoryLimits,
  tier: UserTier
): UnifiedRateLimitResult {
  const now = Date.now();

  let entry = memoryStore.get(key);

  // Initialize or reset expired windows
  if (!entry) {
    entry = {
      minuteCount: 0,
      minuteResetAt: now + 60000,
      hourCount: 0,
      hourResetAt: now + 3600000,
      burstCount: 0,
      burstResetAt: now + limits.burstWindowMs,
    };
    memoryStore.set(key, entry);
  } else {
    if (entry.minuteResetAt < now) {
      entry.minuteCount = 0;
      entry.minuteResetAt = now + 60000;
    }
    if (entry.hourResetAt < now) {
      entry.hourCount = 0;
      entry.hourResetAt = now + 3600000;
    }
    if (entry.burstResetAt < now) {
      entry.burstCount = 0;
      entry.burstResetAt = now + limits.burstWindowMs;
    }
  }

  // Check burst limit
  if (entry.burstCount >= limits.burstLimit) {
    return {
      allowed: false,
      remaining: 0,
      remainingHourly: Math.max(0, limits.perHour - entry.hourCount),
      resetAt: entry.minuteResetAt,
      resetAtHourly: entry.hourResetAt,
      retryAfterMs: entry.burstResetAt - now,
      tier,
      limits,
      burstLimitHit: true,
    };
  }

  // Check minute limit
  if (entry.minuteCount >= limits.perMinute) {
    return {
      allowed: false,
      remaining: 0,
      remainingHourly: Math.max(0, limits.perHour - entry.hourCount),
      resetAt: entry.minuteResetAt,
      resetAtHourly: entry.hourResetAt,
      retryAfterMs: entry.minuteResetAt - now,
      tier,
      limits,
      burstLimitHit: false,
    };
  }

  // Check hour limit
  if (entry.hourCount >= limits.perHour) {
    return {
      allowed: false,
      remaining: 0,
      remainingHourly: 0,
      resetAt: entry.minuteResetAt,
      resetAtHourly: entry.hourResetAt,
      retryAfterMs: entry.hourResetAt - now,
      tier,
      limits,
      burstLimitHit: false,
    };
  }

  // Increment counters
  entry.minuteCount++;
  entry.hourCount++;
  entry.burstCount++;

  return {
    allowed: true,
    remaining: limits.perMinute - entry.minuteCount,
    remainingHourly: limits.perHour - entry.hourCount,
    resetAt: entry.minuteResetAt,
    resetAtHourly: entry.hourResetAt,
    retryAfterMs: 0,
    tier,
    limits,
    burstLimitHit: false,
  };
}

/**
 * Check rate limits using distributed store
 */
async function checkDistributed(
  key: string,
  limits: CategoryLimits,
  tier: UserTier,
  supabase?: SupabaseClient
): Promise<UnifiedRateLimitResult> {
  if (!supabase) {
    // Fall back to memory if no supabase client
    return checkMemory(key, limits, tier);
  }

  try {
    const { data, error } = await supabase.rpc("check_rate_limit_unified", {
      p_key: key,
      p_minute_limit: limits.perMinute,
      p_hour_limit: limits.perHour,
      p_burst_limit: limits.burstLimit,
      p_burst_window_ms: limits.burstWindowMs,
    });

    if (error) {
      logger.error("Distributed rate limit check failed", new Error(error.message));
      // Fail open
      return createAllowedResult(tier, limits);
    }

    return {
      allowed: data.allowed,
      remaining: data.remaining,
      remainingHourly: data.remaining_hourly,
      resetAt: data.reset_at,
      resetAtHourly: data.reset_at_hourly,
      retryAfterMs: data.retry_after_ms,
      tier,
      limits,
      burstLimitHit: data.burst_limit_hit || false,
    };
  } catch (err) {
    logger.error("Rate limit error", err instanceof Error ? err : new Error(String(err)));
    return createAllowedResult(tier, limits);
  }
}

function createAllowedResult(tier: UserTier, limits: CategoryLimits): UnifiedRateLimitResult {
  const now = Date.now();
  return {
    allowed: true,
    remaining: limits.perMinute,
    remainingHourly: limits.perHour,
    resetAt: now + 60000,
    resetAtHourly: now + 3600000,
    retryAfterMs: 0,
    tier,
    limits,
    burstLimitHit: false,
  };
}

// =============================================================================
// Enforce Rate Limit
// =============================================================================

/**
 * Check rate limit and throw if exceeded
 */
export async function enforceUnifiedRateLimit(
  ctx: RateLimitContext
): Promise<UnifiedRateLimitResult> {
  const result = await checkUnifiedRateLimit(ctx);

  if (!result.allowed) {
    throw new RateLimitError(
      result.burstLimitHit
        ? "Too many requests in short period. Please slow down."
        : "Rate limit exceeded. Please try again later.",
      result.retryAfterMs
    );
  }

  return result;
}

// =============================================================================
// Response Helpers
// =============================================================================

/**
 * Generate rate limit headers from result
 */
export function getUnifiedRateLimitHeaders(
  result: UnifiedRateLimitResult
): UnifiedRateLimitHeaders {
  const headers: UnifiedRateLimitHeaders = {
    "X-RateLimit-Limit": String(result.limits.perMinute),
    "X-RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
    "X-RateLimit-Limit-Hour": String(result.limits.perHour),
    "X-RateLimit-Remaining-Hour": String(Math.max(0, result.remainingHourly)),
    "X-RateLimit-Reset-Hour": String(Math.ceil(result.resetAtHourly / 1000)),
    "X-RateLimit-Tier": result.tier,
  };

  if (!result.allowed) {
    headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
  }

  return headers;
}

/**
 * Create rate limit exceeded response
 */
export function createRateLimitResponse(
  result: UnifiedRateLimitResult,
  corsHeaders: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: {
        code: result.burstLimitHit ? "BURST_LIMIT_EXCEEDED" : "RATE_LIMIT_EXCEEDED",
        message: result.burstLimitHit
          ? "Too many requests in a short period. Please slow down."
          : "Rate limit exceeded. Please try again later.",
        details: {
          retryAfterMs: result.retryAfterMs,
          retryAfterSec: Math.ceil(result.retryAfterMs / 1000),
          tier: result.tier,
          limits: {
            perMinute: result.limits.perMinute,
            perHour: result.limits.perHour,
          },
        },
      },
      meta: {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      },
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        ...getUnifiedRateLimitHeaders(result),
      },
    }
  );
}

// =============================================================================
// Middleware Helper
// =============================================================================

/**
 * Rate limit middleware for use with API handlers
 */
export async function rateLimitMiddleware(
  request: Request,
  userId: string | null,
  supabase?: SupabaseClient,
  corsHeaders: Record<string, string> = {}
): Promise<Response | null> {
  try {
    const result = await checkUnifiedRateLimit({
      request,
      userId,
      supabase,
    });

    if (!result.allowed) {
      return createRateLimitResponse(result, corsHeaders);
    }

    // Return null to indicate request is allowed
    return null;
  } catch (error) {
    logger.error("Rate limit middleware error", error instanceof Error ? error : new Error(String(error)));
    // Fail open
    return null;
  }
}

// =============================================================================
// Exports
// =============================================================================

export {
  type UserTier,
  type EndpointRateLimitConfig,
  type CategoryLimits,
} from "./rate-limit-config.ts";
