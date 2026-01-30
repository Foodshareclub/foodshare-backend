/**
 * Stripe Webhook Handler - Production Grade
 *
 * Handles Stripe webhook events for web subscriptions.
 *
 * Features:
 * - HMAC signature verification with timing-safe comparison
 * - Replay attack prevention with timestamp validation
 * - Comprehensive event type mapping
 * - Support for subscription, invoice, and charge events
 * - Structured logging with full context
 * - Performance tracking
 *
 * @see https://stripe.com/docs/webhooks
 * @see https://stripe.com/docs/billing/subscriptions/webhooks
 */

import {
  PlatformHandler,
  SubscriptionEvent,
  SubscriptionEventType,
  SubscriptionData,
  SubscriptionStatus,
} from "../../_shared/subscriptions/types.ts";
import { logger } from "../../_shared/logger.ts";
import { measureAsync, PerformanceTimer } from "../../_shared/performance.ts";

// =============================================================================
// Configuration
// =============================================================================

const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// =============================================================================
// Stripe Event Types
// =============================================================================

type StripeSubscriptionEventType =
  | "customer.subscription.created"
  | "customer.subscription.updated"
  | "customer.subscription.deleted"
  | "customer.subscription.trial_will_end"
  | "customer.subscription.paused"
  | "customer.subscription.resumed"
  | "customer.subscription.pending_update_applied"
  | "customer.subscription.pending_update_expired"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "invoice.payment_action_required"
  | "invoice.finalized"
  | "invoice.upcoming"
  | "charge.refunded"
  | "charge.dispute.created"
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed";

type StripeSubscriptionStatus =
  | "active"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

// =============================================================================
// Stripe Webhook Event Structure
// =============================================================================

interface StripeWebhookEvent {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  data: {
    object: StripeSubscription | StripeInvoice | StripeCharge;
    previous_attributes?: Record<string, unknown>;
  };
  livemode: boolean;
  pending_webhooks: number;
  type: string;
  request?: {
    id: string | null;
    idempotency_key: string | null;
  };
}

interface StripeSubscription {
  id: string;
  object: "subscription";
  customer: string;
  status: StripeSubscriptionStatus;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  items: {
    data: Array<{
      id: string;
      price: {
        id: string;
        product: string;
        unit_amount: number;
        currency: string;
        recurring?: {
          interval: string;
          interval_count: number;
        };
      };
      quantity: number;
    }>;
  };
  metadata: Record<string, string>;
  default_payment_method?: string;
  latest_invoice?: string;
  start_date: number;
}

interface StripeInvoice {
  id: string;
  object: "invoice";
  customer: string;
  subscription: string | null;
  status: string;
  amount_paid: number;
  amount_due: number;
  amount_remaining: number;
  currency: string;
  paid: boolean;
  payment_intent?: string;
  billing_reason?: string;
  period_start: number;
  period_end: number;
}

interface StripeCharge {
  id: string;
  object: "charge";
  customer: string | null;
  refunded: boolean;
  amount_refunded: number;
  amount: number;
  currency: string;
  payment_intent?: string;
  invoice?: string;
}

// =============================================================================
// Event Type Mapping
// =============================================================================

const EVENT_TYPE_MAP: Record<string, SubscriptionEventType> = {
  "customer.subscription.created": "subscription_created",
  "customer.subscription.updated": "plan_changed",
  "customer.subscription.deleted": "subscription_expired",
  "customer.subscription.paused": "paused",
  "customer.subscription.resumed": "resumed",
  "customer.subscription.trial_will_end": "unknown",
  "customer.subscription.pending_update_applied": "plan_changed",
  "customer.subscription.pending_update_expired": "unknown",
  "invoice.paid": "subscription_renewed",
  "invoice.payment_failed": "billing_issue",
  "invoice.payment_action_required": "billing_issue",
  "invoice.finalized": "unknown",
  "invoice.upcoming": "unknown",
  "charge.refunded": "refunded",
  "charge.dispute.created": "billing_issue",
  "payment_intent.succeeded": "unknown",
  "payment_intent.payment_failed": "billing_issue",
};

function mapStripeEventType(type: string): SubscriptionEventType {
  return EVENT_TYPE_MAP[type] || "unknown";
}

const STATUS_MAP: Record<StripeSubscriptionStatus, SubscriptionStatus> = {
  "active": "active",
  "trialing": "active",
  "past_due": "in_billing_retry",
  "paused": "paused",
  "canceled": "expired",
  "incomplete_expired": "expired",
  "unpaid": "in_billing_retry",
  "incomplete": "pending",
};

