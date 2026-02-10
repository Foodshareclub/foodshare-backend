/**
 * Health Module - Main Orchestration Service
 *
 * Coordinates all health checks, alerting, and metrics recording.
 * Provides a unified interface for the health endpoint.
 */

import { getSupabaseClient } from "../supabase.ts";
import { logger } from "../logger.ts";
import { getAllCircuitStatuses } from "../circuit-breaker.ts";
import {
  getMetricsSummary as getMetricsSummaryFromDB,
  recordHealthCheck as recordHealthCheckToDB,
} from "../metrics.ts";

import {
  FunctionHealthResult,
  HEALTH_VERSION,
  HealthCheckSummary,
  HealthStatus,
  ServiceHealth,
} from "./types.ts";
import { EDGE_FUNCTIONS, getFunctionConfig, getQuickCheckFunctions } from "./config.ts";
import { createFunctionChecker, FunctionChecker } from "./checkers/function-checker.ts";
import { checkDatabase } from "./checkers/database-checker.ts";
import { checkStorage } from "./checkers/storage-checker.ts";
import { createTelegramAlerter, TelegramAlerter } from "./alerting/telegram-alerter.ts";
import { AlertStateManager, getAlertStateManager } from "./alerting/alert-state.ts";

// =============================================================================
// Service Configuration
// =============================================================================

export interface HealthServiceConfig {
  /** Enable Telegram alerting */
  enableAlerts?: boolean;
}

// =============================================================================
// Health Service
// =============================================================================

export class HealthService {
  private readonly functionChecker: FunctionChecker;
  private readonly alerter: TelegramAlerter | null;
  private readonly alertState: AlertStateManager;
  private readonly startTime: number;

  constructor(config?: HealthServiceConfig) {
    this.functionChecker = createFunctionChecker();
    this.alerter = config?.enableAlerts !== false ? createTelegramAlerter() : null;
    this.alertState = getAlertStateManager();
    this.startTime = Date.now();
  }

  /**
   * Get system uptime in seconds
   */
  getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Quick health check - just database status
   */
  async checkQuickHealth(): Promise<
    { status: string; timestamp: string; version: string; database: string }
  > {
    const supabase = getSupabaseClient();
    const dbHealth = await checkDatabase(supabase);

    return {
      status: dbHealth.status === "healthy" ? "ok" : dbHealth.status,
      timestamp: new Date().toISOString(),
      version: HEALTH_VERSION,
      database: dbHealth.status,
    };
  }

