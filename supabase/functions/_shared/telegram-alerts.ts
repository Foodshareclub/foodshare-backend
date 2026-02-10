/**
 * Telegram Alerting Service
 *
 * Sends critical alerts to Telegram for revenue-impacting events,
 * circuit breaker state changes, and system health issues.
 */

import { logger } from "./logger.ts";

const TELEGRAM_ALERT_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_ALERT_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID");

export type AlertSeverity = "low" | "medium" | "high" | "critical";

interface AlertOptions {
  /** Throttle key to prevent duplicate alerts */
  throttleKey?: string;
  /** Throttle duration in ms (default: 5 minutes) */
  throttleDurationMs?: number;
  /** Additional context tags */
  tags?: Record<string, string>;
}

// Alert throttling to prevent spam
const alertThrottle = new Map<string, number>();
const DEFAULT_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  low: "ℹ️",
  medium: "⚠️",
  high: "🔴",
  critical: "🚨",
};

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  low: "Info",
  medium: "Warning",
  high: "Alert",
  critical: "CRITICAL",
};

/**
 * Check if an alert should be throttled
 */
function shouldThrottle(key: string, durationMs: number): boolean {
  const now = Date.now();
  const lastAlert = alertThrottle.get(key);

  if (lastAlert && now - lastAlert < durationMs) {
    return true;
  }

  alertThrottle.set(key, now);
  return false;
}

/**
 * Clean up old throttle entries
 */
function cleanupThrottle(): void {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour

  for (const [key, timestamp] of alertThrottle.entries()) {
    if (now - timestamp > maxAge) {
      alertThrottle.delete(key);
    }
  }
}

/**
 * Format alert message for Telegram
 */
function formatAlertMessage(
  severity: AlertSeverity,
  title: string,
  details: Record<string, unknown>,
  tags?: Record<string, string>,
): string {
  const emoji = SEVERITY_EMOJI[severity];
  const prefix = SEVERITY_PREFIX[severity];

  let message = `${emoji} <b>${prefix}: ${escapeHtml(title)}</b>\n\n`;

  // Add details
  for (const [key, value] of Object.entries(details)) {
    const formattedValue = typeof value === "object" ? JSON.stringify(value) : String(value);
    message += `<b>${escapeHtml(key)}:</b> ${escapeHtml(formattedValue)}\n`;
  }

  // Add tags
  if (tags && Object.keys(tags).length > 0) {
    message += "\n<b>Tags:</b> ";
    message += Object.entries(tags)
      .map(([k, v]) => `#${k}_${v}`)
      .join(" ");
    message += "\n";
  }

  message += `\n<i>Time: ${new Date().toISOString()}</i>`;

  return message;
}

/**
 * Escape HTML for Telegram
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send alert to Telegram
 */
export async function sendTelegramAlert(
  severity: AlertSeverity,
  title: string,
  details: Record<string, unknown>,
  options: AlertOptions = {},
): Promise<boolean> {
  // Check configuration
  if (!TELEGRAM_ALERT_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) {
    logger.warn("Telegram alerts not configured", { severity, title });
    return false;
  }

  // Check throttling
  const throttleKey = options.throttleKey || `${severity}:${title}`;
  const throttleDuration = options.throttleDurationMs || DEFAULT_THROTTLE_MS;

  if (shouldThrottle(throttleKey, throttleDuration)) {
    logger.debug("Alert throttled", { throttleKey, title });
    return false;
  }

  // Periodic cleanup
  if (alertThrottle.size > 100) {
    cleanupThrottle();
  }

  try {
    const message = formatAlertMessage(severity, title, details, options.tags);

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_ALERT_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_notification: severity === "low",
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error("Failed to send Telegram alert", new Error(error));
      return false;
    }

    logger.info("Telegram alert sent", { severity, title });
    return true;
  } catch (error) {
    logger.error(
      "Failed to send Telegram alert",
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  }
}

/**
 * Send subscription-specific alert
 */
export async function sendSubscriptionAlert(
  eventType: string,
  details: {
    platform: string;
    productId?: string;
    userId?: string;
    originalTransactionId?: string;
    status?: string;
  },
): Promise<boolean> {
  const severity: AlertSeverity =
    eventType === "billing_issue" || eventType === "grace_period_expired"
      ? "high"
      : eventType === "refunded" || eventType === "revoked"
      ? "medium"
      : "low";

  return sendTelegramAlert(
    severity,
    `Subscription Event: ${eventType}`,
    {
      Platform: details.platform,
      ProductId: details.productId || "N/A",
      UserId: details.userId || "N/A",
      TransactionId: details.originalTransactionId || "N/A",
      Status: details.status || "N/A",
    },
    {
      throttleKey: `subscription:${eventType}:${details.originalTransactionId}`,
      tags: { platform: details.platform, event: eventType },
    },
  );
}

/**
 * Send circuit breaker alert
 */
export async function sendCircuitBreakerAlert(
  serviceName: string,
  state: "OPEN" | "HALF_OPEN" | "CLOSED",
  failures: number,
): Promise<boolean> {
  if (state === "CLOSED") {
    return sendTelegramAlert(
      "low",
      "Circuit Breaker Recovered",
      {
        Service: serviceName,
        State: state,
        Message: "Service is back to normal",
      },
      { throttleKey: `circuit:${serviceName}:recovered` },
    );
  }

  return sendTelegramAlert(
    state === "OPEN" ? "critical" : "high",
    `Circuit Breaker ${state}`,
    {
      Service: serviceName,
      State: state,
      Failures: failures,
      Action: state === "OPEN" ? "All requests blocked" : "Testing recovery",
    },
    { throttleKey: `circuit:${serviceName}:${state}` },
  );
}

/**
 * Send DLQ threshold alert
 */
export async function sendDLQAlert(
  pendingCount: number,
  platformBreakdown: Record<string, number>,
): Promise<boolean> {
  const severity: AlertSeverity = pendingCount > 100
    ? "critical"
    : pendingCount > 50
    ? "high"
    : "medium";

  return sendTelegramAlert(
    severity,
    "DLQ Threshold Exceeded",
    {
      "Pending Events": pendingCount,
      "By Platform": platformBreakdown,
      Action: "Events failing to process, requires investigation",
    },
    {
      throttleKey: "dlq:threshold",
      throttleDurationMs: 15 * 60 * 1000, // 15 minutes
    },
  );
}

/**
 * Send error rate alert
 */
export async function sendErrorRateAlert(
  errorRate: number,
  totalRequests: number,
  errors: number,
): Promise<boolean> {
  return sendTelegramAlert(
    errorRate > 20 ? "critical" : "high",
    "High Error Rate Detected",
    {
      "Error Rate": `${errorRate.toFixed(2)}%`,
      "Total Requests": totalRequests,
      Errors: errors,
      Period: "Last 100 requests",
    },
    {
      throttleKey: "error-rate:high",
      throttleDurationMs: 10 * 60 * 1000, // 10 minutes
    },
  );
}
