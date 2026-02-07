/**
 * Health Module - Unified Health Monitoring System
 *
 * Enterprise-grade health monitoring for all Foodshare edge functions.
 *
 * Features:
 * - Full edge function fleet health checks (50+ functions)
 * - Intelligent alert deduplication (no Telegram spam)
 * - Auto-recovery detection with celebration alerts
 * - Cold start detection (retries before alerting)
 * - Severity-based alerting (critical vs degraded)
 *
 * Usage:
 * ```typescript
 * import { getHealthService } from "../_shared/health/index.ts";
 *
 * const service = getHealthService();
 *
 * // Quick health check
 * const quick = await service.checkQuickHealth();
 *
 * // Full service health
 * const full = await service.checkFullHealth();
 *
 * // Check all functions
 * const summary = await service.checkAllFunctions();
 *
 * // Check single function
 * const result = await service.checkSingleFunction("bff");
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
  HealthStatus,
  FunctionConfig,
  FunctionHealthResult,
  ServiceHealth,
  HealthCheckSummary,
  AlertState,
} from "./types.ts";

export {
  HEALTH_CHECK_TIMEOUT_MS,
  COLD_START_RETRY_DELAY_MS,
  MAX_CONCURRENT_CHECKS,
  ALERT_COOLDOWN_MS,
  DATABASE_DEGRADED_THRESHOLD_MS,
  STORAGE_DEGRADED_THRESHOLD_MS,
  FUNCTION_DEGRADED_THRESHOLD_MS,
  HEALTH_VERSION,
} from "./types.ts";

// =============================================================================
// Configuration
// =============================================================================

export {
  CRITICAL_FUNCTIONS,
  API_FUNCTIONS,
  DATA_FUNCTIONS,
  UTILITY_FUNCTIONS,
  EDGE_FUNCTIONS,
  getFunctionConfig,
  getCriticalFunctions,
  getQuickCheckFunctions,
  getAllFunctionNames,
  isFunctionRegistered,
} from "./config.ts";

// =============================================================================
// Service
// =============================================================================

export type { HealthServiceConfig } from "./health-service.ts";
export { HealthService, getHealthService, resetHealthService } from "./health-service.ts";

// =============================================================================
// Checkers (for testing/extension)
// =============================================================================

export type { FunctionCheckerConfig } from "./checkers/function-checker.ts";
export { FunctionChecker, createFunctionChecker, resetFunctionChecker } from "./checkers/function-checker.ts";
export { checkDatabase } from "./checkers/database-checker.ts";
export { checkStorage } from "./checkers/storage-checker.ts";

// =============================================================================
// Alerting (for testing/extension)
// =============================================================================

export type { TelegramConfig } from "./alerting/telegram-alerter.ts";
export { TelegramAlerter, createTelegramAlerter, resetTelegramAlerter } from "./alerting/telegram-alerter.ts";
export { AlertStateManager, getAlertStateManager, resetAlertStateManager } from "./alerting/alert-state.ts";