  /**
   * Full health check - database, storage, circuit breakers, metrics
   */
  async checkFullHealth(): Promise<{
    status: HealthStatus;
    timestamp: string;
    version: string;
    uptime: number;
    services: ServiceHealth[];
    circuitBreakers: { name: string; state: string; failureCount: number }[];
    metrics?: { requestsLast5Min: number; errorRateLast5Min: number; p95LatencyMs: number };
  }> {
    const supabase = getSupabaseClient();

    // Run all checks in parallel
    const [dbHealth, storageHealth, metrics] = await Promise.all([
      checkDatabase(supabase),
      checkStorage(supabase),
      getMetricsSummaryFromDB(5).catch(() => null),
    ]);

    // Get circuit breaker statuses
    const circuitStatuses = getAllCircuitStatuses();
    const circuitBreakers = Object.entries(circuitStatuses).map(([name, status]) => ({
      name,
      state: status.state,
      failureCount: status.failures,
    }));

    const services = [dbHealth, storageHealth];
    const hasUnhealthy = services.some((s) => s.status === "unhealthy");
    const hasDegraded = services.some((s) => s.status === "degraded");

    const overallStatus: HealthStatus = hasUnhealthy
      ? "unhealthy"
      : hasDegraded
      ? "degraded"
      : "healthy";

    // Record health checks
    for (const service of services) {
      await recordHealthCheckToDB(
        service.service,
        service.status,
        service.responseTimeMs,
        service.details,
        service.error,
      );
    }

    logger.info("Health check completed", { status: overallStatus });

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: HEALTH_VERSION,
      uptime: this.getUptime(),
      services,
      circuitBreakers,
      metrics: metrics
        ? {
          requestsLast5Min: metrics.totalRequests,
          errorRateLast5Min: metrics.errorRate,
          p95LatencyMs: metrics.p95Latency,
        }
        : undefined,
    };
  }

  /**
   * Check all edge functions
   */
  async checkAllFunctions(quickCheck = false): Promise<HealthCheckSummary> {
    const startMs = performance.now();
    const functionsToCheck = quickCheck ? getQuickCheckFunctions() : EDGE_FUNCTIONS;

    logger.info("Starting edge function health check", {
      totalFunctions: functionsToCheck.length,
      quickCheck,
    });

    // Check all functions
    const results = await this.functionChecker.checkAllFunctions(functionsToCheck);

    // Categorize results
    const healthy = results.filter((r) => r.status === "healthy");
    const degraded = results.filter((r) => r.status === "degraded");
    const unhealthy = results.filter((r) => r.status === "unhealthy");
    const timeout = results.filter((r) => r.status === "timeout");

    const criticalIssues = results.filter(
      (r) => r.critical && (r.status === "unhealthy" || r.status === "timeout"),
    );
    const degradedFunctions = results.filter((r) => r.status === "degraded");

    // Determine overall status
    let overallStatus: HealthStatus = "healthy";
    if (criticalIssues.length > 0) {
      overallStatus = "unhealthy";
    } else if (unhealthy.length > 0 || timeout.length > 0) {
      overallStatus = "degraded";
    } else if (degraded.length > 0) {
      overallStatus = "degraded";
    }

    const summary: HealthCheckSummary = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: HEALTH_VERSION,
      uptime: this.getUptime(),
      functions: {
        total: results.length,
        healthy: healthy.length,
        degraded: degraded.length,
        unhealthy: unhealthy.length,
        timeout: timeout.length,
      },
      criticalIssues,
      degradedFunctions,
    };

    // Handle alerting
    const allUnhealthy = [...unhealthy, ...timeout];
    await this.handleAlerting(summary, allUnhealthy);

    const totalTimeMs = Math.round(performance.now() - startMs);
    logger.info("Edge function health check completed", {
      status: overallStatus,
      totalTimeMs,
      healthy: healthy.length,
      unhealthy: unhealthy.length,
      timeout: timeout.length,
      alertSent: summary.alertSent,
    });

    // Record summary to database
    await recordHealthCheckToDB(
      "edge_functions",
      overallStatus,
      totalTimeMs,
      {
        functions: summary.functions,
        criticalIssueCount: criticalIssues.length,
      },
    );

    return summary;
  }

  /**
   * Check a single function by name
   */
  async checkSingleFunction(
    functionName: string,
  ): Promise<FunctionHealthResult | { error: string; availableFunctions?: string[] }> {
    const config = getFunctionConfig(functionName);

    if (!config) {
      return {
        error: `Unknown function: ${functionName}`,
        availableFunctions: EDGE_FUNCTIONS.map((f) => f.name),
      };
    }

    return await this.functionChecker.checkFunctionWithRetry(config);
  }

  /**
   * Handle alerting logic
   */
  private async handleAlerting(
    summary: HealthCheckSummary,
    allUnhealthy: FunctionHealthResult[],
  ): Promise<void> {
    if (!this.alerter) {
      return;
    }

    if (allUnhealthy.length > 0) {
      // Check if we should send alert (respects cooldown)
      const criticalIssues = allUnhealthy.filter((f) => f.critical);
      const shouldAlert = criticalIssues.some((fn) =>
        this.alertState.shouldSendAlert(fn.name, false)
      );

      if (shouldAlert) {
        const alertMessage = this.alerter.formatAlertMessage(summary, allUnhealthy, false);
        const alertSent = await this.alerter.sendAlert(alertMessage);
        summary.alertSent = alertSent;
        summary.alertMessage = alertSent ? "Alert sent to Telegram" : "Alert failed to send";
      } else {
        summary.alertMessage = "Alert suppressed (cooldown active)";
      }
    } else {
      // Check if this is a recovery (all healthy after previous failures)
      const wasUnhealthy = this.alertState.hasAnyFailures();

      if (wasUnhealthy) {
        // Send recovery notification
        const alertMessage = this.alerter.formatAlertMessage(summary, [], true);
        const alertSent = await this.alerter.sendAlert(alertMessage, true); // Silent notification
        summary.alertSent = alertSent;
        summary.alertMessage = alertSent ? "Recovery alert sent" : "Recovery alert failed";

        // Clear all alert states
        this.alertState.clear();
      }
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let serviceInstance: HealthService | null = null;

/**
 * Get the health service singleton
 */
export function getHealthService(config?: HealthServiceConfig): HealthService {
  if (!serviceInstance) {
    serviceInstance = new HealthService(config);
  }
  return serviceInstance;
}

/**
 * Reset the health service (for testing)
 */
export function resetHealthService(): void {
  serviceInstance = null;
}
