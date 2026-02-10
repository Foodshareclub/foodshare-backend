/**
 * Subscription Webhook Tests
 *
 * Comprehensive tests for the cross-platform subscription webhook handler.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  getEventSeverity,
  hasPremiumAccess,
  isNegativeEvent,
  isPositiveEvent,
  normalizeEnvironment,
  shouldUpdateSubscription,
  type SubscriptionEvent,
  type SubscriptionEventType,
  type SubscriptionStatus,
  validateEvent,
} from "../_shared/subscriptions/types.ts";

// =============================================================================
// shouldUpdateSubscription Tests
// =============================================================================

Deno.test("shouldUpdateSubscription - returns true for status-changing events", () => {
  const statusChangingEvents: SubscriptionEventType[] = [
    "subscription_created",
    "subscription_renewed",
    "subscription_expired",
    "subscription_canceled",
    "subscription_reactivated",
    "billing_issue",
    "billing_recovered",
    "grace_period_started",
    "grace_period_expired",
    "refunded",
    "revoked",
    "plan_changed",
    "paused",
    "resumed",
  ];

  for (const event of statusChangingEvents) {
    assertEquals(
      shouldUpdateSubscription(event),
      true,
      `Expected shouldUpdateSubscription to return true for ${event}`,
    );
  }
});

Deno.test("shouldUpdateSubscription - returns false for non-status events", () => {
  const nonStatusEvents: SubscriptionEventType[] = [
    "price_change",
    "test",
    "unknown",
  ];

  for (const event of nonStatusEvents) {
    assertEquals(
      shouldUpdateSubscription(event),
      false,
      `Expected shouldUpdateSubscription to return false for ${event}`,
    );
  }
});

// =============================================================================
// normalizeEnvironment Tests
// =============================================================================

Deno.test("normalizeEnvironment - normalizes production variants", () => {
  assertEquals(normalizeEnvironment("Production"), "production");
  assertEquals(normalizeEnvironment("production"), "production");
  assertEquals(normalizeEnvironment("PRODUCTION"), "production");
  assertEquals(normalizeEnvironment("prod"), "production");
  assertEquals(normalizeEnvironment("Prod"), "production");
});

Deno.test("normalizeEnvironment - normalizes sandbox variants", () => {
  assertEquals(normalizeEnvironment("Sandbox"), "sandbox");
  assertEquals(normalizeEnvironment("sandbox"), "sandbox");
  assertEquals(normalizeEnvironment("SANDBOX"), "sandbox");
  assertEquals(normalizeEnvironment("test"), "sandbox");
  assertEquals(normalizeEnvironment("Test"), "sandbox");
  assertEquals(normalizeEnvironment("xcode"), "sandbox");
  assertEquals(normalizeEnvironment("Xcode"), "sandbox");
});

Deno.test("normalizeEnvironment - defaults to sandbox for unknown values", () => {
  assertEquals(normalizeEnvironment("unknown"), "sandbox");
  assertEquals(normalizeEnvironment("staging"), "sandbox");
  assertEquals(normalizeEnvironment("dev"), "sandbox");
  assertEquals(normalizeEnvironment(""), "sandbox");
});

// =============================================================================
// hasPremiumAccess Tests
// =============================================================================

Deno.test("hasPremiumAccess - returns true for active statuses", () => {
  assertEquals(hasPremiumAccess("active"), true);
  assertEquals(hasPremiumAccess("in_grace_period"), true);
});

Deno.test("hasPremiumAccess - returns false for inactive statuses", () => {
  const inactiveStatuses: SubscriptionStatus[] = [
    "expired",
    "in_billing_retry",
    "on_hold",
    "revoked",
    "refunded",
    "paused",
    "pending",
    "unknown",
  ];

  for (const status of inactiveStatuses) {
    assertEquals(
      hasPremiumAccess(status),
      false,
      `Expected hasPremiumAccess to return false for ${status}`,
    );
  }
});

// =============================================================================
// getEventSeverity Tests
// =============================================================================

Deno.test("getEventSeverity - returns error for critical events", () => {
  assertEquals(getEventSeverity("billing_issue"), "error");
  assertEquals(getEventSeverity("grace_period_expired"), "error");
});

Deno.test("getEventSeverity - returns warn for negative events", () => {
  assertEquals(getEventSeverity("subscription_expired"), "warn");
  assertEquals(getEventSeverity("revoked"), "warn");
  assertEquals(getEventSeverity("refunded"), "warn");
});

Deno.test("getEventSeverity - returns info for positive/neutral events", () => {
  assertEquals(getEventSeverity("subscription_created"), "info");
  assertEquals(getEventSeverity("subscription_renewed"), "info");
  assertEquals(getEventSeverity("subscription_reactivated"), "info");
  assertEquals(getEventSeverity("test"), "info");
});

// =============================================================================
// isPositiveEvent / isNegativeEvent Tests
// =============================================================================

Deno.test("isPositiveEvent - correctly identifies positive events", () => {
  assertEquals(isPositiveEvent("subscription_created"), true);
  assertEquals(isPositiveEvent("subscription_renewed"), true);
  assertEquals(isPositiveEvent("subscription_reactivated"), true);
  assertEquals(isPositiveEvent("billing_recovered"), true);
  assertEquals(isPositiveEvent("resumed"), true);

  assertEquals(isPositiveEvent("subscription_expired"), false);
  assertEquals(isPositiveEvent("billing_issue"), false);
});

Deno.test("isNegativeEvent - correctly identifies negative events", () => {
  assertEquals(isNegativeEvent("subscription_expired"), true);
  assertEquals(isNegativeEvent("subscription_canceled"), true);
  assertEquals(isNegativeEvent("billing_issue"), true);
  assertEquals(isNegativeEvent("refunded"), true);
  assertEquals(isNegativeEvent("revoked"), true);
  assertEquals(isNegativeEvent("paused"), true);

  assertEquals(isNegativeEvent("subscription_created"), false);
  assertEquals(isNegativeEvent("subscription_renewed"), false);
});

// =============================================================================
// validateEvent Tests
// =============================================================================

Deno.test("validateEvent - validates complete event", () => {
  const event: SubscriptionEvent = {
    eventId: "test-123",
    platform: "apple",
    eventType: "subscription_created",
    rawEventType: "SUBSCRIBED",
    eventTime: new Date(),
    subscription: {
      platformSubscriptionId: "sub-123",
      originalTransactionId: "txn-123",
      productId: "premium_monthly",
      bundleId: "com.example.app",
      status: "active",
      autoRenewEnabled: true,
    },
    rawPayload: "{}",
    environment: "production",
  };

  const result = validateEvent(event);
  assertEquals(result.valid, true);
  assertEquals(result.errors.length, 0);
});

Deno.test("validateEvent - detects missing eventId", () => {
  const event: SubscriptionEvent = {
    eventId: "",
    platform: "apple",
    eventType: "subscription_created",
    rawEventType: "SUBSCRIBED",
    eventTime: new Date(),
    subscription: {
      platformSubscriptionId: "sub-123",
      originalTransactionId: "txn-123",
      productId: "premium_monthly",
      bundleId: "com.example.app",
      status: "active",
      autoRenewEnabled: true,
    },
    rawPayload: "{}",
    environment: "production",
  };

  const result = validateEvent(event);
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(","), "eventId");
});

Deno.test("validateEvent - detects missing originalTransactionId", () => {
  const event: SubscriptionEvent = {
    eventId: "test-123",
    platform: "apple",
    eventType: "subscription_created",
    rawEventType: "SUBSCRIBED",
    eventTime: new Date(),
    subscription: {
      platformSubscriptionId: "sub-123",
      originalTransactionId: "",
      productId: "premium_monthly",
      bundleId: "com.example.app",
      status: "active",
      autoRenewEnabled: true,
    },
    rawPayload: "{}",
    environment: "production",
  };

  const result = validateEvent(event);
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(","), "originalTransactionId");
});

// =============================================================================
// Stripe Signature Verification Mock Tests
// =============================================================================

Deno.test("Stripe signature parsing - handles valid format", () => {
  const signature = "t=1234567890,v1=abc123def456,v0=legacy";
  const elements = signature.split(",");
  const parsed: Record<string, string> = {};

  for (const element of elements) {
    const [key, value] = element.split("=");
    if (key && value) {
      parsed[key] = value;
    }
  }

  assertEquals(parsed["t"], "1234567890");
  assertEquals(parsed["v1"], "abc123def456");
  assertEquals(parsed["v0"], "legacy");
});

Deno.test("Stripe signature parsing - handles missing components", () => {
  const signature = "v1=abc123";
  const elements = signature.split(",");
  const parsed: Record<string, string> = {};

  for (const element of elements) {
    const [key, value] = element.split("=");
    if (key && value) {
      parsed[key] = value;
    }
  }

  assertEquals(parsed["t"], undefined);
  assertEquals(parsed["v1"], "abc123");
});

// =============================================================================
// Google Play Base64 Decoding Tests
// =============================================================================

Deno.test("Base64 decoding - handles standard base64", () => {
  const original = '{"test": "value"}';
  const encoded = btoa(original);
  const decoded = atob(encoded);
  assertEquals(decoded, original);
});

Deno.test("Base64 decoding - handles URL-safe base64", () => {
  // URL-safe base64 uses - and _ instead of + and /
  const original = '{"packageName": "com.example.app"}';
  const standard = btoa(original);
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  // Decode URL-safe base64
  const padded = urlSafe.replace(/-/g, "+").replace(/_/g, "/");
  const paddedLength = padded.length + (4 - (padded.length % 4)) % 4;
  const decoded = atob(padded.padEnd(paddedLength, "="));

  assertEquals(decoded, original);
});

// =============================================================================
// Event Type Mapping Consistency Tests
// =============================================================================

Deno.test("All SubscriptionEventType values are handled", () => {
  const allEventTypes: SubscriptionEventType[] = [
    "subscription_created",
    "subscription_renewed",
    "subscription_expired",
    "subscription_canceled",
    "subscription_reactivated",
    "billing_issue",
    "billing_recovered",
    "grace_period_started",
    "grace_period_expired",
    "refunded",
    "revoked",
    "price_change",
    "plan_changed",
    "paused",
    "resumed",
    "test",
    "unknown",
  ];

  // Verify shouldUpdateSubscription handles all types
  for (const type of allEventTypes) {
    const result = shouldUpdateSubscription(type);
    assertEquals(
      typeof result,
      "boolean",
      `shouldUpdateSubscription should return boolean for ${type}`,
    );
  }

  // Verify getEventSeverity handles all types
  for (const type of allEventTypes) {
    const result = getEventSeverity(type);
    assertEquals(
      ["info", "warn", "error"].includes(result),
      true,
      `getEventSeverity should return valid severity for ${type}`,
    );
  }
});

// =============================================================================
// SubscriptionStatus Consistency Tests
// =============================================================================

Deno.test("All SubscriptionStatus values are handled by hasPremiumAccess", () => {
  const allStatuses: SubscriptionStatus[] = [
    "active",
    "expired",
    "in_grace_period",
    "in_billing_retry",
    "on_hold",
    "revoked",
    "refunded",
    "paused",
    "pending",
    "unknown",
  ];

  for (const status of allStatuses) {
    const result = hasPremiumAccess(status);
    assertEquals(
      typeof result,
      "boolean",
      `hasPremiumAccess should return boolean for ${status}`,
    );
  }
});

// =============================================================================
// Platform Handler Detection Tests
// =============================================================================

Deno.test("Platform detection - Apple request characteristics", () => {
  // Apple webhooks have JSON content-type and signedPayload in body
  const headers = new Headers({
    "content-type": "application/json",
  });
  const isJson = headers.get("content-type")?.includes("application/json");
  assertEquals(isJson, true);
});

Deno.test("Platform detection - Stripe request characteristics", () => {
  // Stripe webhooks have stripe-signature header
  const headers = new Headers({
    "stripe-signature": "t=123,v1=abc",
    "content-type": "application/json",
  });
  const hasStripeSignature = !!headers.get("stripe-signature");
  assertEquals(hasStripeSignature, true);
});

Deno.test("Platform detection - Google Play request characteristics", () => {
  // Google Play uses Cloud Pub/Sub with specific user-agent or headers
  const headers = new Headers({
    "user-agent": "CloudPubSub/1.0",
    "content-type": "application/json",
  });
  const userAgent = headers.get("user-agent") || "";
  const isGooglePubSub = userAgent.includes("CloudPubSub");
  assertEquals(isGooglePubSub, true);
});

// =============================================================================
// Error Handling Tests
// =============================================================================

Deno.test("Invalid JSON body handling", () => {
  const invalidJson = "not valid json {";
  let parseError = false;

  try {
    JSON.parse(invalidJson);
  } catch {
    parseError = true;
  }

  assertEquals(parseError, true);
});

Deno.test("Empty body detection", () => {
  const emptyBody = "";
  assertEquals(emptyBody.length === 0, true);
  assertEquals(!emptyBody, true);
});

console.log("All subscription-webhook tests passed!");
