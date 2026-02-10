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
  AlertState,
  FunctionConfig,
  FunctionHealthResult,
  HealthCheckSummary,
  HealthStatus,
  ServiceHealth,
} from "./types.ts";

export {
  ALERT_COOLDOWN_MS,
  COLD_START_RETRY_DELAY_MS,
  DATABASE_DEGRADED_THRESHOLD_MS,
  FUNCTION_DEGRADED_THRESHOLD_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_VERSION,
  MAX_CONCURRENT_CHECKS,
  STORAGE_DEGRADED_THRESHOLD_MS,
} from "./types.ts";

// =============================================================================
// Configuration
// =============================================================================

export {
  API_FUNCTIONS,
  CRITICAL_FUNCTIONS,
  DATA_FUNCTIONS,
  EDGE_FUNCTIONS,
  getAllFunctionNames,
  getCriticalFunctions,
  getFunctionConfig,
  getQuickCheckFunctions,
  isFunctionRegistered,
  UTILITY_FUNCTIONS,
} from "./config.ts";

// =============================================================================
// Service
// =============================================================================

export type { HealthServiceConfig } from "./health-service.ts";
export { getHealthService, HealthService, resetHealthService } from "./health-service.ts";

// =============================================================================
// Checkers (for testing/extension)
// =============================================================================

export type { FunctionCheckerConfig } from "./checkers/function-checker.ts";
export {
  createFunctionChecker,
  FunctionChecker,
  resetFunctionChecker,
} from "./checkers/function-checker.ts";
export { checkDatabase } from "./checkers/database-checker.ts";
export { checkStorage } from "./checkers/storage-checker.ts";

// =============================================================================
// Alerting (for testing/extension)
// =============================================================================

export type { TelegramConfig } from "./alerting/telegram-alerter.ts";
export {
  createTelegramAlerter,
  resetTelegramAlerter,
  TelegramAlerter,
} from "./alerting/telegram-alerter.ts";
export {
  AlertStateManager,
  getAlertStateManager,
  resetAlertStateManager,
} from "./alerting/alert-state.ts";
