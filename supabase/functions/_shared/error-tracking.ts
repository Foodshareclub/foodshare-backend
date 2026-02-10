/**
 * Error Tracking and Alerting System
 *
 * Centralized error tracking with severity levels, alerting, and aggregation
 */

import { logger } from "./logger.ts";
import { getContext } from "./context.ts";
import type { AppError } from "./errors.ts";

// =============================================================================
// Types
// =============================================================================

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface TrackedError {
  id: string;
  message: string;
  code: string;
  severity: ErrorSeverity;
  stack?: string;
  context: Record<string, unknown>;
  timestamp: string;
  requestId?: string;
  userId?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ErrorAlert {
  errorId: string;
  severity: ErrorSeverity;
  message: string;
  count: number;
  threshold: number;
  timestamp: string;
}

// =============================================================================
// Configuration
// =============================================================================

const ERROR_BUFFER_SIZE = 500;
const ALERT_THRESHOLDS = {
  low: 100,
  medium: 50,
  high: 10,
  critical: 1,
};
// @ts-ignore Kept for future aggregation window support
const _AGGREGATION_WINDOW_MS = 60000; // 1 minute

// =============================================================================
// Error Storage
// =============================================================================

const errorBuffer = new Map<string, TrackedError>();
const recentAlerts: ErrorAlert[] = [];

// =============================================================================
// Error Fingerprinting
// =============================================================================

/**
 * Generate a unique fingerprint for an error
 */
function generateErrorFingerprint(error: Error | AppError): string {
  const message = error.message.replace(/\d+/g, "N"); // Normalize numbers
  const code = "code" in error ? error.code : "UNKNOWN";
  const stackLine = error.stack?.split("\n")[1]?.trim() || "";

  return `${code}:${message}:${stackLine}`;
}

// =============================================================================
// Severity Classification
// =============================================================================

/**
 * Determine error severity based on error type and context
 */
function classifyErrorSeverity(error: Error | AppError): ErrorSeverity {
  if ("statusCode" in error) {
    const statusCode = error.statusCode;

    if (statusCode >= 500) return "critical";
    if (statusCode === 429) return "medium";
    if (statusCode >= 400) return "low";
  }

  // Check error code
  if ("code" in error) {
    const code = error.code;

    if (code.includes("DATABASE") || code.includes("FATAL")) return "critical";
    if (code.includes("AUTH") || code.includes("PERMISSION")) return "high";
    if (code.includes("VALIDATION")) return "low";
  }

  // Check error message
  const message = error.message.toLowerCase();
  if (message.includes("database") || message.includes("connection")) return "critical";
  if (message.includes("timeout")) return "high";
  if (message.includes("not found")) return "low";

  return "medium";
}

// =============================================================================
// Error Tracking
// =============================================================================

/**
 * Track an error with automatic aggregation and alerting
 */
export function trackError(
  error: Error | AppError,
  context: Record<string, unknown> = {},
): void {
  const fingerprint = generateErrorFingerprint(error);
  const severity = classifyErrorSeverity(error);
  const ctx = getContext();
  const now = new Date().toISOString();

  let tracked = errorBuffer.get(fingerprint);

  if (tracked) {
    // Update existing error
    tracked.count++;
    tracked.lastSeen = now;
    tracked.context = { ...tracked.context, ...context };
  } else {
    // Create new tracked error
    tracked = {
      id: fingerprint,
      message: error.message,
      code: "code" in error ? error.code : "UNKNOWN",
      severity,
      stack: error.stack,
      context: {
        ...context,
        requestId: ctx?.requestId,
        userId: ctx?.userId,
      },
      timestamp: now,
      requestId: ctx?.requestId,
      userId: ctx?.userId,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };

    errorBuffer.set(fingerprint, tracked);

    // Maintain buffer size
    if (errorBuffer.size > ERROR_BUFFER_SIZE) {
      const oldest = Array.from(errorBuffer.entries())
        .sort((a, b) => new Date(a[1].lastSeen).getTime() - new Date(b[1].lastSeen).getTime())[0];
      errorBuffer.delete(oldest[0]);
    }
  }

  // Check if alert threshold is reached
  const threshold = ALERT_THRESHOLDS[severity];
  if (tracked.count === threshold) {
    createAlert(tracked, threshold);
  }

  // Log error
  logger.error("Error tracked", error, {
    fingerprint,
    severity,
    count: tracked.count,
    ...context,
  });
}

// =============================================================================
// Alerting
// =============================================================================

/**
 * Create an alert for an error that has reached threshold
 */
function createAlert(error: TrackedError, threshold: number): void {
  const alert: ErrorAlert = {
    errorId: error.id,
    severity: error.severity,
    message: error.message,
    count: error.count,
    threshold,
    timestamp: new Date().toISOString(),
  };

  recentAlerts.push(alert);
  if (recentAlerts.length > 100) {
    recentAlerts.shift();
  }

  logger.warn("Error alert triggered", {
    errorId: error.id,
    severity: error.severity,
    message: error.message,
    count: error.count,
    threshold,
  });

  // TODO: Send to external alerting system (PagerDuty, Slack, etc.)
  sendAlert(alert);
}

/**
 * Send alert to external system (Slack and/or PagerDuty)
 */
async function sendAlert(alert: ErrorAlert): Promise<void> {
  const promises: Promise<void>[] = [];

  // Send to Slack for all alerts
  promises.push(sendSlackAlert(alert));

  // Send to PagerDuty only for critical errors
  if (alert.severity === "critical") {
    promises.push(sendPagerDutyAlert(alert));
  }

  // Fire and forget - don't block on external alerting
  Promise.allSettled(promises).catch(() => {
    // Ignore failures in alerting
  });
}

/**
 * Send alert to Slack webhook
 */
async function sendSlackAlert(alert: ErrorAlert): Promise<void> {
  const webhookUrl = Deno.env.get("SLACK_ALERT_WEBHOOK_URL") ||
    Deno.env.get("ERROR_ALERT_WEBHOOK_URL");
  if (!webhookUrl) return;

  const severityEmoji: Record<ErrorSeverity, string> = {
    low: "🟡",
    medium: "🟠",
    high: "🔴",
    critical: "🚨",
  };

  const severityColor: Record<ErrorSeverity, string> = {
    low: "#ffcc00",
    medium: "#ff9900",
    high: "#ff0000",
    critical: "#8b0000",
  };

  const environment = Deno.env.get("ENVIRONMENT") || Deno.env.get("DENO_ENV") || "production";

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${severityEmoji[alert.severity]} ${alert.severity.toUpperCase()} Error Alert`,
        attachments: [
          {
            color: severityColor[alert.severity],
            blocks: [
              {
                type: "section",
                fields: [
                  {
                    type: "mrkdwn",
                    text: `*Severity:*\n${alert.severity.toUpperCase()}`,
                  },
                  {
                    type: "mrkdwn",
                    text: `*Environment:*\n${environment}`,
                  },
                  {
                    type: "mrkdwn",
                    text: `*Error Count:*\n${alert.count}`,
                  },
                  {
                    type: "mrkdwn",
                    text: `*Threshold:*\n${alert.threshold}`,
                  },
                ],
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Message:*\n\`\`\`${alert.message.substring(0, 500)}\`\`\``,
                },
              },
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `Error ID: \`${
                      alert.errorId.substring(0, 50)
                    }\` | Time: ${alert.timestamp}`,
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    logger.warn("Failed to send Slack alert", { error: (error as Error).message });
  }
}

