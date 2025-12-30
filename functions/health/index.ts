/**
 * Health Check Edge Function
 *
 * Provides comprehensive health status for the Foodshare backend.
 * Returns status of: database, Redis cache, storage, and Edge Functions.
 *
 * Endpoints:
 * - GET /health - Full health check
 * - GET /health?quick=true - Quick ping check (no database queries)
 *
 * Response includes:
 * - Overall status: healthy, degraded, unhealthy
 * - Individual service statuses
 * - Response times for each service
 * - Current circuit breaker states
 * - Rate limit headroom
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { getAllCircuitStatuses } from "../_shared/circuit-breaker.ts";
import {
  getMetricsSummary as getMetricsSummaryFromDB,
  recordHealthCheck as recordHealthCheckToDB,
} from "../_shared/metrics.ts";

// =============================================================================
// Types
// =============================================================================

interface ServiceHealth {
  service: string;
  status: "healthy" | "degraded" | "unhealthy";
  responseTimeMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

interface CircuitBreakerStatus {
  name: string;
  state: string;
  failureCount: number;
  lastChange: string;
}

interface MetricsSummary {
  requestsLast5Min: number;
  errorRateLast5Min: number;
  p95LatencyMs: number;
}

interface FeatureFlagsStatus {
  totalFlags: number;
  enabledFlags: number;
  activeExperiments: number;
  lastUpdated?: string;
}

interface CacheStats {
  feedCells: {
    totalCells: number;
    activeCells: number;
    totalAccesses: number;
    avgComputationMs: number;
  };
  materializedView: {
    lastRefresh: string;
    isStale: boolean;
    stalenessMinutes: number;
  };
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  uptime: number;
  services: ServiceHealth[];
  circuitBreakers?: CircuitBreakerStatus[];
  metrics?: MetricsSummary;
  featureFlags?: FeatureFlagsStatus;
  cacheStats?: CacheStats;
}

// =============================================================================
// Schemas
// =============================================================================

const healthQuerySchema = z.object({
  quick: z.string().transform((v) => v === "true").optional(),
});

type HealthQuery = z.infer<typeof healthQuerySchema>;

// Start time for uptime calculation
const startTime = Date.now();

// =============================================================================
// Health Check Functions
// =============================================================================

async function checkDatabase(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    const { error } = await supabase
      .from("profiles")
      .select("id")
      .limit(1)
      .maybeSingle();

    const responseTimeMs = Math.round(performance.now() - start);

    if (error) {
      return {
        service: "database",
        status: "unhealthy",
        responseTimeMs,
        error: error.message,
      };
    }

    const status: "healthy" | "degraded" = responseTimeMs > 500 ? "degraded" : "healthy";

    const { data: poolInfo } = await supabase.rpc("pg_stat_activity_count").maybeSingle();

    return {
      service: "database",
      status,
      responseTimeMs,
      details: {
        connectionPoolUsed: poolInfo?.count || "unknown",
      },
    };
  } catch (error) {
    return {
      service: "database",
      status: "unhealthy",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

async function checkStorage(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    const { error } = await supabase.storage.listBuckets();
    const responseTimeMs = Math.round(performance.now() - start);

    if (error) {
      return {
        service: "storage",
        status: "unhealthy",
        responseTimeMs,
        error: error.message,
      };
    }

    const status: "healthy" | "degraded" = responseTimeMs > 1000 ? "degraded" : "healthy";

    return {
      service: "storage",
      status,
      responseTimeMs,
    };
  } catch (error) {
    return {
      service: "storage",
      status: "unhealthy",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

async function checkRedis(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    const { data, error } = await supabase.functions.invoke("cache-operation", {
      body: {
        operation: "exists",
        key: "health_check_ping",
      },
    });

    const responseTimeMs = Math.round(performance.now() - start);

    if (error) {
      if (error.message?.includes("rate")) {
        return {
          service: "redis",
          status: "degraded",
          responseTimeMs,
          details: { reason: "rate_limited" },
        };
      }

      return {
        service: "redis",
        status: "degraded",
        responseTimeMs,
        error: error.message,
      };
    }

    const status: "healthy" | "degraded" = responseTimeMs > 200 ? "degraded" : "healthy";

    return {
      service: "redis",
      status,
      responseTimeMs,
    };
  } catch (error) {
    return {
      service: "redis",
      status: "degraded",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
      details: { optional: true },
    };
  }
}

async function checkFeatureFlags(
  supabase: ReturnType<typeof createClient>
): Promise<FeatureFlagsStatus | null> {
  try {
    const { data: flagsData } = await supabase
      .from("feature_flags")
      .select("enabled, updated_at")
      .order("updated_at", { ascending: false });

    const { count: experimentsCount } = await supabase
      .from("experiments")
      .select("*", { count: "exact", head: true })
      .eq("status", "running");

    const flags = flagsData || [];
    const enabledFlags = flags.filter((f) => f.enabled).length;
    const lastUpdated = flags.length > 0 ? flags[0].updated_at : undefined;

    return {
      totalFlags: flags.length,
      enabledFlags,
      activeExperiments: experimentsCount || 0,
      lastUpdated,
    };
  } catch {
    return null;
  }
}

async function checkCacheStats(
  supabase: ReturnType<typeof createClient>
): Promise<CacheStats | null> {
  try {
    const { data: feedStats } = await supabase.rpc("get_feed_cache_stats");

    const { data: mvStats } = await supabase
      .from("mv_user_stats")
      .select("refreshed_at")
      .limit(1)
      .maybeSingle();

    const refreshedAt = mvStats?.refreshed_at ? new Date(mvStats.refreshed_at) : null;
    const stalenessMinutes = refreshedAt
      ? Math.floor((Date.now() - refreshedAt.getTime()) / 60000)
      : 999;

    return {
      feedCells: {
        totalCells: feedStats?.totalCells || 0,
        activeCells: feedStats?.activeCells || 0,
        totalAccesses: feedStats?.totalAccesses || 0,
        avgComputationMs: feedStats?.avgComputationMs || 0,
      },
      materializedView: {
        lastRefresh: refreshedAt?.toISOString() || "never",
        isStale: stalenessMinutes > 30,
        stalenessMinutes,
      },
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Handlers
// =============================================================================

async function handleQuickHealth(ctx: HandlerContext<unknown, HealthQuery>): Promise<Response> {
  return ok({
    status: "ok",
    timestamp: new Date().toISOString(),
  }, ctx);
}

async function handleFullHealth(ctx: HandlerContext<unknown, HealthQuery>): Promise<Response> {
  const supabase = getSupabaseClient();

  // Run all health checks in parallel
  const [databaseHealth, storageHealth, redisHealth, metrics, featureFlags, cacheStats] =
    await Promise.all([
      checkDatabase(supabase),
      checkStorage(supabase),
      checkRedis(supabase),
      getMetricsSummaryFromDB(5),
      checkFeatureFlags(supabase),
      checkCacheStats(supabase),
    ]);

  // Get circuit breaker statuses
  const circuitStatuses = getAllCircuitStatuses();
  const circuitBreakers: CircuitBreakerStatus[] = Object.entries(circuitStatuses).map(
    ([name, status]) => ({
      name,
      state: status.state,
      failureCount: status.failures,
      lastChange: new Date(status.lastFailureTime || Date.now()).toISOString(),
    })
  );

  const services: ServiceHealth[] = [databaseHealth, storageHealth, redisHealth];

  // Determine overall status
  const hasUnhealthy = services.some((s) => s.status === "unhealthy");
  const hasDegraded = services.some((s) => s.status === "degraded");

  const overallStatus: "healthy" | "degraded" | "unhealthy" = hasUnhealthy
    ? "unhealthy"
    : hasDegraded
      ? "degraded"
      : "healthy";

  // Record health check results
  for (const service of services) {
    await recordHealthCheckToDB(
      service.service,
      service.status,
      service.responseTimeMs,
      service.details,
      service.error
    );
  }

  const response: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: Deno.env.get("SUPABASE_FUNCTION_VERSION") || "2.0.0",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    services,
    circuitBreakers,
    metrics: metrics
      ? {
          requestsLast5Min: metrics.totalRequests,
          errorRateLast5Min: metrics.errorRate,
          p95LatencyMs: metrics.p95Latency,
        }
      : undefined,
    featureFlags: featureFlags || undefined,
    cacheStats: cacheStats || undefined,
  };

  logger.info("Health check completed", { status: overallStatus });

  return ok(response, ctx);
}

async function handleHealth(ctx: HandlerContext<unknown, HealthQuery>): Promise<Response> {
  if (ctx.query.quick) {
    return handleQuickHealth(ctx);
  }
  return handleFullHealth(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "health",
  version: "2.0.0",
  requireAuth: false, // Health checks should be public
  routes: {
    GET: {
      querySchema: healthQuerySchema,
      handler: handleHealth,
    },
  },
});
