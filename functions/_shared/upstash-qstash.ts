/**
 * Upstash QStash Client
 *
 * Production-grade message queue and task scheduling with:
 * - Background job publishing
 * - Delayed/scheduled message delivery
 * - Webhook retries with exponential backoff
 * - Request signature verification
 * - Dead letter queue support
 * - Batch publishing
 *
 * Use cases:
 * - Async processing (image resize, email sending)
 * - Scheduled tasks (daily reports, cleanup jobs)
 * - Webhook delivery with guaranteed retries
 * - Event-driven architecture
 *
 * @version 1.0.0
 */

import { logger } from "./logger.ts";
import { withCircuitBreaker, getCircuitStatus } from "./circuit-breaker.ts";
import { withRetry, RETRY_PRESETS } from "./retry.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface QStashConfig {
  /** QStash API token */
  token: string;
  /** QStash base URL (default: https://qstash.upstash.io) */
  baseUrl?: string;
  /** Current signing key for webhook verification */
  currentSigningKey?: string;
  /** Next signing key for key rotation */
  nextSigningKey?: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Circuit breaker failure threshold (default: 3) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  circuitBreakerResetMs?: number;
}

const DEFAULT_CONFIG = {
  baseUrl: "https://qstash.upstash.io",
  timeoutMs: 30000,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 30000,
};

// =============================================================================
// Types
// =============================================================================

export interface PublishOptions {
  /** Destination URL to receive the message */
  url: string;
  /** Message body (will be JSON stringified if object) */
  body?: unknown;
  /** Custom headers to forward */
  headers?: Record<string, string>;
  /** Delay delivery in seconds */
  delay?: number;
  /** Schedule using cron expression (e.g., "0 9 * * *") */
  cron?: string;
  /** Number of retries on failure (default: 3) */
  retries?: number;
  /** Callback URL for delivery status */
  callback?: string;
  /** Failure callback URL */
  failureCallback?: string;
  /** Deduplication ID (prevents duplicate processing) */
  deduplicationId?: string;
  /** Content-based deduplication (hash of body) */
  contentBasedDeduplication?: boolean;
  /** HTTP method for destination (default: POST) */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Timeout for destination request in seconds */
  timeout?: number;
}

export interface PublishResponse {
  messageId: string;
  url?: string;
  deduplicated?: boolean;
}

export interface BatchPublishRequest {
  destination: string;
  body?: unknown;
  headers?: Record<string, string>;
  delay?: number;
  deduplicationId?: string;
}

export interface BatchPublishResponse {
  messages: Array<{
    messageId: string;
    url: string;
    deduplicated?: boolean;
  }>;
}

export interface ScheduleOptions {
  /** Destination URL */
  url: string;
  /** Cron expression */
  cron: string;
  /** Message body */
  body?: unknown;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Schedule ID (for updates) */
  scheduleId?: string;
  /** Number of retries */
  retries?: number;
}

export interface Schedule {
  scheduleId: string;
  cron: string;
  destination: string;
  method: string;
  header?: Record<string, string[]>;
  body?: string;
  retries: number;
  createdAt: number;
}

export interface Message {
  messageId: string;
  topicName?: string;
  url: string;
  method: string;
  header?: Record<string, string[]>;
  body?: string;
  createdAt: number;
  state: "CREATED" | "ACTIVE" | "DELIVERED" | "ERROR" | "FAILED";
}

export interface VerifySignatureResult {
  isValid: boolean;
  error?: string;
}

// =============================================================================
// QStash Client Error
// =============================================================================

export class QStashError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "QStashError";
  }
}

// =============================================================================
// Upstash QStash Client
// =============================================================================

export class UpstashQStashClient {
  private readonly config: Required<Omit<QStashConfig, "currentSigningKey" | "nextSigningKey">> & {
    currentSigningKey?: string;
    nextSigningKey?: string;
  };

