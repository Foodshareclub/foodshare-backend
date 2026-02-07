/**
 * AWS SES Email Provider
 *
 * High-volume, cost-effective email provider with AWS integration
 * Best for: bulk emails, high-volume transactional
 *
 * Uses AWS Signature V4 authentication (no external dependencies)
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

import { AWSV4Signer } from "../aws-signer.ts";

const REQUEST_TIMEOUT_MS = 10000;

interface AWSSESConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromEmail: string;
  fromName: string;
}

// ============================================================================
// AWS SES Provider Implementation
// ============================================================================

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
 * AWS SES Email Provider Implementation
 */
export class AWSSESProvider implements EmailProvider {
  readonly name: EmailProviderName = "aws_ses";
  private config: AWSSESConfig;
  private signer: AWSV4Signer | null = null;
  private endpoint: string;

  constructor(config: Partial<AWSSESConfig> = {}) {
    this.config = {
      region: config.region || Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION") || "",
      accessKeyId:
        config.accessKeyId ||
        Deno.env.get("AWS_ACCESS_KEY_ID") ||
        Deno.env.get("AWS_SES_ACCESS_KEY_ID") ||
        "",
      secretAccessKey:
        config.secretAccessKey ||
        Deno.env.get("AWS_SECRET_ACCESS_KEY") ||
        Deno.env.get("AWS_SES_SECRET_ACCESS_KEY") ||
        "",
      fromEmail:
        config.fromEmail ||
        Deno.env.get("AWS_SES_FROM_EMAIL") ||
        Deno.env.get("EMAIL_FROM") ||
        "contact@foodshare.club",
      fromName:
        config.fromName ||
        Deno.env.get("AWS_SES_FROM_NAME") ||
        Deno.env.get("EMAIL_FROM_NAME") ||
        "FoodShare",
    };

    this.endpoint = `https://email.${this.config.region}.amazonaws.com`;

    if (this.isConfigured()) {
      this.signer = new AWSV4Signer(
        this.config.region,
        "ses",
        this.config.accessKeyId,
        this.config.secretAccessKey
      );
    }
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!(this.config.region && this.config.accessKeyId && this.config.secretAccessKey);
  }

