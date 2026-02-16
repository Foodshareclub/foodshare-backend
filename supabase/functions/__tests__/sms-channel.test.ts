/**
 * SMS Channel Tests
 *
 * Tests for api-v1-notifications/lib/channels/sms.ts
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { SmsChannelAdapter } from "../api-v1-notifications/lib/channels/sms.ts";

// =============================================================================
// Setup
// =============================================================================

function createMockContext() {
  return {
    supabase: {} as any,
    requestId: "test-req-sms",
    userId: "test-user",
  };
}

// =============================================================================
// Tests
// =============================================================================

Deno.test("SmsChannelAdapter: returns 'not configured' when env vars missing", async () => {
  // Ensure Twilio env vars are not set
  Deno.env.delete("TWILIO_ACCOUNT_SID");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_PHONE_NUMBER");

  const adapter = new SmsChannelAdapter();
  const context = createMockContext();

  const result = await adapter.send(
    { to: "+1234567890", body: "Test message" },
    context,
  );

  assertEquals(result.success, false);
  assertEquals(result.error, "SMS not configured");
  assertEquals(result.channel, "sms");
});

Deno.test("SmsChannelAdapter: successful send with mock Twilio", async () => {
  // Set up Twilio env vars
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest123");
  Deno.env.set("TWILIO_AUTH_TOKEN", "test-auth-token");
  Deno.env.set("TWILIO_PHONE_NUMBER", "+15005550006");

  // Mock fetch for Twilio API
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return new Response(
      JSON.stringify({
        sid: "SM_test_123",
        status: "queued",
        to: "+1234567890",
        from: "+15005550006",
      }),
      { status: 201 },
    );
  };

  try {
    const adapter = new SmsChannelAdapter();
    const context = createMockContext();

    const result = await adapter.send(
      { to: "+1234567890", body: "Hello from FoodShare!" },
      context,
    );

    assertEquals(result.success, true);
    assertEquals(result.channel, "sms");
    assertEquals(result.provider, "twilio");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("TWILIO_ACCOUNT_SID");
    Deno.env.delete("TWILIO_AUTH_TOKEN");
    Deno.env.delete("TWILIO_PHONE_NUMBER");
  }
});

Deno.test("SmsChannelAdapter: Twilio 4xx error handling", async () => {
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest456");
  Deno.env.set("TWILIO_AUTH_TOKEN", "test-auth-token");
  Deno.env.set("TWILIO_PHONE_NUMBER", "+15005550006");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        code: 21211,
        message: "The 'To' number is not a valid phone number.",
        status: 400,
      }),
      { status: 400 },
    );
  };

  try {
    const adapter = new SmsChannelAdapter();
    const context = createMockContext();

    const result = await adapter.send(
      { to: "invalid-number", body: "Test" },
      context,
    );

    assertEquals(result.success, false);
    assertEquals(result.channel, "sms");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("TWILIO_ACCOUNT_SID");
    Deno.env.delete("TWILIO_AUTH_TOKEN");
    Deno.env.delete("TWILIO_PHONE_NUMBER");
  }
});

Deno.test("SmsChannelAdapter: health check with missing credentials", async () => {
  Deno.env.delete("TWILIO_ACCOUNT_SID");
  Deno.env.delete("TWILIO_AUTH_TOKEN");
  Deno.env.delete("TWILIO_PHONE_NUMBER");

  const adapter = new SmsChannelAdapter();
  const health = await adapter.healthCheck();

  assertEquals(health.healthy, false);
  assertEquals(typeof health.error, "string");
});

Deno.test("SmsChannelAdapter: health check with valid credentials", async () => {
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest789");
  Deno.env.set("TWILIO_AUTH_TOKEN", "test-auth-token");
  Deno.env.set("TWILIO_PHONE_NUMBER", "+15005550006");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => {
    return new Response(
      JSON.stringify({
        sid: "ACtest789",
        friendly_name: "Test Account",
        status: "active",
      }),
      { status: 200 },
    );
  };

  try {
    const adapter = new SmsChannelAdapter();
    const health = await adapter.healthCheck();

    assertEquals(health.healthy, true);
    assertEquals(typeof health.latencyMs, "number");
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("TWILIO_ACCOUNT_SID");
    Deno.env.delete("TWILIO_AUTH_TOKEN");
    Deno.env.delete("TWILIO_PHONE_NUMBER");
  }
});
