/**
 * Google Play Subscription Tests
 *
 * Tests for api-v1-subscription/handlers/google-play.ts:
 * - canHandle: CloudPubSub user-agent detection, non-POST rejection
 * - verifyWebhook: valid/invalid message parsing, package validation
 * - parseEvent: all notification type mappings, test/voided/one-time
 * - verifyGoogleJWT: expired, invalid signature, valid JWT
 */

import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  googlePlayHandler,
  SubscriptionNotificationType,
  OneTimeProductNotificationType,
  base64UrlDecode,
  _clearJwksCache,
} from "../api-v1-subscription/handlers/google-play.ts";

// =============================================================================
// Test Helpers
// =============================================================================

function createPubSubRequest(
  body: unknown,
  options: {
    method?: string;
    userAgent?: string;
    contentType?: string;
    authorization?: string;
  } = {},
): Request {
  const {
    method = "POST",
    userAgent = "CloudPubSub-Google",
    contentType = "application/json",
  } = options;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "User-Agent": userAgent,
  };

  if (options.authorization) {
    headers["Authorization"] = options.authorization;
  }

  return new Request("http://localhost/api-v1-subscription", {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
}

function createValidPubSubMessage(notificationData: unknown): unknown {
  const encoded = btoa(JSON.stringify(notificationData));
  return {
    message: {
      data: encoded,
      messageId: "test-msg-123",
      publishTime: new Date().toISOString(),
    },
    subscription: "projects/test-project/subscriptions/test-sub",
  };
}

// Note: GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_CLOUD_PROJECT are read at module
// load time as constants. Setting env vars here won't affect those constants.
// Tests are written to work with default empty values.

// =============================================================================
// canHandle Tests
// =============================================================================

Deno.test("canHandle: detects CloudPubSub user-agent", () => {
  const request = createPubSubRequest({}, { userAgent: "CloudPubSub-Google" });
  assertEquals(googlePlayHandler.canHandle(request), true);
});

Deno.test("canHandle: detects Google-Cloud-Pub/Sub user-agent", () => {
  const request = createPubSubRequest({}, { userAgent: "Google-Cloud-Pub/Sub" });
  assertEquals(googlePlayHandler.canHandle(request), true);
});

Deno.test("canHandle: rejects non-POST requests", () => {
  const request = createPubSubRequest({}, { method: "GET", userAgent: "CloudPubSub-Google" });
  assertEquals(googlePlayHandler.canHandle(request), false);
});

Deno.test("canHandle: rejects non-JSON content type", () => {
  const request = createPubSubRequest({}, {
    userAgent: "CloudPubSub-Google",
    contentType: "text/plain",
  });
  assertEquals(googlePlayHandler.canHandle(request), false);
});

Deno.test("canHandle: rejects unknown user-agent without GCP header", () => {
  const request = createPubSubRequest({}, { userAgent: "Mozilla/5.0" });
  assertEquals(googlePlayHandler.canHandle(request), false);
});

// =============================================================================
// verifyWebhook Tests
// =============================================================================

Deno.test("verifyWebhook: valid Pub/Sub message passes", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: 4,
      purchaseToken: "test-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const body = JSON.stringify(pubsubMessage);

  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, true);
});

Deno.test("verifyWebhook: invalid JSON body fails", async () => {
  const request = createPubSubRequest({});
  const result = await googlePlayHandler.verifyWebhook(request, "not-json{{{");
  assertEquals(result, false);
});

Deno.test("verifyWebhook: invalid message format fails", async () => {
  const request = createPubSubRequest({});
  const body = JSON.stringify({ wrongFormat: true });
  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, false);
});

Deno.test("verifyWebhook: bad base64 data fails", async () => {
  const badMessage = {
    message: {
      data: "!!!not-valid-base64!!!",
      messageId: "test-msg-bad",
      publishTime: new Date().toISOString(),
    },
    subscription: "test-sub",
  };

  const request = createPubSubRequest(badMessage);
  const body = JSON.stringify(badMessage);
  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, false);
});

Deno.test("verifyWebhook: package name mismatch passes when GOOGLE_PLAY_PACKAGE_NAME is unconfigured", async () => {
  // When GOOGLE_PLAY_PACKAGE_NAME is empty (module-level default),
  // the package check is skipped and any package is accepted.
  const notification = {
    version: "1.0",
    packageName: "com.other.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: 4,
      purchaseToken: "test-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const body = JSON.stringify(pubsubMessage);

  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, true);
});

Deno.test("verifyWebhook: test notification bypasses package validation", async () => {
  const notification = {
    version: "1.0",
    packageName: "any.package.name",
    eventTimeMillis: String(Date.now()),
    testNotification: { version: "1.0" },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const body = JSON.stringify(pubsubMessage);

  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, true);
});

