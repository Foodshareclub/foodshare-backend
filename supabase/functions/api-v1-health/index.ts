/**
 * Unified Health API v1
 *
 * Consolidates health + health-advanced into a single endpoint.
 *
 * Routes:
 * - GET  /              Quick health (DB ping)
 * - GET  /?full=true    Full health: DB + storage + circuit breakers + metrics + observability
 * - GET  /full          Alias for /?full=true
 * - GET  /metrics       System metrics: memory, errors, performance, circuit breakers
 * - POST /functions     Check all edge functions (fleet check)
 * - POST /functions?quick=true  Quick fleet check (skip slow functions)
 * - POST /functions/:name       Check single edge function
 *
 * @module api-v1-health
 * @version 1.0.0
 */

import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { parseRoute } from "../_shared/routing.ts";
import {
  getHealthService,
  HEALTH_VERSION,
  FunctionHealthResult,
} from "../_shared/health/index.ts";
import { getHealthMetrics } from "../_shared/performance.ts";
import { getErrorStats, getRecentAlerts } from "../_shared/error-tracking.ts";
import { getAllCircuitStatuses } from "../_shared/circuit-breaker.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

const SERVICE = "api-v1-health";

// =============================================================================
// Metrics Handler (from health-advanced)
// =============================================================================

async function handleMetrics(corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();

  const healthMetrics = getHealthMetrics();
  const errorStats = getErrorStats();
  const recentAlerts = getRecentAlerts(5);
  const circuitBreakers = getAllCircuitStatuses();

  // Check database connectivity
  let databaseHealthy = false;
  let databaseLatencyMs = 0;
  try {
    const dbStart = Date.now();
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("profiles_foodshare").select("id").limit(1);
    databaseLatencyMs = Date.now() - dbStart;
    databaseHealthy = !error;
  } catch {
    databaseHealthy = false;
  }

  const criticalErrors = errorStats.bySeverity.critical;
  const openCircuits = Object.values(circuitBreakers).filter((c) => c.state === "open").length;

  let status: "healthy" | "degraded" | "unhealthy";
  if (!databaseHealthy || criticalErrors > 10 || openCircuits > 3) {
    status = "unhealthy";
  } else if (criticalErrors > 0 || openCircuits > 0 || healthMetrics.memory.heapUsed > 512) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  const responseTime = Date.now() - startTime;
  const httpStatus = status === "unhealthy" ? 503 : 200;

  return new Response(JSON.stringify({
    status,
    timestamp: new Date().toISOString(),
    responseTimeMs: responseTime,
    system: {
      uptime: healthMetrics.uptime,
      memory: healthMetrics.memory,
    },
    database: {
      healthy: databaseHealthy,
      latencyMs: databaseLatencyMs,
    },
    performance: {
      recentMetrics: healthMetrics.recentMetrics,
      slowQueries: healthMetrics.slowQueries,
    },
    errors: {
      total: errorStats.total,
      bySeverity: errorStats.bySeverity,
      topErrors: errorStats.topErrors.slice(0, 5),
      recentAlerts: recentAlerts.length,
    },
    circuitBreakers: Object.entries(circuitBreakers).map(([name, cb]) => ({
      name,
      state: cb.state,
      failures: cb.failures,
      totalRequests: cb.totalRequests,
      totalFailures: cb.totalFailures,
    })),
  }), {
    status: httpStatus,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const route = parseRoute(url, ctx.request.method, SERVICE);
  const service = getHealthService();

  // GET /metrics — observability data (from health-advanced)
  if (route.resource === "metrics") {
    return await handleMetrics(ctx.corsHeaders);
  }

  // GET /full or GET /?full=true — full health + observability merged
  const isFull = route.resource === "full" || url.searchParams.get("full") === "true";

  if (isFull) {
    const [fullHealth, metricsResponse] = await Promise.all([
      service.checkFullHealth(),
      (async () => {
        const healthMetrics = getHealthMetrics();
        const errorStats = getErrorStats();
        const circuitBreakers = getAllCircuitStatuses();
        return { healthMetrics, errorStats, circuitBreakers };
      })(),
    ]);

    const httpStatus = fullHealth.status === "unhealthy" ? 503 : 200;

    return new Response(JSON.stringify({
      ...fullHealth,
      system: {
        uptime: metricsResponse.healthMetrics.uptime,
        memory: metricsResponse.healthMetrics.memory,
      },
      performance: {
        recentMetrics: metricsResponse.healthMetrics.recentMetrics,
        slowQueries: metricsResponse.healthMetrics.slowQueries,
      },
      errors: {
        total: metricsResponse.errorStats.total,
        bySeverity: metricsResponse.errorStats.bySeverity,
        topErrors: metricsResponse.errorStats.topErrors.slice(0, 5),
      },
      circuitBreakersDetailed: Object.entries(metricsResponse.circuitBreakers).map(([name, cb]) => ({
        name,
        state: cb.state,
        failures: cb.failures,
        totalRequests: cb.totalRequests,
        totalFailures: cb.totalFailures,
      })),
    }), {
      status: httpStatus,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  // GET / — quick health (DB ping)
  const result = await service.checkQuickHealth();
  const httpStatus = result.status === "ok" ? 200 : 503;
  return new Response(JSON.stringify(result), {
    status: httpStatus,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const route = parseRoute(url, ctx.request.method, SERVICE);
  const service = getHealthService();

  // POST /functions/:name — check single function
  if (route.resource === "functions" && route.subPath) {
    const functionName = route.subPath;
    const result = await service.checkSingleFunction(functionName);

    if ("error" in result && !("status" in result)) {
      return new Response(JSON.stringify(result), {
        status: 404,
        headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
      });
    }

    const healthResult = result as FunctionHealthResult;
    const httpStatus = healthResult.status === "healthy" ? 200 : healthResult.status === "degraded" ? 200 : 503;
    return new Response(JSON.stringify(result), {
      status: httpStatus,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  // POST /functions — check all functions
  if (route.resource === "functions" || route.segments.length === 0) {
    const quick = url.searchParams.get("quick") === "true";
    const result = await service.checkAllFunctions(quick);
    const httpStatus = result.status === "healthy" ? 200 : result.status === "degraded" ? 200 : 503;
    return new Response(JSON.stringify(result), {
      status: httpStatus,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 404
  return new Response(JSON.stringify({
    error: "Not found",
    version: HEALTH_VERSION,
    availableEndpoints: [
      "GET  /                   Quick health (DB ping)",
      "GET  /?full=true         Full health + observability",
      "GET  /full               Alias for /?full=true",
      "GET  /metrics            System metrics & observability",
      "POST /functions          Check all edge functions",
      "POST /functions?quick=true  Quick fleet check",
      "POST /functions/:name    Check single edge function",
    ],
  }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: "1",
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 200,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
