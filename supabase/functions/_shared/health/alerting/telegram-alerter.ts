/**
 * Health Module - Telegram Alerter
 *
 * Sends health alerts to Telegram with formatted messages.
 */

import { logger } from "../../logger.ts";
import { HealthCheckSummary, FunctionHealthResult } from "../types.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface TelegramConfig {
  /** Telegram Bot API token */
  botToken: string;
  /** Chat ID to send alerts to */
  chatId: string;
}

// =============================================================================
// Telegram Alerter
// =============================================================================

export class TelegramAlerter {
  private readonly botToken: string;
  private readonly chatId: string;

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
  }

  /**
   * Send an alert message to Telegram
   * @param message - HTML formatted message
   * @param silent - Whether to send silently (no notification sound)
   */
  async sendAlert(message: string, silent = false): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: "HTML",
          disable_notification: silent,
          disable_web_page_preview: true,
        }),
      });

      const result = await response.json();
      if (!result.ok) {
        logger.error("Telegram API error", { error: result });
        return false;
      }
      return true;
    } catch (error) {
      logger.error("Failed to send Telegram alert", error instanceof Error ? error : { error });
      return false;
    }
  }

  /**
   * Format a health alert message
   * @param summary - Health check summary
   * @param unhealthyFunctions - List of unhealthy functions
   * @param isRecovery - Whether this is a recovery notification
   */
  formatAlertMessage(
    summary: HealthCheckSummary,
    unhealthyFunctions: FunctionHealthResult[],
    isRecovery: boolean
  ): string {
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (isRecovery) {
      return `
<b>All Systems Operational</b>

<b>Status:</b> ${summary.status.toUpperCase()}
<b>Time:</b> ${timestamp}

All ${summary.functions.total} edge functions are healthy.

<i>Previous issues have been resolved.</i>
`.trim();
    }

    const criticalCount = unhealthyFunctions.filter((f) => f.critical).length;
    const nonCriticalCount = unhealthyFunctions.length - criticalCount;

    let severity = "Warning";
    let emoji = "";

    if (criticalCount >= 3) {
      severity = "CRITICAL OUTAGE";
      emoji = "";
    } else if (criticalCount > 0) {
      severity = "Critical Alert";
      emoji = "";
    } else if (nonCriticalCount >= 5) {
      severity = "Multiple Failures";
      emoji = "";
    }

    let message = `
<b>${emoji} ${severity}: Edge Functions Unhealthy</b>

<b>Summary:</b>
  Healthy: ${summary.functions.healthy}/${summary.functions.total}
  Unhealthy: ${summary.functions.unhealthy}
  Timeouts: ${summary.functions.timeout}
  Degraded: ${summary.functions.degraded}

<b>Critical Functions Down:</b>
`;

    const criticalFunctions = unhealthyFunctions.filter((f) => f.critical);
    if (criticalFunctions.length > 0) {
      for (const fn of criticalFunctions.slice(0, 5)) {
        const errorMsg = fn.error ? ` - ${fn.error.slice(0, 50)}` : "";
        const statusIcon = fn.status === "timeout" ? "" : "";
        message += `  ${statusIcon} <code>${fn.name}</code>${errorMsg}\n`;
      }
      if (criticalFunctions.length > 5) {
        message += `  <i>...and ${criticalFunctions.length - 5} more</i>\n`;
      }
    } else {
      message += "  <i>None</i>\n";
    }

    message += `\n<b>Other Failures:</b>\n`;
    const otherFunctions = unhealthyFunctions.filter((f) => !f.critical);
    if (otherFunctions.length > 0) {
      for (const fn of otherFunctions.slice(0, 5)) {
        const statusIcon = fn.status === "timeout" ? "" : "";
        message += `  ${statusIcon} <code>${fn.name}</code>\n`;
      }
      if (otherFunctions.length > 5) {
        message += `  <i>...and ${otherFunctions.length - 5} more</i>\n`;
      }
    } else {
      message += "  <i>None</i>\n";
    }

    // Add cold start info if any recovered
    const coldStartRecoveries = unhealthyFunctions.filter((f) => f.recoveredFromColdStart);
    if (coldStartRecoveries.length > 0) {
      message += `\n<i>${coldStartRecoveries.length} function(s) recovered after cold start retry</i>\n`;
    }

    message += `\n<b>Time:</b> ${timestamp}`;
    message += `\n<b>Dashboard:</b> <a href="https://studio.foodshare.club">Supabase Studio</a>`;

    return message.trim();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

let alerterInstance: TelegramAlerter | null = null;

/**
 * Create or get the Telegram alerter instance
 * Returns null if Telegram credentials are not configured
 */
export function createTelegramAlerter(config?: Partial<TelegramConfig>): TelegramAlerter | null {
  if (!alerterInstance) {
    const botToken = config?.botToken ?? Deno.env.get("BOT_TOKEN");
    const chatId = config?.chatId ?? Deno.env.get("ADMIN_CHAT_ID");

    if (!botToken || !chatId) {
      logger.warn("Telegram credentials not configured, alerting disabled");
      return null;
    }

    alerterInstance = new TelegramAlerter({ botToken, chatId });
  }

  return alerterInstance;
}

/**
 * Reset the Telegram alerter instance (for testing)
 */
export function resetTelegramAlerter(): void {
  alerterInstance = null;
}
