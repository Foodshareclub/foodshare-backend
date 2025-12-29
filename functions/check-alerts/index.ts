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
 * - Cron: Run every 5 minutes
 * - Manual: POST /check-alerts with optional { force: true } to bypass cooldowns
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Types
interface AlertThresholds {
  errorRatePercent: number;
  p95LatencyMs: number;
  failedLoginMultiplier: number;
  connectionPoolPercent: number;
  vaultFailuresPerHour: number;
}

interface AlertCondition {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  value: number;
  threshold: number;
  details?: Record<string, unknown>;
}

type AlertType =
  | "error_rate_high"
  | "latency_high"
  | "circuit_breaker_open"
  | "login_spike"
  | "vault_failures"
  | "connection_pool_exhaustion"
  | "service_unhealthy";

type AlertSeverity = "critical" | "warning" | "info";

interface AlertResult {
  checked_at: string;
  alerts_triggered: number;
  alerts: AlertCondition[];
  notifications_sent: string[];
}

interface MetricsRow {
  error_rate: number;
  total_requests: number;
  error_count: number;
}

interface LatencyRow {
  p95_latency_ms: number;
}

interface CircuitRow {
  circuit_name: string;
  state: string;
  failure_count: number;
  last_change: string;
}

interface LoginStatsRow {
  current_failures: number;
  baseline_failures: number;
  spike_multiplier: number;
}

interface VaultFailuresRow {
  failure_count: number;
}

interface ConnectionPoolRow {
  total_connections: number;
  active_connections: number;
  utilization_percent: number;
}

// Default thresholds (can be overridden via environment)
const DEFAULT_THRESHOLDS: AlertThresholds = {
  errorRatePercent: 5,
  p95LatencyMs: 2000,
  failedLoginMultiplier: 10,
  connectionPoolPercent: 80,
  vaultFailuresPerHour: 5,
};

// Alert cooldown in minutes (to prevent spam)
const ALERT_COOLDOWN_MINUTES = 15;

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = performance.now();

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check if force mode (bypass cooldowns)
    let forceCheck = false;
    try {
      const body = await req.json();
      forceCheck = body?.force === true;
    } catch {
      // No body or invalid JSON - continue with normal check
    }

    // Load custom thresholds from environment or use defaults
    const thresholds: AlertThresholds = {
      errorRatePercent: parseFloat(
        Deno.env.get("ALERT_ERROR_RATE_PERCENT") ||
          String(DEFAULT_THRESHOLDS.errorRatePercent)
      ),
      p95LatencyMs: parseInt(
        Deno.env.get("ALERT_P95_LATENCY_MS") ||
          String(DEFAULT_THRESHOLDS.p95LatencyMs)
      ),
      failedLoginMultiplier: parseFloat(
        Deno.env.get("ALERT_LOGIN_SPIKE_MULTIPLIER") ||
          String(DEFAULT_THRESHOLDS.failedLoginMultiplier)
      ),
      connectionPoolPercent: parseInt(
        Deno.env.get("ALERT_CONNECTION_POOL_PERCENT") ||
          String(DEFAULT_THRESHOLDS.connectionPoolPercent)
      ),
      vaultFailuresPerHour: parseInt(
        Deno.env.get("ALERT_VAULT_FAILURES_HOUR") ||
          String(DEFAULT_THRESHOLDS.vaultFailuresPerHour)
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

    console.log(`Checked ${6} conditions, found ${alerts.length} alerts`);

    // Send notifications for new alerts
    const notificationsSent: string[] = [];

    if (alerts.length > 0) {
      // Check cooldowns unless force mode
      const alertsToSend = forceCheck
        ? alerts
        : await filterByAlertCooldowns(supabase, alerts);

      if (alertsToSend.length > 0) {
        // Get notification credentials from vault
        const slackWebhook = await getSecretSafe(supabase, "SLACK_WEBHOOK_URL");
        const opsEmail = await getSecretSafe(supabase, "OPS_ALERT_EMAIL");

        // Send Slack notification
        if (slackWebhook) {
          const slackSent = await sendSlackAlert(slackWebhook, alertsToSend);
          if (slackSent) notificationsSent.push("slack");
        }

        // Send email notification for critical alerts
        const criticalAlerts = alertsToSend.filter(
          (a) => a.severity === "critical"
        );
        if (criticalAlerts.length > 0 && opsEmail) {
          const emailSent = await sendEmailAlert(
            supabase,
            opsEmail,
            criticalAlerts
          );
          if (emailSent) notificationsSent.push("email");
        }

        // Log alerts to database
        await logAlerts(supabase, alertsToSend);
      }
    }

    const result: AlertResult = {
      checked_at: new Date().toISOString(),
      alerts_triggered: alerts.length,
      alerts,
      notifications_sent: notificationsSent,
    };

    console.log(
      `Alert check completed in ${Math.round(performance.now() - startTime)}ms`
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in check-alerts:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// =============================================================================
// ALERT CHECKS
// =============================================================================

async function checkErrorRate(
  supabase: ReturnType<typeof createClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_error_rate", {
      p_minutes: 5,
    });

    if (error || !data) {
      console.error("Error checking error rate:", error);
      return null;
    }

    const metrics = (Array.isArray(data) ? data[0] : data) as MetricsRow | undefined;
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
    console.error("Error in checkErrorRate:", error);
    return null;
  }
}

