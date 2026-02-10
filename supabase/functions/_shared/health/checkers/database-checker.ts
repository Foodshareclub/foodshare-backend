/**
 * Health Module - Database Health Checker
 *
 * Checks database connectivity and response time.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { DATABASE_DEGRADED_THRESHOLD_MS, HealthStatus, ServiceHealth } from "../types.ts";

/**
 * Check database health by performing a simple query
 * @param supabase - Supabase client instance
 * @returns Service health result
 */
export async function checkDatabase(supabase: SupabaseClient): Promise<ServiceHealth> {
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

    const status: HealthStatus = responseTimeMs > DATABASE_DEGRADED_THRESHOLD_MS
      ? "degraded"
      : "healthy";
    return { service: "database", status, responseTimeMs };
  } catch (error) {
    return {
      service: "database",
      status: "unhealthy",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}