  /**
   * Send email via AWS SES v2 API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    const startTime = performance.now();

    if (!this.isConfigured() || !this.signer) {
      return {
        success: false,
        provider: this.name,
        error: "AWS SES not configured",
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    try {
      const fromEmail = params.from || this.config.fromEmail;
      const fromName = params.fromName || this.config.fromName;
      const toAddresses = Array.isArray(params.to) ? params.to : [params.to];

      const payload = JSON.stringify({
        FromEmailAddress: `${fromName} <${fromEmail}>`,
        Destination: { ToAddresses: toAddresses },
        Content: {
          Simple: {
            Subject: { Data: params.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: params.html, Charset: "UTF-8" },
              ...(params.text && { Text: { Data: params.text, Charset: "UTF-8" } }),
            },
          },
        },
        ...(params.replyTo && { ReplyToAddresses: [params.replyTo] }),
      });

      const headers = {
        "Content-Type": "application/json",
        "Content-Length": payload.length.toString(),
      };

      const signedHeaders = await this.signer.signRequest(
        "POST",
        `${this.endpoint}/v2/email/outbound-emails`,
        headers,
        payload
      );

      const response = await fetchWithTimeout(`${this.endpoint}/v2/email/outbound-emails`, {
        method: "POST",
        headers: signedHeaders,
        body: payload,
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const responseText = await response.text();

      if (!response.ok) {
        let errorMessage = `AWS SES error: ${response.status}`;
        try {
          const errorData = JSON.parse(responseText);
          errorMessage = errorData.message || errorData.Message || errorMessage;
        } catch {
          errorMessage = responseText || errorMessage;
        }

        return {
          success: false,
          provider: this.name,
          error: errorMessage,
          latencyMs,
          timestamp: Date.now(),
        };
      }

      const result = JSON.parse(responseText);

      return {
        success: true,
        provider: this.name,
        messageId: result.MessageId,
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
   * Check provider health by fetching quota
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured() || !this.signer) {
      const missing: string[] = [];
      if (!this.config.region) missing.push("AWS_REGION");
      if (!this.config.accessKeyId) missing.push("AWS_ACCESS_KEY_ID");
      if (!this.config.secretAccessKey) missing.push("AWS_SECRET_ACCESS_KEY");

      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: `Missing env vars: ${missing.join(", ")}`,
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      // Use SES v1 Query API for quota check
      const url = `${this.endpoint}/?Action=GetSendQuota&Version=2010-12-01`;
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      const signedHeaders = await this.signer.signRequest("GET", url, headers, "");

      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: signedHeaders,
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const responseText = await response.text();

      if (!response.ok) {
        const errorMatch = responseText.match(/<Message>([^<]+)<\/Message>/);
        const errorMessage = errorMatch?.[1] || `HTTP ${response.status}`;

        return {
          provider: this.name,
          status: "error",
          healthScore: 0,
          latencyMs,
          message: `AWS SES API error: ${errorMessage}`,
          configured: true,
          lastChecked: Date.now(),
        };
      }

      // Parse XML response
      const max24HourSendMatch = responseText.match(/<Max24HourSend>([^<]+)<\/Max24HourSend>/);
      const maxSendRateMatch = responseText.match(/<MaxSendRate>([^<]+)<\/MaxSendRate>/);
      const sentLast24HoursMatch = responseText.match(
        /<SentLast24Hours>([^<]+)<\/SentLast24Hours>/
      );

      const max24HourSend = max24HourSendMatch ? parseFloat(max24HourSendMatch[1]) : 0;
      const maxSendRate = maxSendRateMatch ? parseFloat(maxSendRateMatch[1]) : 0;
      const sentLast24Hours = sentLast24HoursMatch ? parseFloat(sentLast24HoursMatch[1]) : 0;

      // Check for zero quota (sandbox or permission issue)
      if (max24HourSend === 0 && maxSendRate === 0) {
        return {
          provider: this.name,
          status: "error",
          healthScore: 0,
          latencyMs,
          message: `AWS SES returned zero quota. May indicate sandbox mode or missing permissions.`,
          configured: true,
          lastChecked: Date.now(),
        };
      }

      // Calculate health score
      let healthScore = 100;
      if (latencyMs > 2000) healthScore -= 30;
      else if (latencyMs > 1000) healthScore -= 15;
      else if (latencyMs > 500) healthScore -= 5;

      // Reduce score if quota is low
      const quotaUsedPercent = (sentLast24Hours / max24HourSend) * 100;
      if (quotaUsedPercent > 90) healthScore -= 30;
      else if (quotaUsedPercent > 75) healthScore -= 15;

      return {
        provider: this.name,
        status: healthScore >= 70 ? "ok" : "degraded",
        healthScore,
        latencyMs,
        message: `Connected. Region: ${this.config.region}. Quota: ${sentLast24Hours.toFixed(0)}/${max24HourSend.toFixed(0)} (24h), Rate: ${maxSendRate}/sec`,
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
   * Get quota information from AWS SES
   */
  async getQuota(): Promise<ProviderQuota> {
    const limits = PROVIDER_LIMITS.aws_ses;

    if (!this.isConfigured() || !this.signer) {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
      };
    }

    try {
      const url = `${this.endpoint}/?Action=GetSendQuota&Version=2010-12-01`;
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      const signedHeaders = await this.signer.signRequest("GET", url, headers, "");

      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: signedHeaders,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const responseText = await response.text();
      const max24HourSendMatch = responseText.match(/<Max24HourSend>([^<]+)<\/Max24HourSend>/);
      const sentLast24HoursMatch = responseText.match(
        /<SentLast24Hours>([^<]+)<\/SentLast24Hours>/
      );

      const max24HourSend = max24HourSendMatch ? parseFloat(max24HourSendMatch[1]) : limits.daily;
      const sentLast24Hours = sentLast24HoursMatch ? parseFloat(sentLast24HoursMatch[1]) : 0;

      return {
        provider: this.name,
        daily: {
          sent: sentLast24Hours,
          limit: max24HourSend,
          remaining: max24HourSend - sentLast24Hours,
          percentUsed: max24HourSend > 0 ? Math.round((sentLast24Hours / max24HourSend) * 100) : 0,
        },
      };
    } catch {
      return {
        provider: this.name,
        daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
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
      region: this.config.region || "not set",
      accessKeyIdPrefix: this.config.accessKeyId
        ? this.config.accessKeyId.slice(0, 8) + "..."
        : "not set",
      fromEmail: this.config.fromEmail,
      fromName: this.config.fromName,
      endpoint: this.endpoint,
    };
  }
}

/**
 * Create AWS SES provider from environment
 */
export function createAWSSESProvider(): AWSSESProvider {
  return new AWSSESProvider();
}
