/**
 * MailerSend Email Provider
 *
 * High-volume transactional email provider
 * Best for: bulk notifications, newsletters, marketing emails
 * Free tier: 12,000 emails/month, ~400 emails/day
 *
 * API Docs: https://developers.mailersend.com/api/v1/email.html
 */

import {
  EmailProvider,
  EmailProviderName,
  SendEmailParams,
  SendEmailResult,
  ProviderHealth,
  ProviderQuota,
  PROVIDER_LIMITS,
} from "./types.ts";

const MAILERSEND_API_BASE = "https://api.mailersend.com/v1";
const REQUEST_TIMEOUT_MS = 10000;

interface MailerSendConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

interface MailerSendEmailResponse {
  message?: string;
  errors?: Record<string, string[]>;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * MailerSend Email Provider Implementation
 */
export class MailerSendProvider implements EmailProvider {
  readonly name: EmailProviderName = "mailersend";
  private config: MailerSendConfig;

  constructor(config: Partial<MailerSendConfig> = {}) {
    this.config = {
      apiKey: config.apiKey || Deno.env.get("MAILERSEND_API_KEY") || "",
      fromEmail: config.fromEmail || Deno.env.get("MAILERSEND_SENDER_EMAIL") || "contact@foodshare.club",
      fromName: config.fromName || Deno.env.get("MAILERSEND_SENDER_NAME") || "FoodShare",
    };
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  /**
   * Send email via MailerSend API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        success: false,
        provider: this.name,
        error: "MailerSend API key not configured",
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const fromEmail = params.from || this.config.fromEmail;
      const fromName = params.fromName || this.config.fromName;
      const toAddresses = Array.isArray(params.to) ? params.to : [params.to];

      const payload = {
        from: {
          email: fromEmail,
          name: fromName,
        },
        to: toAddresses.map((email) => ({ email })),
        subject: params.subject,
        html: params.html,
        ...(params.text && { text: params.text }),
        ...(params.replyTo && {
          reply_to: {
            email: params.replyTo,
          },
        }),
        ...(params.tags && {
          tags: params.tags,
        }),
      };

      const response = await fetchWithTimeout(`${MAILERSEND_API_BASE}/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const latencyMs = Math.round(performance.now() - startTime);

      // MailerSend returns 202 on success
      if (response.status === 202) {
        const messageId = response.headers.get("x-message-id") || undefined;
        return {
          success: true,
          provider: this.name,
          messageId,
          latencyMs,
          timestamp: Date.now(),
        };
      }

      // Handle errors
      const data: MailerSendEmailResponse = await response.json();
      const errorMessage = data.message || data.errors
        ? Object.entries(data.errors || {})
            .map(([field, errors]) => `${field}: ${errors.join(", ")}`)
            .join("; ")
        : `HTTP ${response.status}`;

      return {
        success: false,
        provider: this.name,
        error: errorMessage,
        latencyMs,
        timestamp: Date.now(),
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const message =
        error instanceof Error
          ? error.name === "AbortError"
            ? "Request timeout"
            : error.message
          : "Unknown error";

      return {
        success: false,
        provider: this.name,
        error: message,
        latencyMs,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Check provider health by verifying API token
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "MAILERSEND_API_KEY not configured",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      // Use the token verification endpoint
      const response = await fetchWithTimeout(`${MAILERSEND_API_BASE}/token`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });

      const latencyMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          provider: this.name,
          status: "error",
          healthScore: 0,
          latencyMs,
          message: `API error: HTTP ${response.status} - ${errorText.slice(0, 100)}`,
          configured: true,
          lastChecked: Date.now(),
        };
      }

      const data = await response.json();

      // Calculate health score based on latency
      let healthScore = 100;
      if (latencyMs > 2000) healthScore -= 30;
      else if (latencyMs > 1000) healthScore -= 15;
      else if (latencyMs > 500) healthScore -= 5;

      return {
        provider: this.name,
        status: healthScore >= 70 ? "ok" : "degraded",
        healthScore,
        latencyMs,
        message: `Connected. Token: ${data.name || "active"}`,
        configured: true,
        lastChecked: Date.now(),
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const message =
        error instanceof Error
          ? error.name === "AbortError"
            ? "Request timeout (10s)"
            : error.message
          : "Unknown error";

      return {
        provider: this.name,
        status: "error",
        healthScore: 0,
        latencyMs,
        message,
        configured: true,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Get quota information
   * MailerSend free tier: 12,000/month, ~400/day
   */
  async getQuota(): Promise<ProviderQuota> {
    const limits = PROVIDER_LIMITS.mailersend;

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
        monthly: { sent: 0, limit: limits.monthly, remaining: limits.monthly, percentUsed: 0 },
      };
    }

    // MailerSend doesn't provide usage data via API on free tier
    // Actual usage is tracked in the database
    return {
      provider: this.name,
      daily: {
        sent: 0, // Tracked in email_provider_quota table
        limit: limits.daily,
        remaining: limits.daily,
        percentUsed: 0,
      },
      monthly: {
        sent: 0, // Tracked in email_provider_monthly_quota table
        limit: limits.monthly,
        remaining: limits.monthly,
        percentUsed: 0,
      },
    };
  }

  /**
   * Get debug info (masked credentials)
   */
  getDebugInfo(): Record<string, unknown> {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.slice(0, 8) + "..." : "not set",
      fromEmail: this.config.fromEmail,
      fromName: this.config.fromName,
      apiBase: MAILERSEND_API_BASE,
    };
  }
}

/**
 * Create MailerSend provider from environment
 */
export function createMailerSendProvider(): MailerSendProvider {
  return new MailerSendProvider();
}
