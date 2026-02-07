/**
 * Health Module - Function Health Checker
 *
 * Handles health checking for edge functions with:
 * - Configurable timeouts
 * - Cold start detection and retry
 * - Batch processing with concurrency control
 */

import { logger } from "../../logger.ts";
import {
  FunctionConfig,
  FunctionHealthResult,
  HealthStatus,
  HEALTH_CHECK_TIMEOUT_MS,
  COLD_START_RETRY_DELAY_MS,
  MAX_CONCURRENT_CHECKS,
  FUNCTION_DEGRADED_THRESHOLD_MS,
} from "../types.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface FunctionCheckerConfig {
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase anonymous key for authentication */
  supabaseAnonKey: string;
  /** Timeout for individual function checks (ms) */
  timeoutMs?: number;
  /** Delay before cold start retry (ms) */
  retryDelayMs?: number;
  /** Maximum concurrent checks */
  maxConcurrent?: number;
}

// =============================================================================
// Function Checker Class
// =============================================================================

export class FunctionChecker {
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxConcurrent: number;

  constructor(config: FunctionCheckerConfig) {
    this.supabaseUrl = config.supabaseUrl;
    this.supabaseAnonKey = config.supabaseAnonKey;
    this.timeoutMs = config.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    this.retryDelayMs = config.retryDelayMs ?? COLD_START_RETRY_DELAY_MS;
    this.maxConcurrent = config.maxConcurrent ?? MAX_CONCURRENT_CHECKS;
  }

  /**
   * Check a single function's health
   */
  async checkFunction(config: FunctionConfig, isRetry = false): Promise<FunctionHealthResult> {
    const startMs = performance.now();
    const url = `${this.supabaseUrl}/functions/v1/${config.name}`;
    const expectedStatuses = config.expectedStatus || [200, 400, 401, 404];

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.supabaseAnonKey}`,
        },
        body: JSON.stringify(config.testPayload || {}),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseTimeMs = Math.round(performance.now() - startMs);

      // Check if response status is acceptable
      const isHealthy = expectedStatuses.includes(response.status);

      // Determine status based on response time and HTTP status
      let status: HealthStatus;
      if (!isHealthy) {
        status = "unhealthy";
      } else if (responseTimeMs > FUNCTION_DEGRADED_THRESHOLD_MS) {
        status = "degraded";
      } else {
        status = "healthy";
      }

      return {
        name: config.name,
        status,
        responseTimeMs,
        httpStatus: response.status,
        critical: config.critical,
        retried: isRetry,
        recoveredFromColdStart: false,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const responseTimeMs = Math.round(performance.now() - startMs);

      // Handle timeout specifically
      if (error instanceof Error && error.name === "AbortError") {
        return {
          name: config.name,
          status: "timeout",
          responseTimeMs,
          error: `Timeout after ${this.timeoutMs}ms`,
          critical: config.critical,
          retried: isRetry,
          recoveredFromColdStart: false,
        };
      }

      return {
        name: config.name,
        status: "unhealthy",
        responseTimeMs,
        error: error instanceof Error ? error.message : String(error),
        critical: config.critical,
        retried: isRetry,
        recoveredFromColdStart: false,
      };
    }
  }

  /**
   * Check a function with cold start retry
   * If the first attempt times out or fails, waits and retries once
   */
  async checkFunctionWithRetry(config: FunctionConfig): Promise<FunctionHealthResult> {
    // First attempt
    let result = await this.checkFunction(config, false);

    // If timeout or unhealthy, retry once (cold start protection)
    if (result.status === "timeout" || result.status === "unhealthy") {
      logger.info(`Retrying ${config.name} after potential cold start`, {
        firstAttemptStatus: result.status,
        firstAttemptTime: result.responseTimeMs,
      });

      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      const retryResult = await this.checkFunction(config, true);

      // If retry succeeded, mark as recovered from cold start
      if (retryResult.status === "healthy" || retryResult.status === "degraded") {
        retryResult.recoveredFromColdStart = true;
        return retryResult;
      }

      // Return retry result (still failed)
      return retryResult;
    }

    return result;
  }

  /**
   * Check all functions with controlled concurrency
   */
  async checkAllFunctions(functions: FunctionConfig[]): Promise<FunctionHealthResult[]> {
    const results: FunctionHealthResult[] = [];
    const batches: FunctionConfig[][] = [];

    // Split into batches for controlled concurrency
    for (let i = 0; i < functions.length; i += this.maxConcurrent) {
      batches.push(functions.slice(i, i + this.maxConcurrent));
    }

    // Process batches
    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map((config) => this.checkFunctionWithRetry(config))
      );
      results.push(...batchResults);
    }

    return results;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

let checkerInstance: FunctionChecker | null = null;

/**
 * Create or get the function checker instance (singleton)
 */
export function createFunctionChecker(config?: Partial<FunctionCheckerConfig>): FunctionChecker {
  if (!checkerInstance) {
    const supabaseUrl = config?.supabaseUrl ?? Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = config?.supabaseAnonKey ?? Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }

    checkerInstance = new FunctionChecker({
      supabaseUrl,
      supabaseAnonKey,
      ...config,
    });
  }

  return checkerInstance;
}

/**
 * Reset the function checker instance (for testing)
 */
export function resetFunctionChecker(): void {
  checkerInstance = null;
}
