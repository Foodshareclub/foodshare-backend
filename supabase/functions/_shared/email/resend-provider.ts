/**
 * Resend Email Provider
 *
 * High-deliverability transactional email provider
 * Best for: auth emails, critical notifications
 *
 * API Docs: https://resend.com/docs/api-reference
 */

import {
  EmailProvider,
  EmailProviderName,
  PROVIDER_LIMITS,
  ProviderHealth,
  ProviderQuota,
  SendEmailParams,
  SendEmailResult,
} from "./types.ts";

const RESEND_API_BASE = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 10000;

interface ResendConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

interface ResendEmailResponse {
  id?: string;
  error?: {
    message: string;
    name: string;
  };
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  created_at: string;
  region: string;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
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
 * Resend Email Provider Implementation
 */
export class ResendProvider implements EmailProvider {
  readonly name: EmailProviderName = "resend";
  private config: ResendConfig;

  constructor(config: Partial<ResendConfig> = {}) {
    this.config = {
      apiKey: config.apiKey || Deno.env.get("RESEND_API_KEY") || "",
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
   * Send email via Resend API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        success: false,
        provider: this.name,
        error: "Resend API key not configured",
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const fromEmail = params.from || this.config.fromEmail;
      const fromName = params.fromName || this.config.fromName;
      const toAddresses = Array.isArray(params.to) ? params.to : [params.to];

      const payload = {
        from: `${fromName} <${fromEmail}>`,
        to: toAddresses,
        subject: params.subject,
        html: params.html,
        ...(params.text && { text: params.text }),
        ...(params.replyTo && { reply_to: params.replyTo }),
        ...(params.tags && { tags: params.tags.map((t) => ({ name: t, value: "true" })) }),
      };

      const response = await fetchWithTimeout(`${RESEND_API_BASE}/emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const data: ResendEmailResponse = await response.json();

      if (!response.ok || data.error) {
        return {
          success: false,
          provider: this.name,
          error: data.error?.message || `HTTP ${response.status}`,
          latencyMs,
          timestamp: Date.now(),
        };
      }

      return {
        success: true,
        provider: this.name,
        messageId: data.id,
        latencyMs,
        timestamp: Date.now(),
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const message = error instanceof Error
        ? error.name === "AbortError" ? "Request timeout" : error.message
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
   * Check provider health by fetching domains
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "RESEND_API_KEY not configured",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      const response = await fetchWithTimeout(`${RESEND_API_BASE}/domains`, {
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
      const domains: ResendDomain[] = data.data || [];
      const domainNames = domains.map((d) => d.name);

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
        message: `Connected. ${domains.length} domain(s): ${domainNames.join(", ") || "none"}`,
        configured: true,
        lastChecked: Date.now(),
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const message = error instanceof Error
        ? error.name === "AbortError" ? "Request timeout (10s)" : error.message
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
   * Get quota information from Resend API
   * Resend free tier: 100/day, 3000/month
   * Resend paid: varies by plan
   */
  async getQuota(): Promise<ProviderQuota> {
    const limits = PROVIDER_LIMITS.resend;

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
        monthly: { sent: 0, limit: limits.monthly, remaining: limits.monthly, percentUsed: 0 },
      };
    }

    // Resend doesn't have a direct quota API, but we can check rate limit headers
    // For now, return the known limits - actual usage tracked in DB
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
      apiBase: RESEND_API_BASE,
    };
  }
}

/**
 * Create Resend provider from environment
 */
export function createResendProvider(): ResendProvider {
  return new ResendProvider();
}
