/**
 * Health check and monitoring handlers for api-v1-cache.
 */

import { type HandlerContext, ok } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import {
  type CheckResult,
  circuitBreaker,
  CONFIG,
  metrics,
  type ServiceCheckResult,
} from "./types.ts";
import { executeRedisCommand, isCircuitBreakerOpen, parseRedisInfo } from "./redis.ts";

// =============================================================================
// Detailed Health Check
// =============================================================================

async function performDetailedHealthCheck(
  redisUrl: string,
  redisToken: string,
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
    alerts.push({
      severity: "critical",
      component: "connectivity",
      message: "Redis connection failure",
    });
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
    latencyCheck = {
      status: "pass",
      value: Math.round(latencyMs),
      threshold: `<${CONFIG.healthThresholds.latencyWarningMs}ms`,
      message: "Latency is excellent",
    };
  } else if (latencyMs < CONFIG.healthThresholds.latencyCriticalMs) {
    latencyCheck = {
      status: "warn",
      value: Math.round(latencyMs),
      threshold: `<${CONFIG.healthThresholds.latencyCriticalMs}ms`,
      message: "Latency is elevated",
    };
    alerts.push({
      severity: "warning",
      component: "latency",
      message: `High latency: ${Math.round(latencyMs)}ms`,
    });
    recommendations.push("Consider using a closer Redis region");
  } else {
    latencyCheck = {
      status: "fail",
      value: Math.round(latencyMs),
      threshold: `<${CONFIG.healthThresholds.latencyCriticalMs}ms`,
      message: "Latency is critical",
    };
    alerts.push({
      severity: "critical",
      component: "latency",
      message: `Critical latency: ${Math.round(latencyMs)}ms`,
    });
  }

  // 5. Memory Check
  let memoryCheck: CheckResult;
  if (memoryPercent < CONFIG.healthThresholds.memoryWarningPercent) {
    memoryCheck = {
      status: "pass",
      value: `${Math.round(memoryPercent)}%`,
      message: `Memory healthy (${infoMemory.used_memory_human || "unknown"})`,
    };
  } else if (memoryPercent < CONFIG.healthThresholds.memoryCriticalPercent) {
    memoryCheck = {
      status: "warn",
      value: `${Math.round(memoryPercent)}%`,
      message: `Memory elevated (${infoMemory.used_memory_human || "unknown"})`,
    };
    alerts.push({
      severity: "warning",
      component: "memory",
      message: `High memory: ${Math.round(memoryPercent)}%`,
    });
    recommendations.push("Consider increasing memory or implementing eviction");
  } else {
    memoryCheck = {
      status: "fail",
      value: `${Math.round(memoryPercent)}%`,
      message: `Memory critical (${infoMemory.used_memory_human || "unknown"})`,
    };
    alerts.push({
      severity: "critical",
      component: "memory",
      message: `Critical memory: ${Math.round(memoryPercent)}%`,
    });
  }

  // 6. Hit Rate Check
  let hitRateCheck: CheckResult;
  if (hitRate >= CONFIG.healthThresholds.hitRateWarning) {
    hitRateCheck = {
      status: "pass",
      value: `${Math.round(hitRate * 100)}%`,
      message: "Hit rate excellent",
    };
  } else if (hitRate >= CONFIG.healthThresholds.hitRateCritical || totalOps <= 100) {
    hitRateCheck = {
      status: "warn",
      value: `${Math.round(hitRate * 100)}%`,
      message: "Hit rate below optimal",
    };
    if (totalOps > 100) {
      alerts.push({
        severity: "warning",
        component: "hit_rate",
        message: `Low hit rate: ${Math.round(hitRate * 100)}%`,
      });
      recommendations.push("Review TTL settings and cache patterns");
    }
  } else {
    hitRateCheck = {
      status: "fail",
      value: `${Math.round(hitRate * 100)}%`,
      message: "Hit rate critically low",
    };
    alerts.push({
      severity: "error",
      component: "hit_rate",
      message: `Critical hit rate: ${Math.round(hitRate * 100)}%`,
    });
  }

  // 7. Circuit Breaker Check
  const circuitBreakerCheck: CheckResult = {
    status: circuitBreaker.state === "closed"
      ? "pass"
      : circuitBreaker.state === "half-open"
      ? "warn"
      : "fail",
    value: circuitBreaker.state,
    message: `Circuit breaker is ${circuitBreaker.state}`,
  };

  // Determine overall status
  const checks = {
    connectivity: connectivityCheck,
    latency: latencyCheck,
    memory: memoryCheck,
    hitRate: hitRateCheck,
    circuitBreaker: circuitBreakerCheck,
  };
  const checkStatuses = Object.values(checks).map((c) => c.status);
  let overallStatus: "healthy" | "degraded" | "unhealthy" | "critical";

  if (checkStatuses.includes("fail")) {
    overallStatus = checkStatuses.filter((s) => s === "fail").length >= 2
      ? "critical"
      : "unhealthy";
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

// =============================================================================
// Upstash Services Check
// =============================================================================

async function checkUpstashServices(supabase: any): Promise<{
  success: boolean;
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    skipped: number;
    avgResponseTime: number;
  };
  results: ServiceCheckResult[];
}> {
  // All Upstash services for cross-platform FoodShare apps (iOS, Android, Web)
  const { data: secrets, error: secretsError } = await supabase.rpc("get_secrets", {
    secret_names: [
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "UPSTASH_VECTOR_REST_URL",
      "UPSTASH_VECTOR_REST_TOKEN",
      "QSTASH_URL",
      "QSTASH_TOKEN",
      "UPSTASH_SEARCH_REST_URL",
      "UPSTASH_SEARCH_REST_TOKEN",
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
    validateFn: (data: any, response: Response) => { ok: boolean; message: string },
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
      return {
        service,
        status: "error",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  };

  const results = await Promise.all([
    checkService(
      "Redis",
      getSecret("UPSTASH_REDIS_REST_URL"),
      getSecret("UPSTASH_REDIS_REST_TOKEN"),
      "/ping",
      (data) => ({
        ok: data.result === "PONG",
        message: data.result === "PONG" ? "PING successful" : "Unexpected response",
      }),
    ),
    checkService(
      "Vector",
      getSecret("UPSTASH_VECTOR_REST_URL"),
      getSecret("UPSTASH_VECTOR_REST_TOKEN"),
      "/info",
      (data, res) => ({
        ok: res.ok && data.result,
        message: res.ok ? `Vector DB ready (${data.result?.vectorCount || 0} vectors)` : "Failed",
      }),
    ),
    checkService(
      "QStash",
      getSecret("QSTASH_URL"),
      getSecret("QSTASH_TOKEN"),
      "/v2/schedules",
      (data, res) => ({
        ok: res.ok,
        message: res.ok ? `QStash accessible (${data.length || 0} schedules)` : "Failed",
      }),
    ),
    checkService(
      "Search",
      getSecret("UPSTASH_SEARCH_REST_URL"),
      getSecret("UPSTASH_SEARCH_REST_TOKEN"),
      "/info",
      (data, res) => ({
        ok: res.ok && data.result,
        message: res.ok ? `Search ready (${data.result?.vectorCount || 0} vectors)` : "Failed",
      }),
    ),
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

export async function handleGetRequest(ctx: HandlerContext): Promise<Response> {
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
