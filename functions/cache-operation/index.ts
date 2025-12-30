/**
 * Secure Cache Operation Edge Function
 *
 * Provides secure, proxied access to Upstash Redis for iOS/Android clients.
 * Credentials are stored in Supabase Vault and never exposed to clients.
 *
 * Features:
 * - Authentication required
 * - Rate limiting (60 requests/minute per user)
 * - Audit logging
 * - User-scoped cache keys
 * - Comprehensive error handling
 *
 * Security:
 * - Redis credentials fetched from Vault (service role only)
 * - All operations scoped to authenticated user
 * - Keys must be prefixed with user:{user_id}:
 *
 * Usage:
 * POST /cache-operation
 * { "operation": "get|set|delete|incr|expire|exists|ttl", "key": "user:xxx:...", "value": "...", "ttl": 3600 }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError, AuthError, ServerError } from "../_shared/errors.ts";

// =============================================================================
// Request Schema
// =============================================================================

const cacheOperationSchema = z.object({
  operation: z.enum(["get", "set", "delete", "incr", "expire", "exists", "ttl"]),
  key: z.string().min(1),
  value: z.string().optional(),
  ttl: z.number().optional().default(3600),
});

type CacheOperationRequest = z.infer<typeof cacheOperationSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface CacheResponse {
  success: boolean;
  operation: string;
  result: unknown;
  user_id: string;
}

// =============================================================================
// Redis Operation Helpers
// =============================================================================

async function executeRedisCommand(
  redisUrl: string,
  redisToken: string,
  command: string[]
): Promise<unknown> {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new ServerError(`Redis command failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleCacheOperation(
  ctx: HandlerContext<CacheOperationRequest>
): Promise<Response> {
  const { supabase, body, userId, ctx: requestCtx } = ctx;
  const { operation, key, value, ttl } = body;

  // Validate user is authenticated
  if (!userId) {
    throw new AuthError("Authentication required");
  }

  logger.info("Cache operation request", {
    operation,
    key: key.substring(0, 30),
    userId: userId.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  // Security: Ensure key is scoped to user
  const userPrefix = `user:${userId}:`;
  if (!key.startsWith(userPrefix)) {
    throw new ValidationError(`Invalid cache key. Must be scoped to user: ${userPrefix}`);
  }

  // Check rate limit via database
  const { data: withinLimit, error: rateLimitError } = await supabase.rpc(
    "check_rate_limit",
    {
      user_id: userId,
      operation: "cache_operation",
      max_requests: 60,
      time_window_seconds: 60,
    }
  );

  if (rateLimitError) {
    logger.error("Rate limit check failed", { error: rateLimitError.message });
    // Continue anyway - don't block legitimate requests
  } else if (withinLimit === false) {
    logger.warn("Rate limit exceeded", { userId: userId.substring(0, 8) });
    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded. Maximum 60 requests per minute.",
        status: 429,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      }
    );
  }

  // Get request metadata for audit
  const requestMetadata = {
    ip_address: requestCtx?.ip || "unknown",
    user_agent: requestCtx?.userAgent || "unknown",
    request_id: requestCtx?.requestId,
  };

  // Fetch Redis credentials from Vault
  const { data: redisUrl, error: urlError } = await supabase.rpc(
    "get_secret_audited",
    {
      secret_name: "UPSTASH_REDIS_URL",
      requesting_user_id: userId,
      request_metadata: requestMetadata,
    }
  );

  const { data: redisToken, error: tokenError } = await supabase.rpc(
    "get_secret_audited",
    {
      secret_name: "UPSTASH_REDIS_TOKEN",
      requesting_user_id: userId,
      request_metadata: requestMetadata,
    }
  );

  if (urlError || tokenError || !redisUrl || !redisToken) {
    logger.error("Failed to retrieve Redis credentials from Vault", {
      urlError: urlError?.message,
      tokenError: tokenError?.message,
    });
    throw new ServerError("Failed to retrieve cache service credentials");
  }

  // Execute Redis operation
  let result: unknown;

  switch (operation) {
    case "get":
      result = { value: await executeRedisCommand(redisUrl, redisToken, ["GET", key]) };
      break;

    case "set":
      if (value === undefined) {
        throw new ValidationError("Missing value for set operation");
      }
      const setResult = await executeRedisCommand(redisUrl, redisToken, ["SETEX", key, String(ttl), value]);
      result = { success: setResult === "OK", ttl };
      break;

    case "delete":
      result = { deleted: await executeRedisCommand(redisUrl, redisToken, ["DEL", key]) };
      break;

    case "incr":
      result = { value: await executeRedisCommand(redisUrl, redisToken, ["INCR", key]) };
      break;

    case "expire":
      if (!ttl || ttl <= 0) {
        throw new ValidationError("Invalid TTL for expire operation");
      }
      const expireResult = await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", key, String(ttl)]);
      result = { success: expireResult === 1, ttl };
      break;

    case "exists":
      const existsResult = await executeRedisCommand(redisUrl, redisToken, ["EXISTS", key]);
      result = { exists: existsResult === 1 };
      break;

    case "ttl":
      result = { ttl: await executeRedisCommand(redisUrl, redisToken, ["TTL", key]) };
      break;
  }

  logger.info("Cache operation successful", {
    operation,
    userId: userId.substring(0, 8),
  });

  const response: CacheResponse = {
    success: true,
    operation,
    result,
    user_id: userId,
  };

  return ok(response, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "cache-operation",
  version: "2.0.0",
  requireAuth: true, // Must be authenticated
  routes: {
    POST: {
      schema: cacheOperationSchema,
      handler: handleCacheOperation,
    },
  },
});
