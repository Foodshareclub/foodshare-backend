/**
 * Apple App Store Webhook Handler - Production Grade
 *
 * Handles App Store Server Notifications V2 from Apple.
 * Verifies JWS signatures and normalizes events to common format.
 *
 * Features:
 * - JWS signature verification with certificate chain validation
 * - Graceful degradation on partial verification failures
 * - Comprehensive event type mapping
 * - Structured logging with full context
 * - Performance tracking for verification operations
 */

import { verifyAppleJWS, decodeJWS } from "../../_shared/subscriptions/apple-jws.ts";
import {
  ResponseBodyV2DecodedPayload,
  JWSTransactionDecodedPayload,
  JWSRenewalInfoDecodedPayload,
  mapNotificationToStatus,
  parseAppAccountToken,
  NotificationType,
  NotificationSubtype,
} from "../../_shared/subscriptions/apple-notifications.ts";
import {
  PlatformHandler,
  SubscriptionEvent,
  SubscriptionEventType,
  SubscriptionData,
  SubscriptionStatus,
  normalizeEnvironment,
} from "../../_shared/subscriptions/types.ts";
import { logger } from "../../_shared/logger.ts";
import { measureAsync, PerformanceTimer } from "../../_shared/performance.ts";

// =============================================================================
// Configuration
// =============================================================================

const APP_BUNDLE_ID = Deno.env.get("APP_BUNDLE_ID") || "com.flutterflow.foodshare";
const STRICT_VERIFICATION = Deno.env.get("APPLE_STRICT_VERIFICATION") !== "false";

// Cache verified payloads to avoid re-verification in parseEvent
const verifiedPayloadCache = new Map<string, ResponseBodyV2DecodedPayload>();
const CACHE_TTL_MS = 30000; // 30 seconds

// =============================================================================
// Event Type Mapping
// =============================================================================

const EVENT_TYPE_MAP: Record<NotificationType, SubscriptionEventType | ((subtype?: NotificationSubtype) => SubscriptionEventType)> = {
  "SUBSCRIBED": (subtype) => subtype === "RESUBSCRIBE" ? "subscription_reactivated" : "subscription_created",
  "DID_RENEW": (subtype) => subtype === "BILLING_RECOVERY" ? "billing_recovered" : "subscription_renewed",
  "DID_FAIL_TO_RENEW": () => "billing_issue",
  "GRACE_PERIOD_EXPIRED": () => "grace_period_expired",
  "EXPIRED": () => "subscription_expired",
  "REFUND": () => "refunded",
  "REVOKE": () => "revoked",
  "DID_CHANGE_RENEWAL_STATUS": (subtype) => subtype === "AUTO_RENEW_DISABLED" ? "subscription_canceled" : "subscription_reactivated",
  "DID_CHANGE_RENEWAL_PREF": () => "plan_changed",
  "OFFER_REDEEMED": () => "subscription_created",
  "RENEWAL_EXTENDED": () => "subscription_renewed",
  "RENEWAL_EXTENSION": () => "subscription_renewed",
  "PRICE_INCREASE": () => "price_change",
  "REFUND_DECLINED": () => "subscription_reactivated",
  "REFUND_REVERSED": () => "subscription_reactivated",
  "TEST": () => "test",
  "CONSUMPTION_REQUEST": () => "unknown",
  "ONE_TIME_CHARGE": () => "unknown",
  "EXTERNAL_PURCHASE_TOKEN": () => "unknown",
};

function mapAppleEventType(
  notificationType: NotificationType,
  subtype?: NotificationSubtype
): SubscriptionEventType {
  const mapping = EVENT_TYPE_MAP[notificationType];

  if (!mapping) {
    logger.warn("Unknown Apple notification type", { notificationType, subtype });
    return "unknown";
  }

  if (typeof mapping === "function") {
    return mapping(subtype);
  }

  return mapping;
}

function mapAppleStatus(
  notificationType: NotificationType,
  subtype?: NotificationSubtype,
  renewalInfo?: JWSRenewalInfoDecodedPayload
): SubscriptionStatus {
  return mapNotificationToStatus(notificationType, subtype, renewalInfo);
}

// =============================================================================
// Cache Management
// =============================================================================

function getCachedPayload(signedPayload: string): ResponseBodyV2DecodedPayload | null {
  const cached = verifiedPayloadCache.get(signedPayload);
  if (cached) {
    return cached;
  }
  return null;
}

function cachePayload(signedPayload: string, payload: ResponseBodyV2DecodedPayload): void {
  verifiedPayloadCache.set(signedPayload, payload);

  // Clean old entries
  setTimeout(() => {
    verifiedPayloadCache.delete(signedPayload);
  }, CACHE_TTL_MS);

  // Limit cache size
  if (verifiedPayloadCache.size > 100) {
    const firstKey = verifiedPayloadCache.keys().next().value;
    if (firstKey) {
      verifiedPayloadCache.delete(firstKey);
    }
  }
}

// =============================================================================
// JWS Verification Helpers
// =============================================================================

async function verifyAndDecodePayload(
  signedPayload: string,
  context: Record<string, unknown> = {}
): Promise<ResponseBodyV2DecodedPayload> {
  return await measureAsync(
    "apple.verify_jws",
    async () => {
      const result = await verifyAppleJWS<ResponseBodyV2DecodedPayload>(signedPayload);
      return result;
    },
    context
  );
}

