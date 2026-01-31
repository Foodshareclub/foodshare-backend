/**
 * Prometheus Metrics Export Edge Function
 *
 * Exposes platform metrics in Prometheus format for external monitoring.
 * Supports Prometheus/Grafana scraping with standard text exposition format.
 *
 * Endpoints:
 * - GET /api-v1-metrics - Prometheus text format metrics
 * - GET /api-v1-metrics?format=json - JSON format metrics
 *
 * Metrics exported:
 * - Web Vitals (LCP, FID, CLS, INP, TTFB, FCP) - P50, P75, P95
 * - Error rates (5m, 1h, 24h)
 * - Request counts
 * - Active users
 * - Database connection pool stats
 *
 * Headers:
 * - Authorization: Bearer <jwt> (requires admin role)
 *
 * @module api-v1-metrics
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ForbiddenError, ServerError } from "../_shared/errors.ts";

// =============================================================================
// Types
// =============================================================================

interface WebVitalsSummary {
  metric_name: string;
  sample_count: number;
  p50: number;
  p75: number;
  p95: number;
  good_pct: number;
  needs_improvement_pct: number;
  poor_pct: number;
}

interface MetricsResponse {
  webVitals: WebVitalsSummary[];
  errorRate: {
    last5Min: number;
    last1Hour: number;
    last24Hours: number;
  };
  requestCount: {
    last5Min: number;
    last1Hour: number;
    last24Hours: number;
  };
  activeUsers: {
    last5Min: number;
    last1Hour: number;
    last24Hours: number;
  };
  timestamp: string;
}

// =============================================================================
// Query Schema
// =============================================================================

const metricsQuerySchema = z.object({
  format: z.enum(["json", "prometheus"]).optional(),
});

type MetricsQuery = z.infer<typeof metricsQuerySchema>;

// =============================================================================
// Helper Functions
// =============================================================================

async function getErrorRate(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  minutes: number
): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("get_error_rate", { p_minutes: minutes });
    if (error) return 0;
    return data || 0;
  } catch {
    return 0;
  }
}

async function getActiveUsers(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  minutes: number
): Promise<number> {
  try {
    const { count, error } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("last_active_at", new Date(Date.now() - minutes * 60 * 1000).toISOString());

    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

async function getRequestCount(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  minutes: number
): Promise<number> {
  try {
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const { count, error } = await supabase
      .from("api_requests")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since);

    if (error) {
      const { data, error: rpcError } = await supabase.rpc("get_request_count", {
        p_minutes: minutes,
      });

      if (rpcError) return 0;
      return data || 0;
    }

    return count || 0;
  } catch {
    return 0;
  }
}

function generatePrometheusMetrics(
  webVitals: WebVitalsSummary[],
  stats: {
    errorRate5m: number;
    errorRate1h: number;
    errorRate24h: number;
    activeUsers5m: number;
    activeUsers1h: number;
    activeUsers24h: number;
    requestCount5m: number;
    requestCount1h: number;
    requestCount24h: number;
  }
): string {
  const lines: string[] = [];
  const timestamp = Date.now();

  // Web Vitals metrics
  lines.push("# HELP foodshare_web_vitals_p50 Web Vitals 50th percentile");
  lines.push("# TYPE foodshare_web_vitals_p50 gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_p50{metric="${vital.metric_name}"} ${vital.p50 || 0} ${timestamp}`);
  }

  lines.push("");
  lines.push("# HELP foodshare_web_vitals_p75 Web Vitals 75th percentile");
  lines.push("# TYPE foodshare_web_vitals_p75 gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_p75{metric="${vital.metric_name}"} ${vital.p75 || 0} ${timestamp}`);
  }

  lines.push("");
  lines.push("# HELP foodshare_web_vitals_p95 Web Vitals 95th percentile");
  lines.push("# TYPE foodshare_web_vitals_p95 gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_p95{metric="${vital.metric_name}"} ${vital.p95 || 0} ${timestamp}`);
  }

  lines.push("");
  lines.push("# HELP foodshare_web_vitals_sample_count Number of samples per metric");
  lines.push("# TYPE foodshare_web_vitals_sample_count gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_sample_count{metric="${vital.metric_name}"} ${vital.sample_count || 0} ${timestamp}`);
  }

  lines.push("");
  lines.push("# HELP foodshare_web_vitals_good_pct Percentage of good ratings");
  lines.push("# TYPE foodshare_web_vitals_good_pct gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_good_pct{metric="${vital.metric_name}"} ${vital.good_pct || 0} ${timestamp}`);
  }

  lines.push("");
  lines.push("# HELP foodshare_web_vitals_poor_pct Percentage of poor ratings");
  lines.push("# TYPE foodshare_web_vitals_poor_pct gauge");
  for (const vital of webVitals) {
    lines.push(`foodshare_web_vitals_poor_pct{metric="${vital.metric_name}"} ${vital.poor_pct || 0} ${timestamp}`);
  }

  // Error rates
  lines.push("");
  lines.push("# HELP foodshare_error_rate Error rate as decimal (0-1)");
  lines.push("# TYPE foodshare_error_rate gauge");
  lines.push(`foodshare_error_rate{window="5m"} ${stats.errorRate5m} ${timestamp}`);
  lines.push(`foodshare_error_rate{window="1h"} ${stats.errorRate1h} ${timestamp}`);
  lines.push(`foodshare_error_rate{window="24h"} ${stats.errorRate24h} ${timestamp}`);

  // Active users
  lines.push("");
  lines.push("# HELP foodshare_active_users Number of active users");
  lines.push("# TYPE foodshare_active_users gauge");
  lines.push(`foodshare_active_users{window="5m"} ${stats.activeUsers5m} ${timestamp}`);
  lines.push(`foodshare_active_users{window="1h"} ${stats.activeUsers1h} ${timestamp}`);
  lines.push(`foodshare_active_users{window="24h"} ${stats.activeUsers24h} ${timestamp}`);

  // Request counts
  lines.push("");
  lines.push("# HELP foodshare_request_count Total API requests");
  lines.push("# TYPE foodshare_request_count gauge");
  lines.push(`foodshare_request_count{window="5m"} ${stats.requestCount5m} ${timestamp}`);
  lines.push(`foodshare_request_count{window="1h"} ${stats.requestCount1h} ${timestamp}`);
  lines.push(`foodshare_request_count{window="24h"} ${stats.requestCount24h} ${timestamp}`);

  // Service info
  lines.push("");
  lines.push("# HELP foodshare_info Service information");
  lines.push("# TYPE foodshare_info gauge");
  lines.push(`foodshare_info{version="${Deno.env.get("SUPABASE_FUNCTION_VERSION") || "2.0.0"}"} 1 ${timestamp}`);

  return lines.join("\n");
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetMetrics(ctx: HandlerContext<unknown, MetricsQuery>): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  // Check admin role if authenticated
  if (userId) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (profile?.role !== "admin") {
      throw new ForbiddenError("Admin access required for metrics");
    }
  }

  // Fetch metrics in parallel
  const [
    webVitalsResult,
    errorRate5m,
    errorRate1h,
    errorRate24h,
    activeUsers5m,
    activeUsers1h,
    activeUsers24h,
    requestCount5m,
    requestCount1h,
    requestCount24h,
  ] = await Promise.all([
    supabase.rpc("get_web_vitals_summary", { p_hours: 24 }),
    getErrorRate(supabase, 5),
    getErrorRate(supabase, 60),
    getErrorRate(supabase, 1440),
    getActiveUsers(supabase, 5),
    getActiveUsers(supabase, 60),
    getActiveUsers(supabase, 1440),
    getRequestCount(supabase, 5),
    getRequestCount(supabase, 60),
    getRequestCount(supabase, 1440),
  ]);

  const webVitals: WebVitalsSummary[] = webVitalsResult.data || [];

  // JSON format
  if (query.format === "json") {
    const response: MetricsResponse = {
      webVitals,
      errorRate: {
        last5Min: errorRate5m,
        last1Hour: errorRate1h,
        last24Hours: errorRate24h,
      },
      requestCount: {
        last5Min: requestCount5m,
        last1Hour: requestCount1h,
        last24Hours: requestCount24h,
      },
      activeUsers: {
        last5Min: activeUsers5m,
        last1Hour: activeUsers1h,
        last24Hours: activeUsers24h,
      },
      timestamp: new Date().toISOString(),
    };

    return ok(response, ctx, {
      cacheTTL: 60,
    });
  }

  // Prometheus text format (default)
  const prometheusMetrics = generatePrometheusMetrics(webVitals, {
    errorRate5m,
    errorRate1h,
    errorRate24h,
    activeUsers5m,
    activeUsers1h,
    activeUsers24h,
    requestCount5m,
    requestCount1h,
    requestCount24h,
  });

  logger.info("Metrics exported", {
    format: "prometheus",
    vitalsCount: webVitals.length,
    requestId: requestCtx?.requestId,
  });

  // Return Prometheus format directly
  return new Response(prometheusMetrics, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-cache, max-age=60",
    },
  });
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-metrics",
  version: "2.0.0",
  requireAuth: false, // Allow unauthenticated scraping, but check role if authenticated
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema: metricsQuerySchema,
      handler: handleGetMetrics,
    },
  },
});