async function checkLatency(
  supabase: ReturnType<typeof createClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_p95_latency", {
      p_minutes: 5,
    });

    if (error) {
      console.error("Error checking latency:", error);
      return null;
    }

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
    console.error("Error in checkLatency:", error);
    return null;
  }
}

async function checkCircuitBreakers(
  supabase: ReturnType<typeof createClient>
): Promise<AlertCondition[]> {
  try {
    const { data, error } = await supabase
      .from("metrics.circuit_status")
      .select("*")
      .eq("state", "open");

    if (error || !data) {
      console.error("Error checking circuit breakers:", error);
      return [];
    }

    return (data as CircuitRow[]).map((circuit) => ({
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
    console.error("Error in checkCircuitBreakers:", error);
    return [];
  }
}

async function checkLoginSpike(
  supabase: ReturnType<typeof createClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_login_spike_stats", {
      p_current_window_minutes: 30,
      p_baseline_window_hours: 24,
    });

    if (error || !data) {
      console.error("Error checking login spike:", error);
      return null;
    }

    const stats = (Array.isArray(data) ? data[0] : data) as LoginStatsRow | undefined;
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
    console.error("Error in checkLoginSpike:", error);
    return null;
  }
}

async function checkVaultFailures(
  supabase: ReturnType<typeof createClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_vault_failure_count", {
      p_hours: 1,
    });

    if (error) {
      console.error("Error checking vault failures:", error);
      return null;
    }

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
    console.error("Error in checkVaultFailures:", error);
    return null;
  }
}

async function checkConnectionPool(
  supabase: ReturnType<typeof createClient>,
  thresholds: AlertThresholds
): Promise<AlertCondition | null> {
  try {
    const { data, error } = await supabase.rpc("get_connection_pool_stats");

    if (error || !data) {
      console.error("Error checking connection pool:", error);
      return null;
    }

    const stats = (Array.isArray(data) ? data[0] : data) as ConnectionPoolRow | undefined;
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
    console.error("Error in checkConnectionPool:", error);
    return null;
  }
}

// =============================================================================
// NOTIFICATION FUNCTIONS
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
      {
        type: "divider",
      },
      ...alerts.map((alert) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${alert.severity.toUpperCase()}* - ${alert.type}\n${alert.message}\n_Value: ${alert.value} (threshold: ${alert.threshold})_`,
        },
      })),
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Timestamp: ${new Date().toISOString()}`,
          },
        ],
      },
    ];

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachments: [
          {
            color,
            blocks,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Failed to send Slack alert:", await response.text());
      return false;
    }

    console.log("✅ Slack alert sent successfully");
    return true;
  } catch (error) {
    console.error("Error sending Slack alert:", error);
    return false;
  }
}

async function sendEmailAlert(
  supabase: ReturnType<typeof createClient>,
  opsEmail: string,
  alerts: AlertCondition[]
): Promise<boolean> {
  try {
    // Use the resend function to send the email
    const { error } = await supabase.functions.invoke("resend-alert", {
      body: {
        to: opsEmail,
        subject: `[CRITICAL] Foodshare: ${alerts.length} critical alert(s)`,
        alerts,
      },
    });

    if (error) {
      console.error("Failed to send email alert:", error);
      return false;
    }

    console.log("✅ Email alert sent successfully");
    return true;
  } catch (error) {
    console.error("Error sending email alert:", error);
    return false;
  }
}

async function logAlerts(
  supabase: ReturnType<typeof createClient>,
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
      console.error("Failed to log alerts:", error);
    } else {
      console.log(`✅ Logged ${alerts.length} alerts to database`);
    }
  } catch (error) {
    console.error("Error logging alerts:", error);
  }
}

async function filterByAlertCooldowns(
  supabase: ReturnType<typeof createClient>,
  alerts: AlertCondition[]
): Promise<AlertCondition[]> {
  try {
    const cooldownTime = new Date(
      Date.now() - ALERT_COOLDOWN_MINUTES * 60 * 1000
    ).toISOString();

    // Get recent alerts of the same types
    const alertTypes = [...new Set(alerts.map((a) => a.type))];

    const { data: recentAlerts, error } = await supabase
      .from("metrics.alerts")
      .select("alert_type")
      .in("alert_type", alertTypes)
      .gte("created_at", cooldownTime);

    if (error) {
      console.error("Error checking alert cooldowns:", error);
      return alerts; // If we can't check, send all
    }

    const recentTypes = new Set(
      (recentAlerts || []).map((a: { alert_type: string }) => a.alert_type)
    );

    return alerts.filter((alert) => !recentTypes.has(alert.type));
  } catch (error) {
    console.error("Error in filterByAlertCooldowns:", error);
    return alerts;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function getSecretSafe(
  supabase: ReturnType<typeof createClient>,
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

    if (error || !data) {
      console.log(`Secret ${secretName} not configured`);
      return null;
    }

    return data as string;
  } catch {
    return null;
  }
}
