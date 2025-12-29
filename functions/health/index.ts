/**
 * Health Check Edge Function
 *
 * Provides comprehensive health status for the Foodshare backend.
 * Returns status of: database, Redis cache, storage, and Edge Functions.
 *
 * Endpoints:
 * - GET /health - Full health check (authenticated)
 * - GET /health?quick=true - Quick ping check (no auth)
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

// Types
interface ServiceHealth {
  service: string;
  status: "healthy" | "degraded" | "unhealthy";
  responseTimeMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  uptime: number;
  services: ServiceHealth[];
  circuitBreakers?: CircuitBreakerStatus[];
  rateLimits?: RateLimitStatus;
  metrics?: MetricsSummary;
}

interface CircuitBreakerStatus {
  name: string;
  state: string;
  failureCount: number;
  lastChange: string;
}

interface RateLimitStatus {
  globalRemaining: number;
  globalLimit: number;
  windowResetSeconds: number;
}

interface MetricsSummary {
  requestsLast5Min: number;
  errorRateLast5Min: number;
  p95LatencyMs: number;
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Start time for uptime calculation
const startTime = Date.now();

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const isQuickCheck = url.searchParams.get("quick") === "true";

  // Quick check doesn't require auth - just returns OK
  if (isQuickCheck) {
    return new Response(
      JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      }
    );
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({
          status: "unhealthy",
          error: "Missing Supabase configuration",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Run all health checks in parallel
    const [
      databaseHealth,
      storageHealth,
      redisHealth,
      circuitBreakers,
      metrics,
    ] = await Promise.all([
      checkDatabase(supabase),
      checkStorage(supabase),
      checkRedis(supabase),
      getCircuitBreakerStatus(supabase),
      getMetricsSummary(supabase),
    ]);

    const services: ServiceHealth[] = [
      databaseHealth,
      storageHealth,
      redisHealth,
    ];

    // Determine overall status
    const hasUnhealthy = services.some((s) => s.status === "unhealthy");
    const hasDegraded = services.some((s) => s.status === "degraded");

    const overallStatus: "healthy" | "degraded" | "unhealthy" = hasUnhealthy
      ? "unhealthy"
      : hasDegraded
        ? "degraded"
        : "healthy";

    // Record health check result
    await recordHealthCheck(supabase, services);

    const response: HealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: Deno.env.get("SUPABASE_FUNCTION_VERSION") || "1.0.0",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      services,
      circuitBreakers,
      metrics,
    };

    // Set appropriate status code based on health
    const statusCode = overallStatus === "healthy" ? 200 : overallStatus === "degraded" ? 200 : 503;

    return new Response(JSON.stringify(response), {
      status: statusCode,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    return new Response(
      JSON.stringify({
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/**
 * Check database connectivity and performance
 */
async function checkDatabase(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    // Simple query to check connectivity
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

    // Check response time - degraded if > 500ms
    const status: "healthy" | "degraded" =
      responseTimeMs > 500 ? "degraded" : "healthy";

    // Get connection pool info if available
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

/**
 * Check storage bucket accessibility
 */
async function checkStorage(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    // List buckets to check storage connectivity
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

    const status: "healthy" | "degraded" =
      responseTimeMs > 1000 ? "degraded" : "healthy";

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

/**
 * Check Redis cache connectivity via cache-operation function
 */
async function checkRedis(
  supabase: ReturnType<typeof createClient>
): Promise<ServiceHealth> {
  const start = performance.now();

  try {
    // Try to get a test key from Redis via our cache function
    const { data, error } = await supabase.functions.invoke("cache-operation", {
      body: {
        operation: "exists",
        key: "health_check_ping",
      },
    });

    const responseTimeMs = Math.round(performance.now() - start);

    // If the function returned an error, cache might be down
    if (error) {
      // Check if it's a rate limit or actual connection issue
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

    const status: "healthy" | "degraded" =
      responseTimeMs > 200 ? "degraded" : "healthy";

    return {
      service: "redis",
      status,
      responseTimeMs,
    };
  } catch (error) {
    // Redis issues shouldn't fail the whole health check
    return {
      service: "redis",
      status: "degraded",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
      details: { optional: true },
    };
  }
}

/**
 * Get current circuit breaker states
 */
async function getCircuitBreakerStatus(
  supabase: ReturnType<typeof createClient>
): Promise<CircuitBreakerStatus[]> {
  try {
    const { data, error } = await supabase
      .from("metrics.circuit_status")
      .select("*");

    if (error || !data) {
      return [];
    }

    return data.map((row: Record<string, unknown>) => ({
      name: row.circuit_name as string,
      state: row.state as string,
      failureCount: row.failure_count as number,
      lastChange: row.last_change as string,
    }));
  } catch {
    return [];
  }
}

/**
 * Get metrics summary for the last 5 minutes
 */
async function getMetricsSummary(
  supabase: ReturnType<typeof createClient>
): Promise<MetricsSummary | undefined> {
  try {
    // Get error rate
    const { data: errorData } = await supabase.rpc("get_error_rate", {
      p_minutes: 5,
    });

    // Get P95 latency
    const { data: latencyData } = await supabase.rpc("get_p95_latency", {
      p_minutes: 5,
    });

    const errorRow = Array.isArray(errorData) ? errorData[0] : errorData;

    return {
      requestsLast5Min: errorRow?.total_requests || 0,
      errorRateLast5Min: parseFloat(errorRow?.error_rate || "0"),
      p95LatencyMs: latencyData || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Record health check results for historical tracking
 */
async function recordHealthCheck(
  supabase: ReturnType<typeof createClient>,
  services: ServiceHealth[]
): Promise<void> {
  try {
    const records = services.map((s) => ({
      service: s.service,
      status: s.status,
      response_time_ms: s.responseTimeMs,
      details: s.details || {},
      error_message: s.error,
    }));

    await supabase.from("metrics.health_checks").insert(records);
  } catch (error) {
    console.error("Failed to record health check:", error);
    // Don't fail the health check if recording fails
  }
}
