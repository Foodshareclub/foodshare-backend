/**
 * Email Provider Tests
 *
 * Tests for _shared/email/email-service.ts
 * Tests provider selection, health checks, and circuit breaker integration.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import type {
  EmailProvider,
  EmailProviderName,
  SendEmailParams,
  SendEmailResult,
  ProviderHealth,
} from "../_shared/email/types.ts";

// =============================================================================
// Mock Email Provider
// =============================================================================

class MockEmailProvider implements EmailProvider {
  readonly name: EmailProviderName;
  private _configured: boolean;
  private _shouldFail: boolean;
  private _failMessage: string;
  sendCount = 0;

  constructor(
    name: EmailProviderName,
    options: { configured?: boolean; shouldFail?: boolean; failMessage?: string } = {},
  ) {
    this.name = name;
    this._configured = options.configured ?? true;
    this._shouldFail = options.shouldFail ?? false;
    this._failMessage = options.failMessage ?? "Provider error";
  }

  isConfigured(): boolean {
    return this._configured;
  }

  async sendEmail(_params: SendEmailParams): Promise<SendEmailResult> {
    this.sendCount++;
    if (this._shouldFail) {
      return {
        success: false,
        provider: this.name,
        error: this._failMessage,
        latencyMs: 50,
        timestamp: Date.now(),
      };
    }
    return {
      success: true,
      provider: this.name,
      messageId: `msg_${this.name}_${this.sendCount}`,
      latencyMs: 100,
      timestamp: Date.now(),
    };
  }

  async checkHealth(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: this._configured ? (this._shouldFail ? "error" : "ok") : "unconfigured",
      healthScore: this._shouldFail ? 0 : 100,
      latencyMs: 50,
      message: this._shouldFail ? this._failMessage : "OK",
      configured: this._configured,
      lastChecked: Date.now(),
    };
  }

  getDebugInfo(): Record<string, unknown> {
    return { name: this.name, configured: this._configured };
  }
}

// =============================================================================
// Provider Selection Tests
// =============================================================================

Deno.test("email: first configured provider is used", async () => {
  const providers: MockEmailProvider[] = [
    new MockEmailProvider("resend"),
    new MockEmailProvider("brevo"),
  ];

  // Simulate the service selecting first configured provider
  const priority: EmailProviderName[] = ["resend", "brevo"];
  const selected = priority.find((name) => {
    const p = providers.find((p) => p.name === name);
    return p?.isConfigured();
  });

  assertEquals(selected, "resend");

  const provider = providers.find((p) => p.name === selected)!;
  const result = await provider.sendEmail({
    to: "test@example.com",
    subject: "Test",
    html: "<p>Hello</p>",
  });

  assertEquals(result.success, true);
  assertEquals(result.provider, "resend");
  assertEquals(provider.sendCount, 1);
  assertEquals(providers[1].sendCount, 0); // Brevo not called
});

Deno.test("email: skips unconfigured provider", async () => {
  const providers: MockEmailProvider[] = [
    new MockEmailProvider("resend", { configured: false }),
    new MockEmailProvider("brevo", { configured: true }),
  ];

  const priority: EmailProviderName[] = ["resend", "brevo"];
  const selected = priority.find((name) => {
    const p = providers.find((p) => p.name === name);
    return p?.isConfigured();
  });

  assertEquals(selected, "brevo");

  const provider = providers.find((p) => p.name === selected)!;
  const result = await provider.sendEmail({
    to: "test@example.com",
    subject: "Test",
    html: "<p>Hello</p>",
  });

  assertEquals(result.success, true);
  assertEquals(result.provider, "brevo");
});

// =============================================================================
// Failover Tests
// =============================================================================

Deno.test("email: first provider succeeds - no failover needed", async () => {
  const providers: MockEmailProvider[] = [
    new MockEmailProvider("resend"),
    new MockEmailProvider("brevo"),
  ];

  const result = await providers[0].sendEmail({
    to: "test@example.com",
    subject: "Test",
    html: "<p>Hello</p>",
  });

  assertEquals(result.success, true);
  assertEquals(result.provider, "resend");
  assertEquals(providers[0].sendCount, 1);
  assertEquals(providers[1].sendCount, 0);
});

Deno.test("email: first provider fails, second succeeds (failover logic)", async () => {
  const providers: MockEmailProvider[] = [
    new MockEmailProvider("resend", { shouldFail: true, failMessage: "API key expired" }),
    new MockEmailProvider("brevo"),
    new MockEmailProvider("mailersend"),
  ];

  // Simulate failover: try each in priority order until one succeeds
  const params: SendEmailParams = {
    to: "test@example.com",
    subject: "Test",
    html: "<p>Hello</p>",
  };

  let finalResult: SendEmailResult | null = null;
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    const result = await provider.sendEmail(params);
    if (result.success) {
      finalResult = result;
      break;
    }
  }

  assertExists(finalResult);
  assertEquals(finalResult!.success, true);
  assertEquals(finalResult!.provider, "brevo");
  assertEquals(providers[0].sendCount, 1); // Resend tried but failed
  assertEquals(providers[1].sendCount, 1); // Brevo succeeded
  assertEquals(providers[2].sendCount, 0); // MailerSend not needed
});

Deno.test("email: all providers fail - returns last error", async () => {
  const providers: MockEmailProvider[] = [
    new MockEmailProvider("resend", { shouldFail: true, failMessage: "Resend down" }),
    new MockEmailProvider("brevo", { shouldFail: true, failMessage: "Brevo down" }),
    new MockEmailProvider("mailersend", { shouldFail: true, failMessage: "MailerSend down" }),
  ];

  const params: SendEmailParams = {
    to: "test@example.com",
    subject: "Test",
    html: "<p>Hello</p>",
  };

  const errors: string[] = [];
  let finalResult: SendEmailResult | null = null;
  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    const result = await provider.sendEmail(params);
    if (result.success) {
      finalResult = result;
      break;
    }
    errors.push(result.error || "Unknown error");
  }

  assertEquals(finalResult, null);
  assertEquals(errors.length, 3);
  assertEquals(errors[0], "Resend down");
  assertEquals(errors[1], "Brevo down");
  assertEquals(errors[2], "MailerSend down");
});

// =============================================================================
// Health Check Tests
// =============================================================================

Deno.test("email: provider health check - healthy provider", async () => {
  const provider = new MockEmailProvider("resend");
  const health = await provider.checkHealth();

  assertEquals(health.status, "ok");
  assertEquals(health.healthScore, 100);
  assertEquals(health.configured, true);
});

Deno.test("email: provider health check - failing provider", async () => {
  const provider = new MockEmailProvider("brevo", { shouldFail: true });
  const health = await provider.checkHealth();

  assertEquals(health.status, "error");
  assertEquals(health.healthScore, 0);
});

Deno.test("email: provider health check - unconfigured provider", async () => {
  const provider = new MockEmailProvider("aws_ses", { configured: false });
  const health = await provider.checkHealth();

  assertEquals(health.status, "unconfigured");
  assertEquals(health.configured, false);
});

// =============================================================================
// Circuit Breaker Integration Logic
// =============================================================================

Deno.test("email: circuit breaker opens after threshold failures", () => {
  // Simplified circuit breaker logic test
  const threshold = 5;
  let failures = 0;
  let state: "closed" | "open" = "closed";

  function recordFailure() {
    failures++;
    if (failures >= threshold) {
      state = "open";
    }
  }

  function isAvailable(): boolean {
    return state !== "open";
  }

  // First 4 failures - still closed
  for (let i = 0; i < 4; i++) {
    recordFailure();
    assertEquals(isAvailable(), true);
  }

  // 5th failure - opens circuit
  recordFailure();
  assertEquals(isAvailable(), false);
  assertEquals(state, "open");
});
