/**
 * Shared types, configuration, schemas, and in-memory state for api-v1-cache.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Configuration
// =============================================================================

export const CONFIG = {
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

export enum KeyScope {
  User = "user",
  App = "app",
  Global = "global",
}

export interface CircuitBreakerState {
  state: "closed" | "open" | "half-open";
  failures: number;
  lastFailure: number;
  halfOpenRemaining: number;
}

export interface CacheMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatencyMs: number;
  circuitBreakerTrips: number;
  compressionSavings: number;
  coalescedRequests: number;
}

export interface CheckResult {
  status: "pass" | "warn" | "fail";
  value: string | number;
  threshold?: string;
  message: string;
}

export interface ServiceCheckResult {
  service: string;
  status: "ok" | "error";
  message: string;
  details?: unknown;
  responseTime?: number;
}

// =============================================================================
// In-Memory State (per instance)
// =============================================================================

export const circuitBreaker: CircuitBreakerState = {
  state: "closed",
  failures: 0,
  lastFailure: 0,
  halfOpenRemaining: CONFIG.circuitBreaker.halfOpenRequests,
};

export const metrics: CacheMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  averageLatencyMs: 0,
  circuitBreakerTrips: 0,
  compressionSavings: 0,
  coalescedRequests: 0,
};

// Request coalescing map
export const pendingRequests = new Map<string, Promise<unknown>>();

// =============================================================================
// Request Schema
// =============================================================================

export const cacheOperationSchema = z.object({
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

export type CacheOperationRequest = z.infer<typeof cacheOperationSchema>;