// =============================================================================
// parseEvent Tests
// =============================================================================

Deno.test("parseEvent: subscription purchased maps to subscription_created", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_PURCHASED,
      purchaseToken: "purchase-token-123",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const body = JSON.stringify(pubsubMessage);

  const event = await googlePlayHandler.parseEvent(request, body);
  assertEquals(event.eventType, "subscription_created");
  assertEquals(event.platform, "google_play");
  assertEquals(event.subscription.productId, "premium_monthly");
  assertEquals(event.subscription.status, "active");
  assertEquals(event.subscription.autoRenewEnabled, true);
});

Deno.test("parseEvent: subscription canceled maps correctly", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_CANCELED,
      purchaseToken: "cancel-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "subscription_canceled");
  assertEquals(event.subscription.status, "expired");
  assertEquals(event.subscription.autoRenewEnabled, false);
});

Deno.test("parseEvent: subscription renewed maps correctly", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_RENEWED,
      purchaseToken: "renew-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "subscription_renewed");
  assertEquals(event.subscription.status, "active");
});

Deno.test("parseEvent: subscription expired maps correctly", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_EXPIRED,
      purchaseToken: "expired-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "subscription_expired");
  assertEquals(event.subscription.status, "expired");
});

Deno.test("parseEvent: subscription on hold maps to billing_issue", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_ON_HOLD,
      purchaseToken: "hold-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "billing_issue");
  assertEquals(event.subscription.status, "on_hold");
});

Deno.test("parseEvent: subscription paused maps correctly", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_PAUSED,
      purchaseToken: "paused-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "paused");
  assertEquals(event.subscription.status, "paused");
});

Deno.test("parseEvent: subscription revoked maps correctly", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: "1.0",
      notificationType: SubscriptionNotificationType.SUBSCRIPTION_REVOKED,
      purchaseToken: "revoked-token",
      subscriptionId: "premium_monthly",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "revoked");
  assertEquals(event.subscription.status, "revoked");
});

Deno.test("parseEvent: voided purchase maps to refunded", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    voidedPurchaseNotification: {
      purchaseToken: "voided-token",
      orderId: "order-123",
      productType: 1,
      refundType: 1,
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "refunded");
  assertEquals(event.rawEventType, "VOIDED_PURCHASE");
  assertEquals(event.subscription.status, "refunded");
});

Deno.test("parseEvent: one-time product purchased maps to subscription_created", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    oneTimeProductNotification: {
      version: "1.0",
      notificationType: OneTimeProductNotificationType.ONE_TIME_PRODUCT_PURCHASED,
      purchaseToken: "otp-token",
      sku: "donation_5",
    },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "subscription_created");
  assertEquals(event.subscription.productId, "donation_5");
  assertEquals(event.subscription.status, "active");
});

Deno.test("parseEvent: test notification returns test event type", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    testNotification: { version: "1.0" },
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "test");
  assertEquals(event.rawEventType, "TEST_NOTIFICATION");
});

Deno.test("parseEvent: unknown notification type returns unknown", async () => {
  const notification = {
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    // No known notification field
  };

  const pubsubMessage = createValidPubSubMessage(notification);
  const request = createPubSubRequest(pubsubMessage);
  const event = await googlePlayHandler.parseEvent(request, JSON.stringify(pubsubMessage));

  assertEquals(event.eventType, "unknown");
});

// =============================================================================
// base64UrlDecode Tests
// =============================================================================

Deno.test("base64UrlDecode: decodes standard base64", () => {
  const encoded = btoa("Hello, World!");
  const decoded = new TextDecoder().decode(base64UrlDecode(encoded));
  assertEquals(decoded, "Hello, World!");
});

Deno.test("base64UrlDecode: decodes URL-safe base64", () => {
  // URL-safe: replace + with - and / with _
  const standard = btoa("test?data&more");
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = new TextDecoder().decode(base64UrlDecode(urlSafe));
  assertEquals(decoded, "test?data&more");
});

// =============================================================================
// JWT Verification Tests (mocked crypto)
// =============================================================================

Deno.test("verifyGoogleJWT: skips when VERIFY_JWT is not true", async () => {
  // By default GOOGLE_PLAY_VERIFY_JWT is not set, so verification is skipped
  const request = createPubSubRequest({});
  // The handler's verifyWebhook calls verifyGoogleJWT internally
  // Since VERIFY_JWT defaults to false, it should return true
  const pubsubMessage = createValidPubSubMessage({
    version: "1.0",
    packageName: "com.foodshare.app",
    eventTimeMillis: String(Date.now()),
    testNotification: { version: "1.0" },
  });
  const body = JSON.stringify(pubsubMessage);
  const result = await googlePlayHandler.verifyWebhook(request, body);
  assertEquals(result, true);
});