/**
 * Send alert to PagerDuty for critical errors
 */
async function sendPagerDutyAlert(alert: ErrorAlert): Promise<void> {
  const routingKey = Deno.env.get("PAGERDUTY_ROUTING_KEY");
  if (!routingKey) return;

  const environment = Deno.env.get("ENVIRONMENT") || Deno.env.get("DENO_ENV") || "production";

  try {
    await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: `foodshare-${alert.errorId.substring(0, 50)}`,
        payload: {
          summary: `[FoodShare ${environment}] ${alert.message.substring(0, 200)}`,
          severity: "critical",
          source: "foodshare-backend",
          timestamp: alert.timestamp,
          component: "edge-functions",
          group: "backend-errors",
          class: alert.severity,
          custom_details: {
            error_id: alert.errorId,
            message: alert.message,
            count: alert.count,
            threshold: alert.threshold,
            environment,
          },
        },
        links: [
          {
            href: `${Deno.env.get("SUPABASE_URL") || "https://api.foodshare.club"}/`,
            text: "View Supabase Dashboard",
          },
        ],
      }),
    });
  } catch (error) {
    logger.warn("Failed to send PagerDuty alert", { error: (error as Error).message });
  }
}

// =============================================================================
// Error Retrieval
// =============================================================================

/**
 * Get all tracked errors
 */
