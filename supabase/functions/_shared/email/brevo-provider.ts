/**
 * Brevo (formerly Sendinblue) Email Provider
 *
 * High-volume transactional and marketing email provider
 * Best for: newsletters, bulk emails, marketing campaigns
 *
 * API Docs: https://developers.brevo.com/reference
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

const BREVO_API_BASE = "https://api.brevo.com/v3";
const REQUEST_TIMEOUT_MS = 10000;

interface BrevoConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

interface BrevoEmailResponse {
  messageId?: string;
  message?: string;
  code?: string;
}

interface BrevoAccountResponse {
  email: string;
  companyName: string;
  plan: Array<{
    type: string;
    credits: number;
    creditsType: string;
  }>;
  relay?: {
    enabled: boolean;
    data?: { userName: string };
  };
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
 * Brevo Email Provider Implementation
 */
export class BrevoProvider implements EmailProvider {
  readonly name: EmailProviderName = "brevo";
  private config: BrevoConfig;

  constructor(config: Partial<BrevoConfig> = {}) {
    this.config = {
      apiKey: config.apiKey || Deno.env.get("BREVO_API_KEY") || "",
      fromEmail: config.fromEmail || Deno.env.get("EMAIL_FROM") || "contact@foodshare.club",
      fromName: config.fromName || Deno.env.get("EMAIL_FROM_NAME") || "FoodShare",
    };
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  /**
   * Send email via Brevo SMTP API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        success: false,
        provider: this.name,
        error: "Brevo API key not configured",
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const fromEmail = params.from || this.config.fromEmail;
      const fromName = params.fromName || this.config.fromName;
      const toAddresses = Array.isArray(params.to) ? params.to : [params.to];

      const payload = {
        sender: {
          email: fromEmail,
          name: fromName,
        },
        to: toAddresses.map((email) => ({ email })),
        subject: params.subject,
        htmlContent: params.html,
        ...(params.text && { textContent: params.text }),
        ...(params.replyTo && { replyTo: { email: params.replyTo } }),
        ...(params.tags && { tags: params.tags }),
      };

      const response = await fetchWithTimeout(`${BREVO_API_BASE}/smtp/email`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "api-key": this.config.apiKey,
        },
        body: JSON.stringify(payload),
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const data: BrevoEmailResponse = await response.json();

      if (!response.ok) {
        return {
          success: false,
          provider: this.name,
          error: data.message || `HTTP ${response.status}`,
          latencyMs,
          timestamp: Date.now(),
        };
      }

      return {
        success: true,
        provider: this.name,
        messageId: data.messageId,
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
   * Check provider health by fetching account info
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "BREVO_API_KEY not configured",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      const response = await fetchWithTimeout(`${BREVO_API_BASE}/account`, {
        method: "GET",
        headers: {
          "api-key": this.config.apiKey,
          Accept: "application/json",
        },
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

      const data: BrevoAccountResponse = await response.json();
      const plan = data.plan?.[0];
      const planType = plan?.type || "unknown";
      const credits = plan?.credits ?? 0;

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
        message: `Connected. Plan: ${planType}, Credits: ${credits.toLocaleString()}`,
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
   * Get quota information from Brevo account API
   * Returns real-time credits from Brevo + plan limits
   */
  async getQuota(): Promise<ProviderQuota> {
    const limits = PROVIDER_LIMITS.brevo;

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
        monthly: { sent: 0, limit: limits.monthly, remaining: limits.monthly, percentUsed: 0 },
      };
    }

    try {
      const response = await fetchWithTimeout(`${BREVO_API_BASE}/account`, {
        method: "GET",
        headers: {
          "api-key": this.config.apiKey,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: BrevoAccountResponse = await response.json();
      const plan = data.plan?.[0];
      const planType = plan?.type || "free";
      const credits = plan?.credits ?? 0;

      // Brevo free plan: 300/day, 9000/month
      // Paid plans: credits are monthly allowance
      const dailyLimit = planType === "free" ? 300 : Math.ceil(credits / 30);
      const monthlyLimit = planType === "free" ? 9000 : credits;

      return {
        provider: this.name,
        daily: {
          sent: 0, // Tracked in email_provider_quota table
          limit: dailyLimit,
          remaining: dailyLimit,
          percentUsed: 0,
        },
        monthly: {
          sent: 0, // Tracked in email_provider_monthly_quota table
          limit: monthlyLimit,
          remaining: credits, // Real remaining from API
          percentUsed:
            monthlyLimit > 0 ? Math.round(((monthlyLimit - credits) / monthlyLimit) * 100) : 0,
        },
      };
    } catch {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
        monthly: { sent: 0, limit: limits.monthly, remaining: limits.monthly, percentUsed: 0 },
      };
    }
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
      apiBase: BREVO_API_BASE,
    };
  }
}

/**
 * Create Brevo provider from environment
 */
export function createBrevoProvider(): BrevoProvider {
  return new BrevoProvider();
}
