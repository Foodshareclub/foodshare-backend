/**
 * AWS SES Email Provider with AWS Signature V4 Authentication
 *
 * Implements proper AWS SES v2 API with SigV4 signing
 * No external dependencies - pure Deno implementation
 */

import { AWSV4Signer } from "./aws-signer.ts";

// AWS SES Configuration
interface AWSSESConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromEmail: string;
  fromName?: string;
}

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * AWS SES Email Provider
 */
export class AWSSESProvider {
  private config: AWSSESConfig;
  private signer: AWSV4Signer;
  private endpoint: string;

  constructor(config: AWSSESConfig) {
    this.config = config;
    this.signer = new AWSV4Signer(config.region, "ses", config.accessKeyId, config.secretAccessKey);
    this.endpoint = `https://email.${config.region}.amazonaws.com`;
  }

  /**
   * Send email via AWS SES v2 API
   */
  async sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      // Build email content
      const emailContent = {
        Simple: {
          Subject: {
            Data: params.subject,
            Charset: "UTF-8",
          },
          Body: {
            Html: {
              Data: params.html,
              Charset: "UTF-8",
            },
            ...(params.text && {
              Text: {
                Data: params.text,
                Charset: "UTF-8",
              },
            }),
          },
        },
      };

      // Build request payload
      const payload = JSON.stringify({
        FromEmailAddress: this.config.fromName
          ? `${this.config.fromName} <${this.config.fromEmail}>`
          : this.config.fromEmail,
        Destination: {
          ToAddresses: [params.to],
        },
        Content: emailContent,
        ...(params.replyTo && {
          ReplyToAddresses: [params.replyTo],
        }),
      });

      // Prepare headers
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": payload.length.toString(),
      };

      // Sign request
      const signedHeaders = await this.signer.signRequest(
        "POST",
        `${this.endpoint}/v2/email/outbound-emails`,
        headers,
        payload
      );

      // Send request
      const response = await fetch(`${this.endpoint}/v2/email/outbound-emails`, {
        method: "POST",
        headers: signedHeaders,
        body: payload,
      });

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
          error: errorMessage,
        };
      }

      // Parse response
      const result = JSON.parse(responseText);

      return {
        success: true,
        messageId: result.MessageId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if AWS SES is configured and available
   */
  isConfigured(): boolean {
    return !!(
      this.config.accessKeyId &&
      this.config.secretAccessKey &&
      this.config.region &&
      this.config.fromEmail
    );
  }

  /**
   * Get AWS SES sending quota using SES v1 Query API
   * This is more compatible than the v2 REST API
   */
  async getQuota(): Promise<{
    max24HourSend: number;
    maxSendRate: number;
    sentLast24Hours: number;
    error?: string;
    rawResponse?: unknown;
  }> {
    try {
      // Use SES v1 Query API endpoint (more compatible)
      const sesV1Endpoint = `https://email.${this.config.region}.amazonaws.com/`;
      const queryParams = "Action=GetSendQuota&Version=2010-12-01";
      const url = `${sesV1Endpoint}?${queryParams}`;

      const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const signedHeaders = await this.signer.signRequest("GET", url, headers, "");

      const response = await fetch(url, {
        method: "GET",
        headers: signedHeaders,
      });

      const responseText = await response.text();

      if (!response.ok) {
        // Parse XML error response
        const errorMatch = responseText.match(/<Message>([^<]+)<\/Message>/);
        const errorMessage =
          errorMatch?.[1] || responseText.slice(0, 200) || `HTTP ${response.status}`;
        return {
          max24HourSend: 0,
          maxSendRate: 0,
          sentLast24Hours: 0,
          error: `AWS SES API error (${response.status}): ${errorMessage}`,
          rawResponse: responseText,
        };
      }

      // Parse XML response
      const max24HourSendMatch = responseText.match(/<Max24HourSend>([^<]+)<\/Max24HourSend>/);
      const maxSendRateMatch = responseText.match(/<MaxSendRate>([^<]+)<\/MaxSendRate>/);
      const sentLast24HoursMatch = responseText.match(
        /<SentLast24Hours>([^<]+)<\/SentLast24Hours>/
      );

      return {
        max24HourSend: max24HourSendMatch ? parseFloat(max24HourSendMatch[1]) : 0,
        maxSendRate: maxSendRateMatch ? parseFloat(maxSendRateMatch[1]) : 0,
        sentLast24Hours: sentLast24HoursMatch ? parseFloat(sentLast24HoursMatch[1]) : 0,
      };
    } catch (error) {
      console.error("Failed to get AWS SES quota:", error);
      return {
        max24HourSend: 0,
        maxSendRate: 0,
        sentLast24Hours: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the configured region
   */
  getRegion(): string {
    return this.config.region;
  }

  /**
   * Get masked credentials for debugging
   */
  getDebugInfo(): { region: string; accessKeyIdPrefix: string; endpoint: string } {
    return {
      region: this.config.region,
      accessKeyIdPrefix: this.config.accessKeyId.substring(0, 8) + "...",
      endpoint: this.endpoint,
    };
  }
}

/**
 * Create AWS SES provider from environment variables
 */
export function createAWSSESProvider(): AWSSESProvider | null {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION");
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID") || Deno.env.get("AWS_SES_ACCESS_KEY_ID");
  const secretAccessKey =
    Deno.env.get("AWS_SECRET_ACCESS_KEY") || Deno.env.get("AWS_SES_SECRET_ACCESS_KEY");
  const fromEmail =
    Deno.env.get("AWS_SES_FROM_EMAIL") || Deno.env.get("EMAIL_FROM") || "noreply@foodshare.app";
  const fromName =
    Deno.env.get("AWS_SES_FROM_NAME") || Deno.env.get("EMAIL_FROM_NAME") || "FoodShare";

  if (!region || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new AWSSESProvider({
    region,
    accessKeyId,
    secretAccessKey,
    fromEmail,
    fromName,
  });
}
