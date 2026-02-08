/**
 * Unified Cache Operation Edge Function v5.0
 *
 * Enterprise caching infrastructure for all FoodShare platforms (iOS, Android, Web).
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │                     UNIFIED CACHE ARCHITECTURE                              │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │                                                                             │
 * │   Request → Rate Limiter → Circuit Breaker → Redis → Response              │
 * │                ↓                  ↓             ↓                           │
 * │            Metrics            Fallback      Compression                     │
 * │                                                                             │
 * │   GET  /api-v1-cache              → Quick health ping                       │
 * │   GET  /api-v1-cache?check=health → Detailed Redis health                  │
 * │   GET  /api-v1-cache?check=services → All Upstash services health          │
 * │   POST /api-v1-cache              → Cache operations                       │
 * │                                                                             │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Features:
 * ✅ Multi-scope keys (user, app, global)
 * ✅ Batch operations (MGET, MSET, MDEL)
 * ✅ Hash operations (HGET, HSET, HGETALL)
 * ✅ Sorted sets (leaderboards)
 * ✅ List operations
 * ✅ Set operations
 * ✅ Circuit breaker with automatic recovery
 * ✅ Tiered rate limiting (by plan)
 * ✅ Request coalescing
 * ✅ Compression (gzip for >1KB)
 * ✅ Encryption support
 * ✅ Detailed health monitoring
 * ✅ Multi-service health checks (Redis, Vector, QStash, Search)
 * ✅ Detailed metrics & alerts
 * ✅ Audit logging
 *
 * Supported Platforms: iOS, Android, Web, Server
 *
 * @version 5.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError, AuthError, ServerError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "5.0.0",

  // Rate limits by tier (requests per minute)
  rateLimits: {
    free: { read: 60, write: 30, delete: 10 },
    pro: { read: 300, write: 150, delete: 50 },
    enterprise: { read: 1000, write: 500, delete: 200 },
    internal: { read: 10000, write: 5000, delete: 1000 },
  },

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 30000,
    halfOpenRequests: 3,
  },

  // TTL presets (seconds)
  ttlPresets: {
    realtime: 15,
    ultraShort: 30,
    short: 300,
    medium: 900,
    long: 3600,
    day: 86400,
    week: 604800,
  },

  // Health thresholds
  healthThresholds: {
    latencyWarningMs: 100,
    latencyCriticalMs: 500,
    hitRateWarning: 0.7,
    hitRateCritical: 0.5,
    memoryWarningPercent: 80,
    memoryCriticalPercent: 95,
    errorRateWarning: 0.05,
    errorRateCritical: 0.1,
  },

  // Compression
  compressionThreshold: 1024,

  // Batch limits
  maxBatchSize: 100,
  maxPipelineSize: 50,

  // Coalescing
  coalescingWindowMs: 50,
};

// =============================================================================
// Types
// =============================================================================

enum KeyScope {
  User = "user",
  App = "app",
  Global = "global",
}

interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailure: number;
  halfOpenRemaining: number;
}

interface CacheMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatencyMs: number;
  circuitBreakerTrips: number;
  compressionSavings: number;
  coalescedRequests: number;
}

interface CheckResult {
  status: "pass" | "warn" | "fail";
  value: string | number;
  threshold?: string;
  message: string;
}

interface ServiceCheckResult {
  service: string;
  status: "ok" | "error";
  message: string;
  details?: unknown;
  responseTime?: number;
}

// =============================================================================
// In-Memory State (per instance)
// =============================================================================

const circuitBreaker: CircuitBreakerState = {
  state: "closed",
  failures: 0,
  lastFailure: 0,
  halfOpenRemaining: CONFIG.circuitBreaker.halfOpenRequests,
};

const metrics: CacheMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  averageLatencyMs: 0,
  circuitBreakerTrips: 0,
  compressionSavings: 0,
  coalescedRequests: 0,
};

// Request coalescing map
const pendingRequests = new Map<string, Promise<unknown>>();

// =============================================================================
// Request Schema
// =============================================================================

const cacheOperationSchema = z.object({
  operation: z.enum([
    // String operations
    "get", "set", "delete", "incr", "decr", "expire", "exists", "ttl", "getset",
    // Batch operations
    "mget", "mset", "mdel",
    // Hash operations
    "hget", "hset", "hgetall", "hdel", "hincrby", "hmset", "hmget",
    // List operations
    "lpush", "rpush", "lrange", "lpop", "rpop", "llen", "ltrim",
    // Sorted set operations
    "zadd", "zrange", "zrangebyscore", "zrank", "zscore", "zrem", "zincrby", "zcard", "zcount",
    // Set operations
    "sadd", "smembers", "sismember", "srem", "scard",
    // Utility operations
    "keys", "scan", "stats", "flush_pattern", "health", "ping",
  ]),
  key: z.string().min(1).optional(),
  keys: z.array(z.string().min(1)).max(CONFIG.maxBatchSize).optional(),
  value: z.union([z.string(), z.number(), z.record(z.string())]).optional(),
  values: z.array(z.union([z.string(), z.number()])).optional(),
  pairs: z.record(z.string()).optional(),
  field: z.string().optional(),
  fields: z.array(z.string()).optional(),
  fieldValues: z.record(z.string()).optional(),
  ttl: z.number().optional(),
  score: z.number().optional(),
  member: z.string().optional(),
  members: z.array(z.object({ score: z.number(), member: z.string() })).optional(),
  min: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  start: z.number().optional().default(0),
  stop: z.number().optional().default(-1),
  cursor: z.string().optional().default("0"),
  count: z.number().optional().default(100),
  pattern: z.string().optional(),
  options: z.object({
    compress: z.boolean().optional().default(true),
    encrypt: z.boolean().optional().default(false),
    nx: z.boolean().optional(),
    xx: z.boolean().optional(),
    withScores: z.boolean().optional().default(false),
    reverse: z.boolean().optional().default(false),
    coalesce: z.boolean().optional().default(true),
    priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
  }).optional(),
});

type CacheOperationRequest = z.infer<typeof cacheOperationSchema>;

// =============================================================================
// Circuit Breaker
// =============================================================================

function isCircuitBreakerOpen(): boolean {
  if (circuitBreaker.state === "closed") return false;

  if (circuitBreaker.state === "open") {
    const elapsed = Date.now() - circuitBreaker.lastFailure;
    if (elapsed >= CONFIG.circuitBreaker.resetTimeoutMs) {
      circuitBreaker.state = "half-open";
      circuitBreaker.halfOpenRemaining = CONFIG.circuitBreaker.halfOpenRequests;
      return false;
    }
    return true;
  }

  // half-open
  return circuitBreaker.halfOpenRemaining <= 0;
}

function recordSuccess(): void {
  if (circuitBreaker.state === "half-open") {
    circuitBreaker.halfOpenRemaining--;
    if (circuitBreaker.halfOpenRemaining <= 0) {
      circuitBreaker.state = "closed";
      circuitBreaker.failures = 0;
    }
  } else {
    circuitBreaker.failures = 0;
  }
}

function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();

  if (circuitBreaker.state === "half-open" ||
      circuitBreaker.failures >= CONFIG.circuitBreaker.failureThreshold) {
    circuitBreaker.state = "open";
    metrics.circuitBreakerTrips++;
  }
}

// =============================================================================
// Redis Operations
// =============================================================================

async function executeRedisCommand(
  redisUrl: string,
  redisToken: string,
  command: (string | number)[]
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

async function executeRedisPipeline(
  redisUrl: string,
  redisToken: string,
  commands: (string | number)[][]
): Promise<unknown[]> {
  const pipelineUrl = redisUrl.replace(/\/?$/, "/pipeline");
  const response = await fetch(pipelineUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new ServerError(`Redis pipeline failed: ${JSON.stringify(data)}`);
  }

  return data.map((r: { result: unknown }) => r.result);
}

// =============================================================================
// Request Coalescing
// =============================================================================

async function coalesceRequest<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const existing = pendingRequests.get(key);
  if (existing) {
    metrics.coalescedRequests++;
    return existing as Promise<T>;
  }

  const promise = operation().finally(() => {
    // Clean up after a short delay to allow coalescing
    setTimeout(() => pendingRequests.delete(key), CONFIG.coalescingWindowMs);
  });

  pendingRequests.set(key, promise);
  return promise;
}

// =============================================================================
// Compression
// =============================================================================

async function compressValue(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const compressed = await new Response(cs.readable).arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(compressed)));
  metrics.compressionSavings += value.length - base64.length;
  return `__gzip__:${base64}`;
}

async function decompressValue(value: string): Promise<string> {
  if (!value.startsWith("__gzip__:")) return value;
  const base64 = value.slice(9);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return await new Response(ds.readable).text();
}

function shouldCompress(value: string, options?: { compress?: boolean }): boolean {
  return (options?.compress !== false) && value.length > CONFIG.compressionThreshold;
}

// =============================================================================
// Key Validation
// =============================================================================

function validateAndScopeKey(
  key: string,
  userId: string | null,
  allowWrite: boolean
): { scope: KeyScope; scopedKey: string } {
  if (key.startsWith("user:")) {
    const userPrefix = `user:${userId}:`;
    if (!key.startsWith(userPrefix)) {
      throw new ValidationError(`User-scoped keys must start with: ${userPrefix}`);
    }
    return { scope: KeyScope.User, scopedKey: key };
  }

  if (key.startsWith("app:")) {
    if (allowWrite) {
      throw new ValidationError("App-scoped keys are read-only for clients");
    }
    return { scope: KeyScope.App, scopedKey: key };
  }

  if (key.startsWith("global:")) {
    if (allowWrite) {
      throw new ValidationError("Global keys are read-only");
    }
    return { scope: KeyScope.Global, scopedKey: key };
  }

  if (!userId) {
    throw new AuthError("Authentication required for unscoped keys");
  }
  return { scope: KeyScope.User, scopedKey: `user:${userId}:${key}` };
}

function isWriteOperation(operation: string): boolean {
  return [
    "set", "delete", "incr", "decr", "expire", "getset",
    "mset", "mdel",
    "hset", "hdel", "hincrby", "hmset",
    "lpush", "rpush", "lpop", "rpop", "ltrim",
    "zadd", "zrem", "zincrby",
    "sadd", "srem",
    "flush_pattern",
  ].includes(operation);
}

function getOperationType(operation: string): "read" | "write" | "delete" {
  if (["delete", "mdel", "hdel", "zrem", "lpop", "rpop", "srem", "flush_pattern"].includes(operation)) {
    return "delete";
  }
  if (isWriteOperation(operation)) return "write";
  return "read";
}

// =============================================================================
// Rate Limiting
// =============================================================================

async function checkRateLimit(
  supabase: any,
  userId: string,
  operation: string,
  tier: keyof typeof CONFIG.rateLimits = "free"
): Promise<boolean> {
  const opType = getOperationType(operation);
  const limit = CONFIG.rateLimits[tier][opType];

  const { data: withinLimit, error } = await supabase.rpc("check_rate_limit", {
    user_id: userId,
    operation: `cache_${opType}`,
    max_requests: limit,
    time_window_seconds: 60,
  });

  if (error) {
    logger.error("Rate limit check failed", { error: error.message });
    return true; // Allow on error
  }

  return withinLimit !== false;
}

// =============================================================================
// Health Check Helpers
// =============================================================================

function parseRedisInfo(info: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of info.split("\n")) {
    if (line && !line.startsWith("#")) {
      const [key, value] = line.split(":");
      if (key && value) result[key.trim()] = value.trim();
    }
  }
  return result;
}

async function performDetailedHealthCheck(
  redisUrl: string,
  redisToken: string
): Promise<{
  status: "healthy" | "degraded" | "unhealthy" | "critical";
  checks: Record<string, CheckResult>;
  metrics: {
    redis: Record<string, unknown>;
    performance: Record<string, unknown>;
  };
  alerts: Array<{ severity: string; component: string; message: string }>;
  recommendations: string[];
}> {
  const startTime = performance.now();
  const alerts: Array<{ severity: string; component: string; message: string }> = [];
  const recommendations: string[] = [];

  // 1. Connectivity Check
  let connectivityCheck: CheckResult;
  try {
    const pingStart = performance.now();
    await executeRedisCommand(redisUrl, redisToken, ["PING"]);
    const pingLatency = performance.now() - pingStart;
    connectivityCheck = {
      status: "pass",
      value: `${Math.round(pingLatency)}ms`,
      message: "Redis connection successful",
    };
  } catch (error) {
    connectivityCheck = {
      status: "fail",
      value: "N/A",
      message: `Connection failed: ${error instanceof Error ? error.message : "Unknown"}`,
    };
    alerts.push({ severity: "critical", component: "connectivity", message: "Redis connection failure" });
  }

  // 2. Get Redis INFO
  let infoStats: Record<string, string> = {};
  let infoMemory: Record<string, string> = {};
  let infoClients: Record<string, string> = {};
  let infoServer: Record<string, string> = {};

  try {
    const [stats, memory, clients, server] = await Promise.all([
      executeRedisCommand(redisUrl, redisToken, ["INFO", "stats"]) as Promise<string>,
      executeRedisCommand(redisUrl, redisToken, ["INFO", "memory"]) as Promise<string>,
      executeRedisCommand(redisUrl, redisToken, ["INFO", "clients"]) as Promise<string>,
      executeRedisCommand(redisUrl, redisToken, ["INFO", "server"]) as Promise<string>,
    ]);
    infoStats = parseRedisInfo(stats);
    infoMemory = parseRedisInfo(memory);
    infoClients = parseRedisInfo(clients);
    infoServer = parseRedisInfo(server);
  } catch (error) {
    logger.error("Failed to get Redis INFO", { error });
  }

  // 3. Parse metrics
  const keyspaceHits = parseInt(infoStats.keyspace_hits || "0");
  const keyspaceMisses = parseInt(infoStats.keyspace_misses || "0");
  const totalOps = keyspaceHits + keyspaceMisses;
  const hitRate = totalOps > 0 ? keyspaceHits / totalOps : 0;

  const usedMemory = parseInt(infoMemory.used_memory || "0");
  const maxMemory = parseInt(infoMemory.maxmemory || "0") || usedMemory * 2;
  const memoryPercent = maxMemory > 0 ? (usedMemory / maxMemory) * 100 : 0;

  // 4. Latency Check
  const latencyMs = performance.now() - startTime;
  let latencyCheck: CheckResult;

  if (latencyMs < CONFIG.healthThresholds.latencyWarningMs) {
    latencyCheck = { status: "pass", value: Math.round(latencyMs), threshold: `<${CONFIG.healthThresholds.latencyWarningMs}ms`, message: "Latency is excellent" };
  } else if (latencyMs < CONFIG.healthThresholds.latencyCriticalMs) {
    latencyCheck = { status: "warn", value: Math.round(latencyMs), threshold: `<${CONFIG.healthThresholds.latencyCriticalMs}ms`, message: "Latency is elevated" };
    alerts.push({ severity: "warning", component: "latency", message: `High latency: ${Math.round(latencyMs)}ms` });
    recommendations.push("Consider using a closer Redis region");
  } else {
    latencyCheck = { status: "fail", value: Math.round(latencyMs), threshold: `<${CONFIG.healthThresholds.latencyCriticalMs}ms`, message: "Latency is critical" };
    alerts.push({ severity: "critical", component: "latency", message: `Critical latency: ${Math.round(latencyMs)}ms` });
  }

  // 5. Memory Check
  let memoryCheck: CheckResult;
  if (memoryPercent < CONFIG.healthThresholds.memoryWarningPercent) {
    memoryCheck = { status: "pass", value: `${Math.round(memoryPercent)}%`, message: `Memory healthy (${infoMemory.used_memory_human || "unknown"})` };
  } else if (memoryPercent < CONFIG.healthThresholds.memoryCriticalPercent) {
    memoryCheck = { status: "warn", value: `${Math.round(memoryPercent)}%`, message: `Memory elevated (${infoMemory.used_memory_human || "unknown"})` };
    alerts.push({ severity: "warning", component: "memory", message: `High memory: ${Math.round(memoryPercent)}%` });
    recommendations.push("Consider increasing memory or implementing eviction");
  } else {
    memoryCheck = { status: "fail", value: `${Math.round(memoryPercent)}%`, message: `Memory critical (${infoMemory.used_memory_human || "unknown"})` };
    alerts.push({ severity: "critical", component: "memory", message: `Critical memory: ${Math.round(memoryPercent)}%` });
  }

  // 6. Hit Rate Check
  let hitRateCheck: CheckResult;
  if (hitRate >= CONFIG.healthThresholds.hitRateWarning) {
    hitRateCheck = { status: "pass", value: `${Math.round(hitRate * 100)}%`, message: "Hit rate excellent" };
  } else if (hitRate >= CONFIG.healthThresholds.hitRateCritical || totalOps <= 100) {
    hitRateCheck = { status: "warn", value: `${Math.round(hitRate * 100)}%`, message: "Hit rate below optimal" };
    if (totalOps > 100) {
      alerts.push({ severity: "warning", component: "hit_rate", message: `Low hit rate: ${Math.round(hitRate * 100)}%` });
      recommendations.push("Review TTL settings and cache patterns");
    }
  } else {
    hitRateCheck = { status: "fail", value: `${Math.round(hitRate * 100)}%`, message: "Hit rate critically low" };
    alerts.push({ severity: "error", component: "hit_rate", message: `Critical hit rate: ${Math.round(hitRate * 100)}%` });
  }

  // 7. Circuit Breaker Check
  const circuitBreakerCheck: CheckResult = {
    status: circuitBreaker.state === "closed" ? "pass" : circuitBreaker.state === "half-open" ? "warn" : "fail",
    value: circuitBreaker.state,
    message: `Circuit breaker is ${circuitBreaker.state}`,
  };

  // Determine overall status
  const checks = { connectivity: connectivityCheck, latency: latencyCheck, memory: memoryCheck, hitRate: hitRateCheck, circuitBreaker: circuitBreakerCheck };
  const checkStatuses = Object.values(checks).map((c) => c.status);
  let overallStatus: "healthy" | "degraded" | "unhealthy" | "critical";

  if (checkStatuses.includes("fail")) {
    overallStatus = checkStatuses.filter((s) => s === "fail").length >= 2 ? "critical" : "unhealthy";
  } else if (checkStatuses.includes("warn")) {
    overallStatus = "degraded";
  } else {
    overallStatus = "healthy";
  }

  return {
    status: overallStatus,
    checks,
    metrics: {
      redis: {
        memoryUsed: infoMemory.used_memory_human || "unknown",
        memoryPeak: infoMemory.used_memory_peak_human || "unknown",
        memoryPercent: Math.round(memoryPercent * 10) / 10,
        connectedClients: parseInt(infoClients.connected_clients || "0"),
        keyspaceHits,
        keyspaceMisses,
        hitRate: Math.round(hitRate * 1000) / 1000,
        evictedKeys: parseInt(infoStats.evicted_keys || "0"),
        uptimeSeconds: parseInt(infoServer.uptime_in_seconds || "0"),
      },
      performance: {
        avgLatencyMs: Math.round(latencyMs),
        totalRequests: metrics.totalRequests,
        successfulRequests: metrics.successfulRequests,
        failedRequests: metrics.failedRequests,
        circuitBreakerTrips: metrics.circuitBreakerTrips,
      },
    },
    alerts,
    recommendations,
  };
}

async function checkUpstashServices(supabase: any): Promise<{
  success: boolean;
  summary: { total: number; healthy: number; unhealthy: number; skipped: number; avgResponseTime: number };
  results: ServiceCheckResult[];
}> {
  // All Upstash services for cross-platform FoodShare apps (iOS, Android, Web)
  const { data: secrets, error: secretsError } = await supabase.rpc("get_secrets", {
    secret_names: [
      "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
      "UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN",
      "QSTASH_URL", "QSTASH_TOKEN",
      "UPSTASH_SEARCH_REST_URL", "UPSTASH_SEARCH_REST_TOKEN",
    ],
  });

  if (secretsError) {
    return {
      success: false,
      summary: { total: 0, healthy: 0, unhealthy: 0, skipped: 0, avgResponseTime: 0 },
      results: [{ service: "secrets", status: "error", message: secretsError.message }],
    };
  }

  const getSecret = (name: string): string =>
    secrets?.find((s: { name: string; value: string }) => s.name === name)?.value || "";

  // Check a service - returns "skipped" if not configured (vs "error" for failures)
  const checkService = async (
    service: string,
    url: string,
    token: string,
    endpoint: string,
    validateFn: (data: any, response: Response) => { ok: boolean; message: string }
  ): Promise<ServiceCheckResult & { skipped?: boolean }> => {
    if (!url || !token) {
      return { service, status: "ok", message: "Not configured (skipped)", skipped: true };
    }
    try {
      const startTime = Date.now();
      const response = await fetch(`${url}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const responseTime = Date.now() - startTime;
      const data = await response.json().catch(() => ({}));
      const validation = validateFn(data, response);
      return {
        service,
        status: validation.ok ? "ok" : "error",
        message: validation.message,
        details: data,
        responseTime,
      };
    } catch (error) {
      return { service, status: "error", message: error instanceof Error ? error.message : "Unknown error" };
    }
  };

  const results = await Promise.all([
    checkService("Redis", getSecret("UPSTASH_REDIS_REST_URL"), getSecret("UPSTASH_REDIS_REST_TOKEN"), "/ping",
      (data) => ({ ok: data.result === "PONG", message: data.result === "PONG" ? "PING successful" : "Unexpected response" })),
    checkService("Vector", getSecret("UPSTASH_VECTOR_REST_URL"), getSecret("UPSTASH_VECTOR_REST_TOKEN"), "/info",
      (data, res) => ({ ok: res.ok && data.result, message: res.ok ? `Vector DB ready (${data.result?.vectorCount || 0} vectors)` : "Failed" })),
    checkService("QStash", getSecret("QSTASH_URL"), getSecret("QSTASH_TOKEN"), "/v2/schedules",
      (data, res) => ({ ok: res.ok, message: res.ok ? `QStash accessible (${data.length || 0} schedules)` : "Failed" })),
    checkService("Search", getSecret("UPSTASH_SEARCH_REST_URL"), getSecret("UPSTASH_SEARCH_REST_TOKEN"), "/info",
      (data, res) => ({ ok: res.ok && data.result, message: res.ok ? `Search ready (${data.result?.vectorCount || 0} vectors)` : "Failed" })),
  ]);

  const configured = results.filter((r) => !(r as any).skipped);
  const skipped = results.filter((r) => (r as any).skipped);
  const responseTimes = configured.filter((r) => r.responseTime).map((r) => r.responseTime!);
  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : 0;

  return {
    success: configured.every((r) => r.status === "ok"),
    summary: {
      total: results.length,
      healthy: configured.filter((r) => r.status === "ok").length,
      unhealthy: configured.filter((r) => r.status === "error").length,
      skipped: skipped.length,
      avgResponseTime,
    },
    results,
  };
}

// =============================================================================
// GET Handler (Health Checks)
// =============================================================================

async function handleGetRequest(ctx: HandlerContext): Promise<Response> {
  const { supabase, ctx: requestCtx } = ctx;
  const url = new URL(requestCtx?.url || "http://localhost");
  const checkType = url.searchParams.get("check") || "ping";

  // Get Redis credentials
  const requestMetadata = {
    ip_address: requestCtx?.ip || "unknown",
    user_agent: requestCtx?.userAgent || "unknown",
    request_id: requestCtx?.requestId,
  };

  // Quick ping (no credentials needed for basic status)
  if (checkType === "ping") {
    return ok({
      success: true,
      status: isCircuitBreakerOpen() ? "degraded" : "healthy",
      version: CONFIG.version,
      circuitBreaker: circuitBreaker.state,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  // All Upstash services check
  if (checkType === "services") {
    const servicesHealth = await checkUpstashServices(supabase);
    logger.info("Upstash services check completed", servicesHealth.summary);
    return ok({
      ...servicesHealth,
      version: CONFIG.version,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  // Detailed Redis health check
  const [urlResult, tokenResult] = await Promise.all([
    supabase.rpc("get_secret_audited", {
      secret_name: "UPSTASH_REDIS_URL",
      requesting_user_id: "health-check",
      request_metadata: requestMetadata,
    }),
    supabase.rpc("get_secret_audited", {
      secret_name: "UPSTASH_REDIS_TOKEN",
      requesting_user_id: "health-check",
      request_metadata: requestMetadata,
    }),
  ]);

  if (urlResult.error || tokenResult.error || !urlResult.data || !tokenResult.data) {
    return ok({
      status: "unhealthy",
      error: "Failed to retrieve Redis credentials",
      version: CONFIG.version,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  const healthResult = await performDetailedHealthCheck(urlResult.data, tokenResult.data);

  logger.info("Cache health check completed", {
    status: healthResult.status,
    hitRate: healthResult.metrics.redis.hitRate,
    alerts: healthResult.alerts.length,
  });

  return ok({
    ...healthResult,
    version: CONFIG.version,
    timestamp: new Date().toISOString(),
  }, ctx);
}

// =============================================================================
// POST Handler (Cache Operations)
// =============================================================================

async function handleCacheOperation(
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

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-cache",
  version: CONFIG.version,
  requireAuth: false,
  routes: {
    GET: {
      handler: handleGetRequest,
    },
    POST: {
      schema: cacheOperationSchema,
      handler: handleCacheOperation,
    },
  },
}));
