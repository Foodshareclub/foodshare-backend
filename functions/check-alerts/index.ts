/**
 * Check Alerts Edge Function
 *
 * Monitors system health and triggers alerts when thresholds are breached.
 * Designed to run via cron trigger every 5 minutes.
 *
 * Monitored Conditions:
 * - Error rate > 5% in 5 minutes
 * - P95 latency > 2 seconds
 * - Circuit breaker opens
 * - Failed login spike (>10x normal)
 * - Vault access failures
 * - Database connection pool exhaustion (>80% utilization)
 *
 * Notification Channels:
 * - Slack webhook
 * - Email to ops team
 * - Database alert log
 *
 * Usage:
 * POST /check-alerts { "force": true } // Bypass cooldowns
 * GET /check-alerts
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  alertCooldownMinutes: 15,
  defaultThresholds: {
    errorRatePercent: 5,
    p95LatencyMs: 2000,
    failedLoginMultiplier: 10,
    connectionPoolPercent: 80,
    vaultFailuresPerHour: 5,
  },
};

// =============================================================================
// Types
// =============================================================================

type AlertType =
  | "error_rate_high"
  | "latency_high"
  | "circuit_breaker_open"
  | "login_spike"
  | "vault_failures"
  | "connection_pool_exhaustion"
  | "service_unhealthy";

type AlertSeverity = "critical" | "warning" | "info";

interface AlertCondition {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  details?: Record<string, unknown>;
}

interface AlertResult {
  checked_at: string;
  alerts_triggered: number;
  alerts: AlertCondition[];
  notifications_sent: string[];
}

interface AlertThresholds {
  errorRatePercent: number;
  p95LatencyMs: number;
  failedLoginMultiplier: number;
  connectionPoolPercent: number;
  vaultFailuresPerHour: number;
}

// =============================================================================
// Request Schema
// =============================================================================

const checkAlertsSchema = z.object({
  force: z.boolean().optional(),
}).optional();

type CheckAlertsRequest = z.infer<typeof checkAlertsSchema>;

// =============================================================================
// Alert Check Functions
// =============================================================================

async function checkErrorRate(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_error_rate", { p_minutes: 5 });
    if (error || !data) return null;

    const metrics = Array.isArray(data) ? data[0] : data;
    if (!metrics) return null;

    const errorRate = parseFloat(String(metrics.error_rate || 0));

    if (errorRate > thresholds.errorRatePercent) {
      return {
        type: "error_rate_high",
        severity: errorRate > thresholds.errorRatePercent * 2 ? "critical" : "warning",
        message: `Error rate ${errorRate.toFixed(1)}% exceeds threshold ${thresholds.errorRatePercent}%`,
        value: errorRate,
        threshold: thresholds.errorRatePercent,
        details: {
          total_requests: metrics.total_requests,
          error_count: metrics.error_count,
          window_minutes: 5,
        },
      };
    }
    return null;
  } catch (error) {
    logger.error("Error checking error rate", { error });
    return null;
  }
}

async function checkLatency(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_p95_latency", { p_minutes: 5 });
    if (error) return null;

    const p95 = typeof data === "number" ? data : 0;

    if (p95 > thresholds.p95LatencyMs) {
      return {
        type: "latency_high",
        severity: p95 > thresholds.p95LatencyMs * 2 ? "critical" : "warning",
        message: `P95 latency ${p95}ms exceeds threshold ${thresholds.p95LatencyMs}ms`,
        value: p95,
        threshold: thresholds.p95LatencyMs,
        details: { window_minutes: 5 },
      };
    }
    return null;
  } catch (error) {
    logger.error("Error checking latency", { error });
    return null;
  }
}

async function checkCircuitBreakers(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>
): Promise<AlertCondition[]> {
  try {
    const { data, error } = await supabase
      .from("metrics.circuit_status")
      .select("*")
      .eq("state", "open");

    if (error || !data) return [];

    return data.map((circuit) => ({
      type: "circuit_breaker_open" as AlertType,
      severity: "critical" as AlertSeverity,
      message: `Circuit breaker '${circuit.circuit_name}' is OPEN`,
      value: circuit.failure_count,
      threshold: 0,
      details: {
        circuit_name: circuit.circuit_name,
        failure_count: circuit.failure_count,
        last_change: circuit.last_change,
      },
    }));
  } catch (error) {
    logger.error("Error checking circuit breakers", { error });
    return [];
  }
}

async function checkLoginSpike(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_login_spike_stats", {
      p_current_window_minutes: 30,
      p_baseline_window_hours: 24,
    });

    if (error || !data) return null;

    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) return null;

    const multiplier = stats.spike_multiplier || 0;

    if (multiplier > thresholds.failedLoginMultiplier) {
      return {
        type: "login_spike",
        severity: "critical",
        message: `Failed login spike: ${multiplier.toFixed(1)}x normal rate`,
        value: multiplier,
        threshold: thresholds.failedLoginMultiplier,
        details: {
          current_failures: stats.current_failures,
          baseline_failures: stats.baseline_failures,
          window_minutes: 30,
        },
      };
    }
    return null;
  } catch (error) {
    logger.error("Error checking login spike", { error });
    return null;
  }
}

async function checkVaultFailures(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_vault_failure_count", { p_hours: 1 });
    if (error) return null;

    const failures = typeof data === "number" ? data : 0;

    if (failures > thresholds.vaultFailuresPerHour) {
      return {
        type: "vault_failures",
        severity: "critical",
        message: `${failures} vault access failures in last hour`,
        value: failures,
        threshold: thresholds.vaultFailuresPerHour,
        details: { window_hours: 1 },
      };
    }
    return null;
  } catch (error) {
    logger.error("Error checking vault failures", { error });
    return null;
  }
}

async function checkConnectionPool(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_connection_pool_stats");
    if (error || !data) return null;

    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) return null;

    const utilization = stats.utilization_percent || 0;

    if (utilization > thresholds.connectionPoolPercent) {
      return {
        type: "connection_pool_exhaustion",
        severity: utilization > 90 ? "critical" : "warning",
        message: `Connection pool at ${utilization.toFixed(0)}% utilization`,
        value: utilization,
        threshold: thresholds.connectionPoolPercent,
        details: {
          total_connections: stats.total_connections,
          active_connections: stats.active_connections,
        },
      };
    }
    return null;
  } catch (error) {
    logger.error("Error checking connection pool", { error });
    return null;
  }
}

// =============================================================================
// Notification Functions
// =============================================================================

async function sendSlackAlert(
  webhookUrl: string,
  alerts: AlertCondition[]
): Promise<boolean> {
  try {
    const criticalCount = alerts.filter((a) => a.severity === "critical").length;
    const warningCount = alerts.filter((a) => a.severity === "warning").length;

    const color = criticalCount > 0 ? "#dc3545" : "#ffc107";
    const emoji = criticalCount > 0 ? ":rotating_light:" : ":warning:";

    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} Foodshare Alert: ${criticalCount} critical, ${warningCount} warning`,
          emoji: true,
        },
      },
      { type: "divider" },
      ...alerts.map((alert) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${alert.severity.toUpperCase()}* - ${alert.type}\n${alert.message}\n_Value: ${alert.value} (threshold: ${alert.threshold})_`,
        },
      })),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Timestamp: ${new Date().toISOString()}` }],
      },
    ];

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachments: [{ color, blocks }] }),
    });

    if (!response.ok) {
      logger.error("Failed to send Slack alert", { status: response.status });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Error sending Slack alert", { error });
    return false;
  }
}

async function logAlerts(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  alerts: AlertCondition[]
): Promise<void> {
  try {
    const records = alerts.map((alert) => ({
      alert_type: alert.type,
      severity: alert.severity,
      message: alert.message,
      value: alert.value,
      threshold: alert.threshold,
      details: alert.details || {},
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from("metrics.alerts").insert(records);
    if (error) {
      logger.error("Failed to log alerts", { error: error.message });
    }
  } catch (error) {
    logger.error("Error logging alerts", { error });
  }
}

async function filterByAlertCooldowns(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  alerts: AlertCondition[]
): Promise<AlertCondition[]> {
  try {
    const cooldownTime = new Date(
      Date.now() - CONFIG.alertCooldownMinutes * 60 * 1000
    ).toISOString();

    const alertTypes = [...new Set(alerts.map((a) => a.type))];

    const { data: recentAlerts, error } = await supabase
      .from("metrics.alerts")
      .select("alert_type")
      .in("alert_type", alertTypes)
      .gte("created_at", cooldownTime);

    if (error) return alerts;

    const recentTypes = new Set((recentAlerts || []).map((a) => a.alert_type));
    return alerts.filter((alert) => !recentTypes.has(alert.type));
  } catch {
    return alerts;
  }
}

async function getSecretSafe(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  secretName: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("get_secret_audited", {
      secret_name: secretName,
      requesting_user_id: "system",
      request_metadata: {
        source: "check-alerts",
        timestamp: new Date().toISOString(),
      },
    });

    if (error || !data) return null;
    return data as string;
  } catch {
    return null;
  }
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleCheckAlerts(
  ctx: HandlerContext<CheckAlertsRequest>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const startTime = performance.now();
  const forceCheck = body?.force === true;

  logger.info("Checking alerts", {
    force: forceCheck,
    requestId: requestCtx?.requestId,
  });

  // Load thresholds from environment or use defaults
  const thresholds: AlertThresholds = {
    errorRatePercent: parseFloat(
      Deno.env.get("ALERT_ERROR_RATE_PERCENT") || String(CONFIG.defaultThresholds.errorRatePercent)
    ),
    p95LatencyMs: parseInt(
      Deno.env.get("ALERT_P95_LATENCY_MS") || String(CONFIG.defaultThresholds.p95LatencyMs)
    ),
    failedLoginMultiplier: parseFloat(
      Deno.env.get("ALERT_LOGIN_SPIKE_MULTIPLIER") || String(CONFIG.defaultThresholds.failedLoginMultiplier)
    ),
    connectionPoolPercent: parseInt(
      Deno.env.get("ALERT_CONNECTION_POOL_PERCENT") || String(CONFIG.defaultThresholds.connectionPoolPercent)
    ),
    vaultFailuresPerHour: parseInt(
      Deno.env.get("ALERT_VAULT_FAILURES_HOUR") || String(CONFIG.defaultThresholds.vaultFailuresPerHour)
    ),
  };

  // Run all checks in parallel
  const [
    errorRateAlert,
    latencyAlert,
    circuitBreakerAlerts,
    loginSpikeAlert,
    vaultFailuresAlert,
    connectionPoolAlert,
  ] = await Promise.all([
    checkErrorRate(supabase, thresholds),
    checkLatency(supabase, thresholds),
    checkCircuitBreakers(supabase),
    checkLoginSpike(supabase, thresholds),
    checkVaultFailures(supabase, thresholds),
    checkConnectionPool(supabase, thresholds),
  ]);

  // Collect all triggered alerts
  const alerts: AlertCondition[] = [
    errorRateAlert,
    latencyAlert,
    ...circuitBreakerAlerts,
    loginSpikeAlert,
    vaultFailuresAlert,
    connectionPoolAlert,
  ].filter((a): a is AlertCondition => a !== null);

  logger.info("Alert check complete", {
    total: 6,
    triggered: alerts.length,
  });

  // Send notifications
  const notificationsSent: string[] = [];

  if (alerts.length > 0) {
    const alertsToSend = forceCheck
      ? alerts
      : await filterByAlertCooldowns(supabase, alerts);

    if (alertsToSend.length > 0) {
      const slackWebhook = await getSecretSafe(supabase, "SLACK_WEBHOOK_URL");

      if (slackWebhook) {
        const slackSent = await sendSlackAlert(slackWebhook, alertsToSend);
        if (slackSent) notificationsSent.push("slack");
      }

      await logAlerts(supabase, alertsToSend);
    }
  }

  const result: AlertResult = {
    checked_at: new Date().toISOString(),
    alerts_triggered: alerts.length,
    alerts,
    notifications_sent: notificationsSent,
  };

  logger.info("Alert check completed", {
    durationMs: Math.round(performance.now() - startTime),
    alertsTriggered: alerts.length,
  });

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "check-alerts",
  version: CONFIG.version,
  requireAuth: false, // Cron job - service-level
  routes: {
    POST: {
      schema: checkAlertsSchema,
      handler: handleCheckAlerts,
    },
    GET: {
      handler: handleCheckAlerts, // Support GET for cron
    },
  },
});
