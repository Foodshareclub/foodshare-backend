/**
 * AWS SES Email Provider with AWS Signature V4 Authentication
 *
 * Implements proper AWS SES v2 API with SigV4 signing
 * No external dependencies - pure Deno implementation
 */

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
 * AWS Signature V4 Signing Implementation
 */
class AWSV4Signer {
  private algorithm = "AWS4-HMAC-SHA256";

  constructor(
    private region: string,
    private service: string,
    private accessKeyId: string,
    private secretAccessKey: string
  ) {}

  /**
   * Sign AWS request with Signature V4
   */
  async signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: string
  ): Promise<Record<string, string>> {
    const now = new Date();
    const dateStamp = this.getDateStamp(now);
    const amzDate = this.getAmzDate(now);

    // Add required headers
    const signedHeaders = {
      ...headers,
      "x-amz-date": amzDate,
      host: new URL(url).host,
    };

    // Create canonical request
    const canonicalRequest = await this.createCanonicalRequest(method, url, signedHeaders, payload);

    // Create string to sign
    const credentialScope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
    const stringToSign = await this.createStringToSign(amzDate, credentialScope, canonicalRequest);

    // Calculate signature
    const signature = await this.calculateSignature(dateStamp, stringToSign);

    // Create authorization header
    const signedHeadersList = Object.keys(signedHeaders).sort().join(";");

    const authorization =
      `${this.algorithm} Credential=${this.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeadersList}, Signature=${signature}`;

    return {
      ...signedHeaders,
      Authorization: authorization,
    };
  }

  private async createCanonicalRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    payload: string
  ): Promise<string> {
    const urlObj = new URL(url);
    const canonicalUri = urlObj.pathname || "/";
    const canonicalQueryString = urlObj.search.slice(1) || "";

    // Canonical headers (sorted, lowercase keys)
    const canonicalHeaders =
      Object.keys(headers)
        .sort()
        .map((key) => `${key.toLowerCase()}:${headers[key].trim()}`)
        .join("\n") + "\n";

    const signedHeaders = Object.keys(headers)
      .sort()
      .map((key) => key.toLowerCase())
      .join(";");

    // Hash payload (must await the async sha256Hex)
    const payloadHash = await this.sha256Hex(payload);

    return [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
  }

  private async createStringToSign(
    amzDate: string,
    credentialScope: string,
    canonicalRequest: string
  ): Promise<string> {
    const hashedCanonicalRequest = await this.sha256Hex(canonicalRequest);

    return [this.algorithm, amzDate, credentialScope, hashedCanonicalRequest].join("\n");
  }

  private async calculateSignature(dateStamp: string, stringToSign: string): Promise<string> {
    const kDate = await this.hmacSha256(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = await this.hmacSha256(kDate, this.region);
    const kService = await this.hmacSha256(kRegion, this.service);
    const kSigning = await this.hmacSha256(kService, "aws4_request");
    const signature = await this.hmacSha256(kSigning, stringToSign);

    return this.bufferToHex(signature);
  }

  private getDateStamp(date: Date): string {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  }

  private getAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  private async sha256Hex(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
    return this.bufferToHex(new Uint8Array(hashBuffer));
  }

  private async hmacSha256(key: string | Uint8Array, data: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const keyData = typeof key === "string" ? encoder.encode(key) : key;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));

    return new Uint8Array(signature);
  }

  private bufferToHex(buffer: Uint8Array): string {
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
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
