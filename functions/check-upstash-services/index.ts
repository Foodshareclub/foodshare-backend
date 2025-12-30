/**
 * Check Upstash Services Edge Function
 *
 * Health check endpoint for all Upstash services:
 * - Redis (PING)
 * - Vector (INFO)
 * - QStash (schedules list)
 * - Workflow (logs)
 * - Search (INFO)
 *
 * Usage:
 * GET /check-upstash-services
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Response Types
// =============================================================================

interface ServiceResult {
  service: string;
  status: "ok" | "error";
  message: string;
  details?: unknown;
  responseTime?: number;
}

interface HealthCheckResponse {
  success: boolean;
  timestamp: string;
  summary: {
    total: number;
    healthy: number;
    unhealthy: number;
    avgResponseTime: number;
  };
  results: ServiceResult[];
}

// =============================================================================
// Service Check Helpers
// =============================================================================

async function checkRedis(
  redisUrl: string,
  redisToken: string
): Promise<ServiceResult> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${redisUrl}/ping`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    const data = await response.json();
    const responseTime = Date.now() - startTime;

    return {
      service: "Redis",
      status: data.result === "PONG" ? "ok" : "error",
      message: data.result === "PONG" ? "PING successful" : "Unexpected response",
      details: data,
      responseTime,
    };
  } catch (error) {
    return {
      service: "Redis",
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkVector(
  vectorUrl: string,
  vectorToken: string
): Promise<ServiceResult> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${vectorUrl}/info`, {
      headers: { Authorization: `Bearer ${vectorToken}` },
    });
    const data = await response.json();
    const responseTime = Date.now() - startTime;

    return {
      service: "Vector",
      status: response.ok && data.result ? "ok" : "error",
      message: response.ok
        ? `Vector DB ready (${data.result?.vectorCount || 0} vectors)`
        : "Failed to get info",
      details: data,
      responseTime,
    };
  } catch (error) {
    return {
      service: "Vector",
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkQStash(
  qstashUrl: string,
  qstashToken: string
): Promise<ServiceResult> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${qstashUrl}/v2/schedules`, {
      method: "GET",
      headers: { Authorization: `Bearer ${qstashToken}` },
    });
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      return {
        service: "QStash",
        status: "ok",
        message: "QStash API accessible",
        details: { schedulesCount: data.length || 0 },
        responseTime,
      };
    } else {
      const errorText = await response.text();
      return {
        service: "QStash",
        status: "error",
        message: `HTTP ${response.status}: ${errorText}`,
        responseTime,
      };
    }
  } catch (error) {
    return {
      service: "QStash",
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkWorkflow(
  qstashUrl: string,
  qstashToken: string
): Promise<ServiceResult> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${qstashUrl}/v2/workflows/logs`, {
      method: "GET",
      headers: { Authorization: `Bearer ${qstashToken}` },
    });
    const responseTime = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      return {
        service: "Workflow",
        status: "ok",
        message: "Workflow API accessible",
        details: { runsCount: data.runs?.length || 0 },
        responseTime,
      };
    } else {
      const errorText = await response.text();
      return {
        service: "Workflow",
        status: "error",
        message: `HTTP ${response.status}: ${errorText}`,
        responseTime,
      };
    }
  } catch (error) {
    return {
      service: "Workflow",
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkSearch(
  searchUrl: string,
  searchToken: string
): Promise<ServiceResult> {
  try {
    const startTime = Date.now();
    const response = await fetch(`${searchUrl}/info`, {
      headers: { Authorization: `Bearer ${searchToken}` },
    });
    const data = await response.json();
    const responseTime = Date.now() - startTime;

    return {
      service: "Search",
      status: response.ok && data.result ? "ok" : "error",
      message: response.ok
        ? `Search ready (${data.result?.vectorCount || 0} vectors)`
        : "Failed to get info",
      details: data,
      responseTime,
    };
  } catch (error) {
    return {
      service: "Search",
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleHealthCheck(
  ctx: HandlerContext
): Promise<Response> {
  const { supabase, ctx: requestCtx } = ctx;

  logger.info("Checking Upstash services", {
    requestId: requestCtx?.requestId,
  });

  // Fetch secrets from database
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
    logger.error("Failed to fetch secrets", { error: secretsError.message });
    return new Response(
      JSON.stringify({
        success: false,
        error: `Failed to fetch secrets: ${secretsError.message}`,
        timestamp: new Date().toISOString(),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Helper to get secret value
  const getSecret = (name: string): string | undefined =>
    secrets?.find((s: { name: string; value: string }) => s.name === name)?.value;

  // Run all checks in parallel
  const results = await Promise.all([
    checkRedis(
      getSecret("UPSTASH_REDIS_REST_URL") || "",
      getSecret("UPSTASH_REDIS_REST_TOKEN") || ""
    ),
    checkVector(
      getSecret("UPSTASH_VECTOR_REST_URL") || "",
      getSecret("UPSTASH_VECTOR_REST_TOKEN") || ""
    ),
    checkQStash(
      getSecret("QSTASH_URL") || "",
      getSecret("QSTASH_TOKEN") || ""
    ),
    checkWorkflow(
      getSecret("QSTASH_URL") || "",
      getSecret("QSTASH_TOKEN") || ""
    ),
    checkSearch(
      getSecret("UPSTASH_SEARCH_REST_URL") || "",
      getSecret("UPSTASH_SEARCH_REST_TOKEN") || ""
    ),
  ]);

  const allOk = results.every((r) => r.status === "ok");
  const responseTimes = results.filter((r) => r.responseTime).map((r) => r.responseTime!);
  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : 0;

  const response: HealthCheckResponse = {
    success: allOk,
    timestamp: new Date().toISOString(),
    summary: {
      total: results.length,
      healthy: results.filter((r) => r.status === "ok").length,
      unhealthy: results.filter((r) => r.status === "error").length,
      avgResponseTime,
    },
    results,
  };

  logger.info("Upstash health check complete", {
    success: allOk,
    healthy: response.summary.healthy,
    unhealthy: response.summary.unhealthy,
  });

  return ok(response, ctx, allOk ? 200 : 500);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "check-upstash-services",
  version: "2.0.0",
  requireAuth: false, // Health check endpoint
  routes: {
    GET: {
      handler: handleHealthCheck,
    },
  },
});