async function verifyNestedJWS<T>(
  signedData: string,
  name: string,
  context: Record<string, unknown> = {}
): Promise<T | null> {
  try {
    return await measureAsync(
      `apple.verify_${name}`,
      async () => await verifyAppleJWS<T>(signedData),
      context
    );
  } catch (error) {
    logger.warn(`Failed to verify Apple ${name}`, {
      error: error instanceof Error ? error.message : String(error),
      ...context,
    });

    // Fall back to unverified decode for data extraction
    if (!STRICT_VERIFICATION) {
      try {
        const decoded = decodeJWS<T>(signedData);
        logger.info(`Using unverified ${name} data`, context);
        return decoded.payload;
      } catch {
        return null;
      }
    }

    return null;
  }
}

// =============================================================================
// Apple Handler Implementation
// =============================================================================

export const appleHandler: PlatformHandler = {
  platform: "apple",

  canHandle(_request: Request): boolean {
    // Apple webhooks don't have distinctive headers
    // Detection is done via body structure (signedPayload) in index.ts
    // Return false to let specific handlers (Stripe, Google Play) check first
    return false;
  },

  async verifyWebhook(_request: Request, body: string): Promise<boolean> {
    const timer = new PerformanceTimer("apple.verify_webhook");

    try {
      const payload = JSON.parse(body);

      if (!payload.signedPayload) {
        logger.warn("Apple webhook: No signedPayload in body");
        return false;
      }

      // Verify the JWS signature
      const verified = await verifyAndDecodePayload(payload.signedPayload);

      // Validate bundle ID
      if (verified.data.bundleId !== APP_BUNDLE_ID) {
        logger.warn("Apple webhook: Bundle ID mismatch", {
          expected: APP_BUNDLE_ID,
          received: verified.data.bundleId,
        });
        return false;
      }

      // Cache for use in parseEvent
      cachePayload(payload.signedPayload, verified);

      timer.end({ success: true, bundleId: verified.data.bundleId });
      return true;

    } catch (error) {
      timer.end({ success: false, error: error instanceof Error ? error.message : String(error) });
      logger.error("Apple webhook verification failed", error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  },

  async parseEvent(_request: Request, body: string): Promise<SubscriptionEvent> {
    const timer = new PerformanceTimer("apple.parse_event");

    const payload = JSON.parse(body);
    const signedPayload = payload.signedPayload;

    // Try to use cached verified payload
    let decodedPayload = getCachedPayload(signedPayload);

    if (!decodedPayload) {
      // Re-verify if not cached (shouldn't happen in normal flow)
      decodedPayload = await verifyAndDecodePayload(signedPayload);
    }

    const notificationType = decodedPayload.notificationType;
    const subtype = decodedPayload.subtype;

    const context = {
      notificationType,
      subtype,
      notificationUUID: decodedPayload.notificationUUID,
    };

    // Decode transaction info
    let transactionInfo: JWSTransactionDecodedPayload | undefined;
    if (decodedPayload.data.signedTransactionInfo) {
      transactionInfo = await verifyNestedJWS<JWSTransactionDecodedPayload>(
        decodedPayload.data.signedTransactionInfo,
        "transaction_info",
        context
      ) ?? undefined;
    }

    // Decode renewal info
    let renewalInfo: JWSRenewalInfoDecodedPayload | undefined;
    if (decodedPayload.data.signedRenewalInfo) {
      renewalInfo = await verifyNestedJWS<JWSRenewalInfoDecodedPayload>(
        decodedPayload.data.signedRenewalInfo,
        "renewal_info",
        context
      ) ?? undefined;
    }

    // Build normalized subscription data
    const subscription: SubscriptionData = {
      platformSubscriptionId: transactionInfo?.transactionId?.toString() || "",
      originalTransactionId: transactionInfo?.originalTransactionId?.toString() || "",
      productId: transactionInfo?.productId || "",
      bundleId: decodedPayload.data.bundleId,
      status: mapAppleStatus(notificationType, subtype, renewalInfo),
      purchaseDate: transactionInfo?.purchaseDate
        ? new Date(transactionInfo.purchaseDate)
        : undefined,
      originalPurchaseDate: transactionInfo?.originalPurchaseDate
        ? new Date(transactionInfo.originalPurchaseDate)
        : undefined,
      expiresDate: transactionInfo?.expiresDate
        ? new Date(transactionInfo.expiresDate)
        : undefined,
      autoRenewEnabled: renewalInfo?.autoRenewStatus === 1,
      autoRenewProductId: renewalInfo?.autoRenewProductId,
      appUserId: parseAppAccountToken(transactionInfo?.appAccountToken) || undefined,
      gracePeriodExpiresDate: renewalInfo?.gracePeriodExpiresDate
        ? new Date(renewalInfo.gracePeriodExpiresDate)
        : undefined,
      priceAmount: transactionInfo?.price,
      priceCurrency: transactionInfo?.currency,
      countryCode: transactionInfo?.storefront,
    };

    // Build normalized event
    const event: SubscriptionEvent = {
      eventId: decodedPayload.notificationUUID,
      platform: "apple",
      eventType: mapAppleEventType(notificationType, subtype),
      rawEventType: notificationType,
      rawSubtype: subtype,
      eventTime: decodedPayload.signedDate
        ? new Date(decodedPayload.signedDate)
        : new Date(),
      subscription,
      rawPayload: signedPayload,
      environment: normalizeEnvironment(decodedPayload.data.environment),
    };

    timer.end({
      eventType: event.eventType,
      productId: subscription.productId,
      status: subscription.status,
    });

    logger.info("Apple event parsed", {
      eventId: event.eventId,
      eventType: event.eventType,
      rawEventType: notificationType,
      subtype,
      productId: subscription.productId,
      status: subscription.status,
      hasTransactionInfo: !!transactionInfo,
      hasRenewalInfo: !!renewalInfo,
    });

    return event;
  },
};

export default appleHandler;