function mapStripeStatus(status: StripeSubscriptionStatus): SubscriptionStatus {
  return STATUS_MAP[status] || "unknown";
}

// =============================================================================
// Signature Verification
// =============================================================================

async function computeHmacSignature(
  payload: string,
  timestamp: string,
  secret: string
): Promise<string> {
  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedPayload)
  );

  return Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  secret: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!signatureHeader || !secret) {
    return { valid: false, reason: "missing_signature_or_secret" };
  }

  // Parse the signature header
  const elements = signatureHeader.split(",");
  const signatureElements: Record<string, string> = {};

  for (const element of elements) {
    const [key, value] = element.split("=");
    if (key && value) {
      signatureElements[key] = value;
    }
  }

  const timestamp = signatureElements["t"];
  const v1Signature = signatureElements["v1"];

  if (!timestamp || !v1Signature) {
    return { valid: false, reason: "invalid_signature_format" };
  }

  // Check timestamp to prevent replay attacks
  const timestampSeconds = parseInt(timestamp, 10);
  const currentSeconds = Math.floor(Date.now() / 1000);
  const timeDiff = Math.abs(currentSeconds - timestampSeconds);

  if (timeDiff > TIMESTAMP_TOLERANCE_SECONDS) {
    logger.warn("Stripe webhook timestamp outside tolerance", {
      timestampSeconds,
      currentSeconds,
      timeDiff,
      tolerance: TIMESTAMP_TOLERANCE_SECONDS,
    });
    return { valid: false, reason: "timestamp_expired" };
  }

  // Compute expected signature
  const expectedSignature = await computeHmacSignature(payload, timestamp, secret);

  // Constant-time comparison
  if (!timingSafeEqual(expectedSignature, v1Signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

// =============================================================================
// Event Parsing Helpers
// =============================================================================

function parseSubscriptionEvent(
  stripeEvent: StripeWebhookEvent,
  sub: StripeSubscription,
  body: string
): SubscriptionEvent {
  const priceItem = sub.items.data[0];

  const subscription: SubscriptionData = {
    platformSubscriptionId: sub.id,
    originalTransactionId: sub.id,
    productId: priceItem?.price.product || "",
    bundleId: "web",
    status: mapStripeStatus(sub.status),
    purchaseDate: new Date(sub.current_period_start * 1000),
    originalPurchaseDate: new Date(sub.start_date * 1000),
    expiresDate: new Date(sub.current_period_end * 1000),
    autoRenewEnabled: !sub.cancel_at_period_end,
    autoRenewProductId: priceItem?.price.id,
    appUserId: sub.metadata?.user_id || sub.metadata?.userId,
    priceAmount: priceItem?.price.unit_amount,
    priceCurrency: priceItem?.price.currency,
  };

  // Detect specific status changes
  let eventType = mapStripeEventType(stripeEvent.type);
  if (stripeEvent.type === "customer.subscription.updated") {
    const prevAttrs = stripeEvent.data.previous_attributes as Record<string, unknown> | undefined;

    // Check for specific changes
    if (prevAttrs?.cancel_at_period_end !== undefined) {
      eventType = sub.cancel_at_period_end ? "subscription_canceled" : "subscription_reactivated";
    } else if (prevAttrs?.status !== undefined) {
      // Status changed - use current status to determine event type
      if (sub.status === "active" && prevAttrs.status !== "active") {
        eventType = "subscription_reactivated";
      } else if (sub.status === "past_due") {
        eventType = "billing_issue";
      } else if (sub.status === "canceled" || sub.status === "unpaid") {
        eventType = "subscription_expired";
      }
    } else if (prevAttrs?.items !== undefined) {
      eventType = "plan_changed";
    }
  }

  return {
    eventId: stripeEvent.id,
    platform: "stripe",
    eventType,
    rawEventType: stripeEvent.type,
    eventTime: new Date(stripeEvent.created * 1000),
    subscription,
    rawPayload: body,
    environment: stripeEvent.livemode ? "production" : "sandbox",
  };
}

function parseInvoiceEvent(
  stripeEvent: StripeWebhookEvent,
  invoice: StripeInvoice,
  body: string
): SubscriptionEvent {
  const subscription: SubscriptionData = {
    platformSubscriptionId: invoice.subscription || invoice.id,
    originalTransactionId: invoice.subscription || invoice.id,
    productId: "",
    bundleId: "web",
    status: invoice.paid ? "active" : "in_billing_retry",
    purchaseDate: new Date(invoice.period_start * 1000),
    expiresDate: new Date(invoice.period_end * 1000),
    autoRenewEnabled: true,
    priceAmount: invoice.amount_paid || invoice.amount_due,
    priceCurrency: invoice.currency,
  };

  return {
    eventId: stripeEvent.id,
    platform: "stripe",
    eventType: mapStripeEventType(stripeEvent.type),
    rawEventType: stripeEvent.type,
    eventTime: new Date(stripeEvent.created * 1000),
    subscription,
    rawPayload: body,
    environment: stripeEvent.livemode ? "production" : "sandbox",
  };
}

function parseChargeEvent(
  stripeEvent: StripeWebhookEvent,
  charge: StripeCharge,
  body: string
): SubscriptionEvent {
  const subscription: SubscriptionData = {
    platformSubscriptionId: charge.invoice || charge.id,
    originalTransactionId: charge.invoice || charge.id,
    productId: "",
    bundleId: "web",
    status: charge.refunded ? "refunded" : "active",
    autoRenewEnabled: false,
    priceAmount: charge.refunded ? charge.amount_refunded : charge.amount,
    priceCurrency: charge.currency,
  };

  return {
    eventId: stripeEvent.id,
    platform: "stripe",
    eventType: mapStripeEventType(stripeEvent.type),
    rawEventType: stripeEvent.type,
    eventTime: new Date(stripeEvent.created * 1000),
    subscription,
    rawPayload: body,
    environment: stripeEvent.livemode ? "production" : "sandbox",
  };
}

// =============================================================================
// Stripe Handler Implementation
// =============================================================================

export const stripeHandler: PlatformHandler = {
  platform: "stripe",

  canHandle(request: Request): boolean {
    const signature = request.headers.get("stripe-signature");
    return request.method === "POST" && !!signature;
  },

  async verifyWebhook(request: Request, body: string): Promise<boolean> {
    const timer = new PerformanceTimer("stripe.verify_webhook");
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
      timer.end({ success: false, reason: "no_signature" });
      logger.warn("Missing Stripe-Signature header");
      return false;
    }

    if (!STRIPE_WEBHOOK_SECRET) {
      timer.end({ success: false, reason: "no_secret" });
      logger.error("STRIPE_WEBHOOK_SECRET not configured");
      return false;
    }

    const result = await measureAsync(
      "stripe.verify_signature",
      async () => verifyStripeSignature(body, signature, STRIPE_WEBHOOK_SECRET),
      {}
    );

    if (!result.valid) {
      timer.end({ success: false, reason: result.reason });
      logger.warn("Stripe webhook verification failed", { reason: result.reason });
      return false;
    }

    timer.end({ success: true });
    return true;
  },

  async parseEvent(_request: Request, body: string): Promise<SubscriptionEvent> {
    const timer = new PerformanceTimer("stripe.parse_event");

    const stripeEvent: StripeWebhookEvent = JSON.parse(body);

    logger.info("Stripe event received", {
      id: stripeEvent.id,
      type: stripeEvent.type,
      livemode: stripeEvent.livemode,
      apiVersion: stripeEvent.api_version,
    });

    let event: SubscriptionEvent;
    const dataObject = stripeEvent.data.object;

    if (dataObject.object === "subscription") {
      event = parseSubscriptionEvent(stripeEvent, dataObject as StripeSubscription, body);
    } else if (dataObject.object === "invoice") {
      event = parseInvoiceEvent(stripeEvent, dataObject as StripeInvoice, body);
    } else if (dataObject.object === "charge") {
      event = parseChargeEvent(stripeEvent, dataObject as StripeCharge, body);
    } else {
      // Unknown object type - create minimal event
      event = {
        eventId: stripeEvent.id,
        platform: "stripe",
        eventType: "unknown",
        rawEventType: stripeEvent.type,
        eventTime: new Date(stripeEvent.created * 1000),
        subscription: {
          platformSubscriptionId: "",
          originalTransactionId: "",
          productId: "",
          bundleId: "web",
          status: "unknown",
          autoRenewEnabled: false,
        },
        rawPayload: body,
        environment: stripeEvent.livemode ? "production" : "sandbox",
      };

      logger.warn("Unknown Stripe object type", {
        objectType: dataObject.object,
        eventType: stripeEvent.type,
      });
    }

    timer.end({
      eventType: event.eventType,
      objectType: dataObject.object,
      status: event.subscription.status,
    });

    logger.info("Stripe event parsed", {
      eventId: event.eventId,
      eventType: event.eventType,
      rawEventType: stripeEvent.type,
      status: event.subscription.status,
      subscriptionId: event.subscription.platformSubscriptionId,
    });

    return event;
  },
};

export default stripeHandler;
