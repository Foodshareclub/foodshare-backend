/**
 * Cache operation handler (POST) for api-v1-cache.
 *
 * Handles all Redis CRUD operations: string, batch, hash, list,
 * sorted set, set, and utility operations.
 */

import { ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { ValidationError, AuthenticationError as AuthError, ServerError } from "../../_shared/errors.ts";
import {
  CONFIG,
  circuitBreaker,
  metrics,
  type CacheOperationRequest,
} from "./types.ts";
import {
  isCircuitBreakerOpen,
  recordSuccess,
  recordFailure,
  executeRedisCommand,
  executeRedisPipeline,
  coalesceRequest,
  compressValue,
  decompressValue,
  shouldCompress,
  validateAndScopeKey,
  isWriteOperation,
  getOperationType,
  checkRateLimit,
  parseRedisInfo,
} from "./redis.ts";

// =============================================================================
// POST Handler (Cache Operations)
// =============================================================================

export async function handleCacheOperation(
  ctx: HandlerContext<CacheOperationRequest>
): Promise<Response> {
  const startTime = performance.now();
  metrics.totalRequests++;

  const { supabase, body, userId, ctx: requestCtx } = ctx;
  const { operation, options } = body;

  // Health check (no auth required)
  if (operation === "health" || operation === "ping") {
    return ok({
      success: true,
      operation,
      result: {
        status: isCircuitBreakerOpen() ? "degraded" : "healthy",
        version: CONFIG.version,
        circuitBreaker: circuitBreaker.state,
        metrics: {
          totalRequests: metrics.totalRequests,
          successRate: metrics.totalRequests > 0
            ? metrics.successfulRequests / metrics.totalRequests
            : 1,
          averageLatencyMs: metrics.averageLatencyMs,
        },
      },
      metadata: { version: CONFIG.version, executionMs: Math.round(performance.now() - startTime) },
    }, ctx);
  }

  // Check circuit breaker
  if (isCircuitBreakerOpen()) {
    return new Response(
      JSON.stringify({
        error: "Service temporarily unavailable (circuit breaker open)",
        status: 503,
        retryAfter: Math.ceil(
          (CONFIG.circuitBreaker.resetTimeoutMs - (Date.now() - circuitBreaker.lastFailure)) / 1000
        ),
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(CONFIG.circuitBreaker.resetTimeoutMs / 1000)),
        },
      }
    );
  }

  // Rate limiting
  if (userId) {
    const tier: keyof typeof CONFIG.rateLimits = "pro";
    const allowed = await checkRateLimit(supabase, userId, operation, tier);

    if (!allowed) {
      const opType = getOperationType(operation);
      const limit = CONFIG.rateLimits[tier][opType];
      return new Response(
        JSON.stringify({
          error: `Rate limit exceeded. Maximum ${limit} ${opType} operations per minute.`,
          status: 429,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        }
      );
    }
  }

  logger.info("Cache operation", {
    operation,
    key: body.key?.substring(0, 30),
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  // Get Redis credentials
  const requestMetadata = {
    ip_address: requestCtx?.ip || "unknown",
    user_agent: requestCtx?.userAgent || "unknown",
    request_id: requestCtx?.requestId,
  };

  const [urlResult, tokenResult] = await Promise.all([
    supabase.rpc("get_secret_audited", {
      secret_name: "UPSTASH_REDIS_URL",
      requesting_user_id: userId || "anonymous",
      request_metadata: requestMetadata,
    }),
    supabase.rpc("get_secret_audited", {
      secret_name: "UPSTASH_REDIS_TOKEN",
      requesting_user_id: userId || "anonymous",
      request_metadata: requestMetadata,
    }),
  ]);

  if (urlResult.error || tokenResult.error || !urlResult.data || !tokenResult.data) {
    throw new ServerError("Failed to retrieve cache credentials");
  }

  const redisUrl = urlResult.data;
  const redisToken = tokenResult.data;

  // Execute operation
  let result: unknown;
  let compressed = false;
  const isWrite = isWriteOperation(operation);

  try {
    const shouldCoalesce = !isWrite && options?.coalesce !== false && body.key;
    const coalescingKey = shouldCoalesce ? `${operation}:${body.key}` : null;

    const executeOperation = async () => {
      switch (operation) {
        // String Operations
        case "get": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          let value = await executeRedisCommand(redisUrl, redisToken, ["GET", scopedKey]) as string | null;
          if (value) value = await decompressValue(value);
          return { value };
        }

        case "set": {
          if (!body.key) throw new ValidationError("Missing key");
          if (body.value === undefined) throw new ValidationError("Missing value");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          let valueToStore = typeof body.value === "string" ? body.value : JSON.stringify(body.value);

          if (shouldCompress(valueToStore, options)) {
            valueToStore = await compressValue(valueToStore);
            compressed = true;
          }

          const ttl = body.ttl || CONFIG.ttlPresets.medium;
          const cmd: (string | number)[] = ["SET", scopedKey, valueToStore, "EX", ttl];
          if (options?.nx) cmd.push("NX");
          if (options?.xx) cmd.push("XX");

          const setResult = await executeRedisCommand(redisUrl, redisToken, cmd);
          return { success: setResult === "OK", ttl };
        }

        case "getset": {
          if (!body.key) throw new ValidationError("Missing key");
          if (body.value === undefined) throw new ValidationError("Missing value");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          let valueToStore = typeof body.value === "string" ? body.value : JSON.stringify(body.value);

          if (shouldCompress(valueToStore, options)) {
            valueToStore = await compressValue(valueToStore);
          }

          let oldValue = await executeRedisCommand(redisUrl, redisToken, ["GETSET", scopedKey, valueToStore]) as string | null;
          if (oldValue) oldValue = await decompressValue(oldValue);

          if (body.ttl) {
            await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          }

          return { oldValue, success: true };
        }

        case "delete": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { deleted: await executeRedisCommand(redisUrl, redisToken, ["DEL", scopedKey]) };
        }

        case "incr": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { value: await executeRedisCommand(redisUrl, redisToken, ["INCR", scopedKey]) };
        }

        case "decr": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { value: await executeRedisCommand(redisUrl, redisToken, ["DECR", scopedKey]) };
        }

        case "expire": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.ttl || body.ttl <= 0) throw new ValidationError("Invalid TTL");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const expireResult = await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          return { success: expireResult === 1, ttl: body.ttl };
        }

        case "exists": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { exists: (await executeRedisCommand(redisUrl, redisToken, ["EXISTS", scopedKey])) === 1 };
        }

        case "ttl": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { ttl: await executeRedisCommand(redisUrl, redisToken, ["TTL", scopedKey]) };
        }

        // Batch Operations
        case "mget": {
          if (!body.keys?.length) throw new ValidationError("Missing keys");
          const scopedKeys = body.keys.map(k => validateAndScopeKey(k, userId, false).scopedKey);
          const values = await executeRedisCommand(redisUrl, redisToken, ["MGET", ...scopedKeys]) as (string | null)[];
          const decompressed = await Promise.all(values.map(v => v ? decompressValue(v) : null));
          return { values: decompressed };
        }

        case "mset": {
          if (!body.pairs) throw new ValidationError("Missing key-value pairs");
          const entries = Object.entries(body.pairs);
          if (entries.length > CONFIG.maxBatchSize) {
            throw new ValidationError(`Maximum ${CONFIG.maxBatchSize} pairs allowed`);
          }

          const scopedPairs: string[] = [];
          for (const [key, value] of entries) {
            const { scopedKey } = validateAndScopeKey(key, userId, true);
            let valueToStore = value;
            if (shouldCompress(value, options)) {
              valueToStore = await compressValue(value);
            }
            scopedPairs.push(scopedKey, valueToStore);
          }

          await executeRedisCommand(redisUrl, redisToken, ["MSET", ...scopedPairs]);

          const ttl = body.ttl || CONFIG.ttlPresets.medium;
          const pipeline = entries.map((_, i) => ["EXPIRE", scopedPairs[i * 2], ttl] as (string | number)[]);
          await executeRedisPipeline(redisUrl, redisToken, pipeline);

          return { success: true, count: entries.length };
        }

        case "mdel": {
          if (!body.keys?.length) throw new ValidationError("Missing keys");
          const scopedKeys = body.keys.map(k => validateAndScopeKey(k, userId, true).scopedKey);
          return { deleted: await executeRedisCommand(redisUrl, redisToken, ["DEL", ...scopedKeys]) };
        }

        // Hash Operations
        case "hget": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.field) throw new ValidationError("Missing field");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          let value = await executeRedisCommand(redisUrl, redisToken, ["HGET", scopedKey, body.field]) as string | null;
          if (value) value = await decompressValue(value);
          return { value };
        }

        case "hmget": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.fields?.length) throw new ValidationError("Missing fields");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const values = await executeRedisCommand(redisUrl, redisToken, ["HMGET", scopedKey, ...body.fields]) as (string | null)[];
          const decompressed = await Promise.all(values.map(v => v ? decompressValue(v) : null));

          const hashResult: Record<string, string | null> = {};
          body.fields.forEach((field, i) => {
            hashResult[field] = decompressed[i];
          });
          return { values: hashResult };
        }

        case "hset": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.field || body.value === undefined) throw new ValidationError("Missing field or value");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          let valueToStore = typeof body.value === "string" ? body.value : JSON.stringify(body.value);
          if (shouldCompress(valueToStore, options)) {
            valueToStore = await compressValue(valueToStore);
          }
          const hsetResult = await executeRedisCommand(redisUrl, redisToken, ["HSET", scopedKey, body.field, valueToStore]);

          if (body.ttl) {
            await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          }

          return { created: hsetResult === 1 };
        }

        case "hmset": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.fieldValues) throw new ValidationError("Missing fieldValues");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);

          const args: string[] = [scopedKey];
          for (const [field, value] of Object.entries(body.fieldValues)) {
            let valueToStore = value;
            if (shouldCompress(value, options)) {
              valueToStore = await compressValue(value);
            }
            args.push(field, valueToStore);
          }

          await executeRedisCommand(redisUrl, redisToken, ["HMSET", ...args]);

          if (body.ttl) {
            await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          }

          return { success: true };
        }

        case "hgetall": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const rawResult = await executeRedisCommand(redisUrl, redisToken, ["HGETALL", scopedKey]) as string[];

          const hash: Record<string, string> = {};
          for (let i = 0; i < rawResult.length; i += 2) {
            hash[rawResult[i]] = await decompressValue(rawResult[i + 1]);
          }
          return { hash };
        }

        case "hdel": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.fields?.length) throw new ValidationError("Missing fields");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { deleted: await executeRedisCommand(redisUrl, redisToken, ["HDEL", scopedKey, ...body.fields]) };
        }

        case "hincrby": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.field) throw new ValidationError("Missing field");
          const increment = typeof body.value === "number" ? body.value : 1;
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { value: await executeRedisCommand(redisUrl, redisToken, ["HINCRBY", scopedKey, body.field, increment]) };
        }

        // List Operations
        case "lpush": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.values?.length) throw new ValidationError("Missing values");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const length = await executeRedisCommand(redisUrl, redisToken, ["LPUSH", scopedKey, ...body.values]);
          if (body.ttl) await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          return { length };
        }

        case "rpush": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.values?.length) throw new ValidationError("Missing values");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const length = await executeRedisCommand(redisUrl, redisToken, ["RPUSH", scopedKey, ...body.values]);
          if (body.ttl) await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          return { length };
        }

        case "lrange": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { values: await executeRedisCommand(redisUrl, redisToken, ["LRANGE", scopedKey, body.start ?? 0, body.stop ?? -1]) };
        }

        case "lpop": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { value: await executeRedisCommand(redisUrl, redisToken, ["LPOP", scopedKey]) };
        }

        case "rpop": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { value: await executeRedisCommand(redisUrl, redisToken, ["RPOP", scopedKey]) };
        }

        case "llen": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { length: await executeRedisCommand(redisUrl, redisToken, ["LLEN", scopedKey]) };
        }

        case "ltrim": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          await executeRedisCommand(redisUrl, redisToken, ["LTRIM", scopedKey, body.start ?? 0, body.stop ?? -1]);
          return { success: true };
        }

        // Sorted Set Operations
        case "zadd": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);

          if (body.members?.length) {
            const args: (string | number)[] = ["ZADD", scopedKey];
            for (const { score, member } of body.members) {
              args.push(score, member);
            }
            const added = await executeRedisCommand(redisUrl, redisToken, args);
            if (body.ttl) await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
            return { added };
          } else if (body.score !== undefined && body.member) {
            const added = await executeRedisCommand(redisUrl, redisToken, ["ZADD", scopedKey, body.score, body.member]);
            if (body.ttl) await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
            return { added };
          }
          throw new ValidationError("Missing score/member");
        }

        case "zrange": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const cmd: (string | number)[] = [
            options?.reverse ? "ZREVRANGE" : "ZRANGE",
            scopedKey, body.start ?? 0, body.stop ?? -1,
          ];
          if (options?.withScores) cmd.push("WITHSCORES");

          const rawResult = await executeRedisCommand(redisUrl, redisToken, cmd) as string[];

          if (options?.withScores) {
            const members: { member: string; score: number }[] = [];
            for (let i = 0; i < rawResult.length; i += 2) {
              members.push({ member: rawResult[i], score: parseFloat(rawResult[i + 1]) });
            }
            return { members };
          }
          return { members: rawResult };
        }

        case "zrangebyscore": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const min = body.min ?? "-inf";
          const max = body.max ?? "+inf";
          const cmd: (string | number)[] = [
            options?.reverse ? "ZREVRANGEBYSCORE" : "ZRANGEBYSCORE",
            scopedKey, options?.reverse ? max : min, options?.reverse ? min : max,
          ];
          if (options?.withScores) cmd.push("WITHSCORES");
          if (body.count) cmd.push("LIMIT", body.start ?? 0, body.count);

          const rawResult = await executeRedisCommand(redisUrl, redisToken, cmd) as string[];

          if (options?.withScores) {
            const members: { member: string; score: number }[] = [];
            for (let i = 0; i < rawResult.length; i += 2) {
              members.push({ member: rawResult[i], score: parseFloat(rawResult[i + 1]) });
            }
            return { members };
          }
          return { members: rawResult };
        }

        case "zrank": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.member) throw new ValidationError("Missing member");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const cmd = options?.reverse ? "ZREVRANK" : "ZRANK";
          return { rank: await executeRedisCommand(redisUrl, redisToken, [cmd, scopedKey, body.member]) };
        }

        case "zscore": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.member) throw new ValidationError("Missing member");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const score = await executeRedisCommand(redisUrl, redisToken, ["ZSCORE", scopedKey, body.member]) as string | null;
          return { score: score ? parseFloat(score) : null };
        }

        case "zrem": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.member && !body.members?.length) throw new ValidationError("Missing member(s)");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const membersToRemove = body.members?.map(m => m.member) || [body.member!];
          return { removed: await executeRedisCommand(redisUrl, redisToken, ["ZREM", scopedKey, ...membersToRemove]) };
        }

        case "zincrby": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.member) throw new ValidationError("Missing member");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const newScore = await executeRedisCommand(redisUrl, redisToken, ["ZINCRBY", scopedKey, body.score ?? 1, body.member]) as string;
          return { score: parseFloat(newScore) };
        }

        case "zcard": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { count: await executeRedisCommand(redisUrl, redisToken, ["ZCARD", scopedKey]) };
        }

        case "zcount": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          const min = body.min ?? "-inf";
          const max = body.max ?? "+inf";
          return { count: await executeRedisCommand(redisUrl, redisToken, ["ZCOUNT", scopedKey, min, max]) };
        }

        // Set Operations
        case "sadd": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.values?.length) throw new ValidationError("Missing values");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          const added = await executeRedisCommand(redisUrl, redisToken, ["SADD", scopedKey, ...body.values]);
          if (body.ttl) await executeRedisCommand(redisUrl, redisToken, ["EXPIRE", scopedKey, body.ttl]);
          return { added };
        }

        case "smembers": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { members: await executeRedisCommand(redisUrl, redisToken, ["SMEMBERS", scopedKey]) };
        }

        case "sismember": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.member) throw new ValidationError("Missing member");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { isMember: (await executeRedisCommand(redisUrl, redisToken, ["SISMEMBER", scopedKey, body.member])) === 1 };
        }

        case "srem": {
          if (!body.key) throw new ValidationError("Missing key");
          if (!body.values?.length) throw new ValidationError("Missing values");
          const { scopedKey } = validateAndScopeKey(body.key, userId, true);
          return { removed: await executeRedisCommand(redisUrl, redisToken, ["SREM", scopedKey, ...body.values]) };
        }

        case "scard": {
          if (!body.key) throw new ValidationError("Missing key");
          const { scopedKey } = validateAndScopeKey(body.key, userId, false);
          return { count: await executeRedisCommand(redisUrl, redisToken, ["SCARD", scopedKey]) };
        }

        // Utility Operations
        case "keys": {
          if (!userId) throw new AuthError("Authentication required");
          const pattern = body.pattern || `user:${userId}:*`;
          if (!pattern.startsWith(`user:${userId}:`) && !pattern.startsWith("app:") && !pattern.startsWith("global:")) {
            throw new ValidationError("Can only list your own keys or shared keys");
          }
          const keys = await executeRedisCommand(redisUrl, redisToken, ["KEYS", pattern]) as string[];
          return { keys, count: keys.length };
        }

        case "scan": {
          if (!userId) throw new AuthError("Authentication required");
          const pattern = body.pattern || `user:${userId}:*`;
          if (!pattern.startsWith(`user:${userId}:`) && !pattern.startsWith("app:") && !pattern.startsWith("global:")) {
            throw new ValidationError("Can only scan your own keys or shared keys");
          }
          const scanResult = await executeRedisCommand(redisUrl, redisToken, [
            "SCAN", body.cursor || "0", "MATCH", pattern, "COUNT", body.count || 100
          ]) as [string, string[]];
          return { cursor: scanResult[0], keys: scanResult[1], done: scanResult[0] === "0" };
        }

        case "stats": {
          if (!userId) throw new AuthError("Authentication required");
          const info = await executeRedisCommand(redisUrl, redisToken, ["INFO", "stats"]) as string;
          const memory = await executeRedisCommand(redisUrl, redisToken, ["INFO", "memory"]) as string;

          const statsInfo = parseRedisInfo(info);
          const memoryInfo = parseRedisInfo(memory);

          return {
            stats: {
              hits: parseInt(statsInfo.keyspace_hits || "0"),
              misses: parseInt(statsInfo.keyspace_misses || "0"),
              hitRate: (() => {
                const h = parseInt(statsInfo.keyspace_hits || "0");
                const m = parseInt(statsInfo.keyspace_misses || "0");
                return h + m > 0 ? h / (h + m) : 0;
              })(),
              memory: memoryInfo.used_memory_human || "unknown",
              uptime: parseInt(statsInfo.uptime_in_seconds || "0"),
            },
            instanceMetrics: metrics,
          };
        }

        case "flush_pattern": {
          if (!userId) throw new AuthError("Authentication required");
          const pattern = body.pattern || `user:${userId}:*`;
          if (!pattern.startsWith(`user:${userId}:`)) {
            throw new ValidationError("Can only flush your own keys");
          }
          const keys = await executeRedisCommand(redisUrl, redisToken, ["KEYS", pattern]) as string[];
          if (keys.length > 0) {
            await executeRedisCommand(redisUrl, redisToken, ["DEL", ...keys]);
          }
          return { flushed: keys.length, pattern };
        }

        default:
          throw new ValidationError(`Unknown operation: ${operation}`);
      }
    };

    // Execute with optional coalescing
    if (coalescingKey) {
      result = await coalesceRequest(coalescingKey, executeOperation);
    } else {
      result = await executeOperation();
    }

    recordSuccess();
    metrics.successfulRequests++;
  } catch (error) {
    recordFailure();
    metrics.failedRequests++;
    throw error;
  }

  const executionMs = performance.now() - startTime;

  // Update average latency
  metrics.averageLatencyMs = (metrics.averageLatencyMs * (metrics.totalRequests - 1) + executionMs) / metrics.totalRequests;

  logger.info("Cache operation completed", {
    operation,
    executionMs: Math.round(executionMs),
    userId: userId?.substring(0, 8),
  });

  return ok({
    success: true,
    operation,
    result,
    metadata: {
      version: CONFIG.version,
      compressed,
      executionMs: Math.round(executionMs),
      circuitBreaker: circuitBreaker.state,
    },
  }, ctx);
}
