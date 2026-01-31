/**
 * Health Module - Shared Types and Constants
 *
 * Foundation types for the health monitoring system.
 */

// =============================================================================
// Health Status Types
// =============================================================================

/**
 * Possible health statuses for functions and services
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "timeout" | "unknown";

// =============================================================================
// Function Configuration
// =============================================================================

/**
 * Configuration for an edge function in the health check registry
 */
export interface FunctionConfig {
  /** Function name (matches deployment name) */
  name: string;
  /** Whether this function is critical to system operation */
  critical: boolean;
  /** Whether the function requires authentication */
  requiresAuth: boolean;
  /** Custom test payload to send when checking health */
  testPayload?: Record<string, unknown>;
  /** Expected HTTP status codes that indicate health (default: [200, 400, 401, 404]) */
  expectedStatus?: number[];
  /** Custom health endpoint path (if function has dedicated health check) */
  healthEndpoint?: string;
  /** Other functions this depends on */
  dependencies?: string[];
  /** Skip this function in quick check mode */
  skipInQuickCheck?: boolean;
}

// =============================================================================
// Health Check Results
// =============================================================================

/**
 * Result of a health check for a single function
 */
export interface FunctionHealthResult {
  /** Function name */
  name: string;
  /** Health status */
  status: HealthStatus;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** HTTP status code received */
  httpStatus?: number;
  /** Error message if unhealthy */
  error?: string;
  /** Whether this is a critical function */
  critical: boolean;
  /** Whether this result is from a retry attempt */
  retried: boolean;
  /** Whether the function recovered after cold start retry */
  recoveredFromColdStart: boolean;
}

/**
 * Result of a health check for a core service (database, storage, etc.)
 */
export interface ServiceHealth {
  /** Service name */
  service: string;
  /** Health status */
  status: HealthStatus;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** Additional service-specific details */
  details?: Record<string, unknown>;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * Summary of all health checks
 */
export interface HealthCheckSummary {
  /** Overall system status */
  status: HealthStatus;
  /** ISO timestamp of the check */
  timestamp: string;
  /** Health system version */
  version: string;
  /** System uptime in seconds */
  uptime: number;
  /** Function check statistics */
  functions: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    timeout: number;
  };
  /** Functions with critical issues */
  criticalIssues: FunctionHealthResult[];
  /** Functions in degraded state */
  degradedFunctions: FunctionHealthResult[];
  /** Core service health results */
  services?: ServiceHealth[];
  /** Circuit breaker statuses */
  circuitBreakers?: { name: string; state: string; failureCount: number }[];
  /** Recent metrics summary */
  metrics?: { requestsLast5Min: number; errorRateLast5Min: number; p95LatencyMs: number };
  /** Whether an alert was sent */
  alertSent?: boolean;
  /** Alert status message */
  alertMessage?: string;
}

// =============================================================================
// Alert State
// =============================================================================

/**
 * State for a single function's alert tracking
 */
export interface AlertState {
  /** Timestamp of last alert sent */
  lastAlertTime: number;
  /** Number of consecutive failures */
  consecutiveFailures: number;
}

// =============================================================================
// Configuration Constants
// =============================================================================

/** Timeout for individual function health checks (ms) */
export const HEALTH_CHECK_TIMEOUT_MS = 8000;

/** Delay before retrying after potential cold start (ms) */
export const COLD_START_RETRY_DELAY_MS = 2000;

/** Maximum concurrent function checks */
export const MAX_CONCURRENT_CHECKS = 10;

/** Cooldown period between alerts for same function (ms) */
export const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/** Database query degraded threshold (ms) */
export const DATABASE_DEGRADED_THRESHOLD_MS = 500;

/** Storage query degraded threshold (ms) */
export const STORAGE_DEGRADED_THRESHOLD_MS = 1000;

/** Function response degraded threshold (ms) */
export const FUNCTION_DEGRADED_THRESHOLD_MS = 5000;

/** Health system version */
export const HEALTH_VERSION = "3.0.0";