export function getTrackedErrors(options: {
  severity?: ErrorSeverity;
  limit?: number;
  sortBy?: "count" | "lastSeen" | "severity";
} = {}): TrackedError[] {
  const { severity, limit = 50, sortBy = "count" } = options;

  let errors = Array.from(errorBuffer.values());

  // Filter by severity
  if (severity) {
    errors = errors.filter((e) => e.severity === severity);
  }

  // Sort
  errors.sort((a, b) => {
    switch (sortBy) {
      case "count":
        return b.count - a.count;
      case "lastSeen":
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      case "severity": {
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        return severityOrder[b.severity] - severityOrder[a.severity];
      }
      default:
        return 0;
    }
  });

  return errors.slice(0, limit);
}

/**
 * Get recent alerts
 */
export function getRecentAlerts(limit = 20): ErrorAlert[] {
  return recentAlerts.slice(-limit).reverse();
}

/**
 * Get error by fingerprint
 */
export function getError(fingerprint: string): TrackedError | undefined {
  return errorBuffer.get(fingerprint);
}

// =============================================================================
// Error Statistics
// =============================================================================

export interface ErrorStats {
  total: number;
  bySeverity: Record<ErrorSeverity, number>;
  topErrors: Array<{ message: string; count: number; severity: ErrorSeverity }>;
  recentAlerts: number;
}

/**
 * Get error statistics
 */
export function getErrorStats(): ErrorStats {
  const errors = Array.from(errorBuffer.values());

  const bySeverity: Record<ErrorSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const error of errors) {
    bySeverity[error.severity] += error.count;
  }

  const topErrors = errors
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((e) => ({
      message: e.message,
      count: e.count,
      severity: e.severity,
    }));

  return {
    total: errors.reduce((sum, e) => sum + e.count, 0),
    bySeverity,
    topErrors,
    recentAlerts: recentAlerts.length,
  };
}

// =============================================================================
// Error Resolution
// =============================================================================

/**
 * Mark an error as resolved
 */
export function resolveError(fingerprint: string): boolean {
  const deleted = errorBuffer.delete(fingerprint);
  if (deleted) {
    logger.info("Error resolved", { fingerprint });
  }
  return deleted;
}

/**
 * Clear all tracked errors
 */
export function clearErrors(): void {
  errorBuffer.clear();
  recentAlerts.length = 0;
  logger.info("All errors cleared");
}

// =============================================================================
// Error Rate Monitoring
// =============================================================================

const errorRateWindow: Array<{ timestamp: number; severity: ErrorSeverity }> = [];
const ERROR_RATE_WINDOW_MS = 60000; // 1 minute

/**
 * Track error rate
 */
export function trackErrorRate(severity: ErrorSeverity): void {
  const now = Date.now();
  errorRateWindow.push({ timestamp: now, severity });

  // Clean old entries
  const cutoff = now - ERROR_RATE_WINDOW_MS;
  while (errorRateWindow.length > 0 && errorRateWindow[0].timestamp < cutoff) {
    errorRateWindow.shift();
  }

  // Check for high error rate
  const recentErrors = errorRateWindow.filter((e) => e.timestamp > cutoff);
  const criticalErrors = recentErrors.filter((e) => e.severity === "critical").length;

  if (criticalErrors > 10) {
    logger.warn("High critical error rate detected", {
      count: criticalErrors,
      windowMs: ERROR_RATE_WINDOW_MS,
    });
  }
}

/**
 * Get current error rate
 */
export function getErrorRate(): {
  total: number;
  bySeverity: Record<ErrorSeverity, number>;
  windowMs: number;
} {
  const now = Date.now();
  const cutoff = now - ERROR_RATE_WINDOW_MS;
  const recentErrors = errorRateWindow.filter((e) => e.timestamp > cutoff);

  const bySeverity: Record<ErrorSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const error of recentErrors) {
    bySeverity[error.severity]++;
  }

  return {
    total: recentErrors.length,
    bySeverity,
    windowMs: ERROR_RATE_WINDOW_MS,
  };
}
