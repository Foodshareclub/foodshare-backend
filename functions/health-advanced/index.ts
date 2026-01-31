/**
 * Advanced Health Check Endpoint
 * 
 * Comprehensive health monitoring with:
 * - System metrics (memory, uptime)
 * - Performance metrics
 * - Error tracking
 * - Circuit breaker status
 * - Database connectivity
 * - Cache status
 */

import { createAPIHandler, ok } from "../_shared/api-handler.ts";
import { getHealthMetrics } from "../_shared/performance.ts";
import { getErrorStats, getRecentAlerts } from "../_shared/error-tracking.ts";
import { getAllCircuitStatuses } from "../_shared/circuit-breaker.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

export default createAPIHandler({
  service: "health-advanced",
  requireAuth: false,
  routes: {
    GET: {
      handler: async (ctx) => {
        const startTime = Date.now();

        // Get system metrics
        const healthMetrics = getHealthMetrics();

        // Get error statistics
        const errorStats = getErrorStats();
        const recentAlerts = getRecentAlerts(5);

        // Get circuit breaker status
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

        // Determine overall health status
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

        return ok({
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
          circuitBreakers: Object.entries(circuitBreakers).map(([name, status]) => ({
            name,
            state: status.state,
            failures: status.failures,
            totalRequests: status.totalRequests,
            totalFailures: status.totalFailures,
          })),
        }, ctx);
      },
    },
  },
});
