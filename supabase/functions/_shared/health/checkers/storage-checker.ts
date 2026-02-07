/**
 * Health Module - Storage Health Checker
 *
 * Checks Supabase storage connectivity and response time.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { ServiceHealth, HealthStatus, STORAGE_DEGRADED_THRESHOLD_MS } from "../types.ts";

/**
 * Check storage health by listing buckets
 * @param supabase - Supabase client instance
 * @returns Service health result
 */
export async function checkStorage(supabase: SupabaseClient): Promise<ServiceHealth> {
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

    const status: HealthStatus = responseTimeMs > STORAGE_DEGRADED_THRESHOLD_MS ? "degraded" : "healthy";
    return { service: "storage", status, responseTimeMs };
  } catch (error) {
    return {
      service: "storage",
      status: "unhealthy",
      responseTimeMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}