  constructor(config: QStashConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Execute a request to QStash API
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new QStashError(
          `QStash API error: ${response.status} - ${errorText}`,
          `HTTP_${response.status}`,
          response.status >= 500 || response.status === 429
        );
      }

      const text = await response.text();
      return text ? JSON.parse(text) : ({} as T);
    } catch (error) {
      clearTimeout(timeout);

      if (error instanceof QStashError) throw error;

      if (error instanceof Error && error.name === "AbortError") {
        throw new QStashError("Request timeout", "TIMEOUT", true);
      }

      throw new QStashError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        "NETWORK_ERROR",
        true
      );
    }
  }

  /**
   * Execute request with circuit breaker and retry
   */
  private async safeRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    return withCircuitBreaker(
      "upstash-qstash",
      async () => {
        return withRetry(
          () => this.request<T>(method, path, body, headers),
          {
            ...RETRY_PRESETS.quick,
            maxRetries: 2,
            shouldRetry: (error) => error instanceof QStashError && error.retryable,
          }
        );
      },
      {
        failureThreshold: this.config.circuitBreakerThreshold,
        resetTimeoutMs: this.config.circuitBreakerResetMs,
      }
    );
  }

  // ===========================================================================
  // Publishing
  // ===========================================================================

  /**
   * Publish a message to a URL
   */
  async publish(options: PublishOptions): Promise<PublishResponse> {
    const startTime = performance.now();

    const headers: Record<string, string> = {};

    if (options.delay) {
      headers["Upstash-Delay"] = `${options.delay}s`;
    }
    if (options.cron) {
      headers["Upstash-Cron"] = options.cron;
    }
    if (options.retries !== undefined) {
      headers["Upstash-Retries"] = String(options.retries);
    }
    if (options.callback) {
      headers["Upstash-Callback"] = options.callback;
    }
    if (options.failureCallback) {
      headers["Upstash-Failure-Callback"] = options.failureCallback;
    }
    if (options.deduplicationId) {
      headers["Upstash-Deduplication-Id"] = options.deduplicationId;
    }
    if (options.contentBasedDeduplication) {
      headers["Upstash-Content-Based-Deduplication"] = "true";
    }
    if (options.method) {
      headers["Upstash-Method"] = options.method;
    }
    if (options.timeout) {
      headers["Upstash-Timeout"] = String(options.timeout);
    }

    // Forward custom headers
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers[`Upstash-Forward-${key}`] = value;
      }
    }

    const result = await this.safeRequest<PublishResponse>(
      "POST",
      `/v2/publish/${encodeURIComponent(options.url)}`,
      options.body,
      headers
    );

    logger.info("QStash message published", {
      messageId: result.messageId,
      url: options.url,
      hasDelay: !!options.delay,
      hasCron: !!options.cron,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return result;
  }

  /**
   * Publish multiple messages in a batch
   */
  async publishBatch(messages: BatchPublishRequest[]): Promise<BatchPublishResponse> {
    const startTime = performance.now();

    const batch = messages.map((msg) => ({
      destination: msg.destination,
      body: msg.body ? JSON.stringify(msg.body) : undefined,
      headers: msg.headers,
      delay: msg.delay ? `${msg.delay}s` : undefined,
      deduplicationId: msg.deduplicationId,
    }));

    const result = await this.safeRequest<BatchPublishResponse["messages"]>(
      "POST",
      "/v2/batch",
      batch
    );

    logger.info("QStash batch published", {
      count: messages.length,
      latencyMs: Math.round(performance.now() - startTime),
    });

    return { messages: result };
  }

  /**
   * Publish to a topic (fan-out to multiple endpoints)
   */
  async publishToTopic(
    topicName: string,
    body: unknown,
    options?: Omit<PublishOptions, "url" | "body">
  ): Promise<PublishResponse[]> {
    const headers: Record<string, string> = {};

    if (options?.delay) headers["Upstash-Delay"] = `${options.delay}s`;
    if (options?.retries !== undefined) headers["Upstash-Retries"] = String(options.retries);
    if (options?.deduplicationId) headers["Upstash-Deduplication-Id"] = options.deduplicationId;

    return this.safeRequest<PublishResponse[]>(
      "POST",
      `/v2/publish/${encodeURIComponent(topicName)}`,
      body,
      headers
    );
  }

  // ===========================================================================
  // Schedules
  // ===========================================================================

  /**
   * Create or update a schedule
   */
  async createSchedule(options: ScheduleOptions): Promise<{ scheduleId: string }> {
    const headers: Record<string, string> = {
      "Upstash-Cron": options.cron,
    };

    if (options.retries !== undefined) {
      headers["Upstash-Retries"] = String(options.retries);
    }

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers[`Upstash-Forward-${key}`] = value;
      }
    }

    const result = await this.safeRequest<{ scheduleId: string }>(
      "POST",
      `/v2/schedules/${encodeURIComponent(options.url)}`,
      options.body,
      headers
    );

    logger.info("QStash schedule created", {
      scheduleId: result.scheduleId,
      cron: options.cron,
      url: options.url,
    });

    return result;
  }

  /**
   * Get a schedule by ID
   */
  async getSchedule(scheduleId: string): Promise<Schedule> {
    return this.safeRequest<Schedule>("GET", `/v2/schedules/${scheduleId}`);
  }

  /**
   * List all schedules
   */
  async listSchedules(): Promise<Schedule[]> {
    return this.safeRequest<Schedule[]>("GET", "/v2/schedules");
  }

  /**
   * Delete a schedule
   */
  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.safeRequest("DELETE", `/v2/schedules/${scheduleId}`);
    logger.info("QStash schedule deleted", { scheduleId });
  }

  /**
   * Pause a schedule
   */
  async pauseSchedule(scheduleId: string): Promise<void> {
    await this.safeRequest("POST", `/v2/schedules/${scheduleId}/pause`);
    logger.info("QStash schedule paused", { scheduleId });
  }

  /**
   * Resume a schedule
   */
  async resumeSchedule(scheduleId: string): Promise<void> {
    await this.safeRequest("POST", `/v2/schedules/${scheduleId}/resume`);
    logger.info("QStash schedule resumed", { scheduleId });
  }

  // ===========================================================================
  // Messages
  // ===========================================================================

  /**
   * Get a message by ID
   */
  async getMessage(messageId: string): Promise<Message> {
    return this.safeRequest<Message>("GET", `/v2/messages/${messageId}`);
  }

  /**
   * Cancel a pending message
   */
  async cancelMessage(messageId: string): Promise<void> {
    await this.safeRequest("DELETE", `/v2/messages/${messageId}`);
    logger.info("QStash message cancelled", { messageId });
  }

  /**
   * Bulk cancel messages by IDs
   */
  async cancelMessages(messageIds: string[]): Promise<{ cancelled: number }> {
    const result = await this.safeRequest<{ cancelled: number }>(
      "DELETE",
      "/v2/messages",
      { messageIds }
    );
    logger.info("QStash messages cancelled", { cancelled: result.cancelled });
    return result;
  }

  // ===========================================================================
  // Topics
  // ===========================================================================

  /**
   * Create a topic
   */
  async createTopic(name: string): Promise<void> {
    await this.safeRequest("POST", `/v2/topics/${encodeURIComponent(name)}`);
    logger.info("QStash topic created", { name });
  }

  /**
   * Delete a topic
   */
  async deleteTopic(name: string): Promise<void> {
    await this.safeRequest("DELETE", `/v2/topics/${encodeURIComponent(name)}`);
    logger.info("QStash topic deleted", { name });
  }

  /**
   * Add endpoint to topic
   */
  async addEndpointToTopic(topicName: string, endpoint: string): Promise<void> {
    await this.safeRequest(
      "POST",
      `/v2/topics/${encodeURIComponent(topicName)}/endpoints/${encodeURIComponent(endpoint)}`
    );
    logger.info("QStash endpoint added to topic", { topicName, endpoint });
  }

  /**
   * Remove endpoint from topic
   */
  async removeEndpointFromTopic(topicName: string, endpoint: string): Promise<void> {
    await this.safeRequest(
      "DELETE",
      `/v2/topics/${encodeURIComponent(topicName)}/endpoints/${encodeURIComponent(endpoint)}`
    );
    logger.info("QStash endpoint removed from topic", { topicName, endpoint });
  }

  // ===========================================================================
  // Webhook Signature Verification
  // ===========================================================================

  /**
   * Verify webhook signature from QStash
   */
  async verifySignature(
    signature: string,
    body: string,
    url: string
  ): Promise<VerifySignatureResult> {
    if (!this.config.currentSigningKey) {
      return { isValid: false, error: "Signing key not configured" };
    }

    try {
      // Try current key first
      const isValidCurrent = await this.verifyWithKey(
        signature,
        body,
        url,
        this.config.currentSigningKey
      );

      if (isValidCurrent) {
        return { isValid: true };
      }

      // Try next key (for key rotation)
      if (this.config.nextSigningKey) {
        const isValidNext = await this.verifyWithKey(
          signature,
          body,
          url,
          this.config.nextSigningKey
        );

        if (isValidNext) {
          return { isValid: true };
        }
      }

      return { isValid: false, error: "Invalid signature" };
    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async verifyWithKey(
    signature: string,
    body: string,
    url: string,
    signingKey: string
  ): Promise<boolean> {
    const encoder = new TextEncoder();

    // QStash signature is: base64(hmac-sha256(signingKey, url + body))
    const payload = url + body;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    const expectedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

    // Constant-time comparison
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }

    return result === 0;
  }

  // ===========================================================================
  // Health
  // ===========================================================================

  /**
   * Check if client is healthy
   */
  isHealthy(): boolean {
    const circuitStatus = getCircuitStatus("upstash-qstash");
    return circuitStatus?.state !== "open";
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let clientInstance: UpstashQStashClient | null = null;

/**
 * Get or create the QStash client (singleton)
 */
export function getQStashClient(config?: Partial<QStashConfig>): UpstashQStashClient {
  if (!clientInstance) {
    const token = config?.token || Deno.env.get("QSTASH_TOKEN");
    const baseUrl = config?.baseUrl || Deno.env.get("QSTASH_URL") || DEFAULT_CONFIG.baseUrl;
    const currentSigningKey = config?.currentSigningKey || Deno.env.get("QSTASH_CURRENT_SIGNING_KEY");
    const nextSigningKey = config?.nextSigningKey || Deno.env.get("QSTASH_NEXT_SIGNING_KEY");

    if (!token) {
      throw new QStashError("QSTASH_TOKEN must be configured", "CONFIG_ERROR");
    }

    clientInstance = new UpstashQStashClient({
      token,
      baseUrl,
      currentSigningKey,
      nextSigningKey,
      ...config,
    });
  }

  return clientInstance;
}

/**
 * Create a new client instance (for testing)
 */
export function createQStashClient(config: QStashConfig): UpstashQStashClient {
  return new UpstashQStashClient(config);
}

/**
 * Reset the singleton client (for testing)
 */
export function resetQStashClient(): void {
  clientInstance = null;
}

// =============================================================================
// Helper: Verify QStash Webhook Request
// =============================================================================

/**
 * Middleware helper to verify QStash webhook signatures
 */
export async function verifyQStashWebhook(
  request: Request
): Promise<{ isValid: boolean; body: string; error?: string }> {
  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return { isValid: false, body: "", error: "Missing upstash-signature header" };
  }

  const body = await request.text();
  const url = request.url;

  const client = getQStashClient();
  const result = await client.verifySignature(signature, body, url);

  return { ...result, body };
}
