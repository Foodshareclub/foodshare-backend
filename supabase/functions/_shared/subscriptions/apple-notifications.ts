/**
 * Apple App Store Server Notifications V2 Types
 *
 * TypeScript types for App Store Server Notifications V2.
 * These match Apple's documented JSON payload structures.
 *
 * @see https://developer.apple.com/documentation/appstoreservernotifications
 */

// =============================================================================
// Notification Types
// =============================================================================

/**
 * All possible V2 notification types from Apple
 */
export type NotificationType =
  | "CONSUMPTION_REQUEST"
  | "DID_CHANGE_RENEWAL_PREF"
  | "DID_CHANGE_RENEWAL_STATUS"
  | "DID_FAIL_TO_RENEW"
  | "DID_RENEW"
  | "EXPIRED"
  | "EXTERNAL_PURCHASE_TOKEN"
  | "GRACE_PERIOD_EXPIRED"
  | "OFFER_REDEEMED"
  | "PRICE_INCREASE"
  | "REFUND"
  | "REFUND_DECLINED"
  | "REFUND_REVERSED"
  | "RENEWAL_EXTENDED"
  | "RENEWAL_EXTENSION"
  | "REVOKE"
  | "SUBSCRIBED"
  | "TEST";

/**
 * Subtypes provide additional context for certain notification types
 */
export type NotificationSubtype =
  | "INITIAL_BUY" // SUBSCRIBED: First-time subscription
  | "RESUBSCRIBE" // SUBSCRIBED: Reactivation after expiration
  | "DOWNGRADE" // DID_CHANGE_RENEWAL_PREF: Switching to cheaper plan
  | "UPGRADE" // DID_CHANGE_RENEWAL_PREF: Switching to premium plan
  | "AUTO_RENEW_ENABLED" // DID_CHANGE_RENEWAL_STATUS: User re-enabled auto-renew
  | "AUTO_RENEW_DISABLED" // DID_CHANGE_RENEWAL_STATUS: User disabled auto-renew
  | "VOLUNTARY" // EXPIRED: User intentionally let subscription expire
  | "BILLING_RETRY" // EXPIRED: Expired during billing retry period
  | "PRICE_INCREASE" // EXPIRED: Expired due to not accepting price increase
  | "BILLING_RECOVERY" // DID_RENEW: Recovered from billing issue
  | "PENDING" // PRICE_INCREASE: User hasn't responded yet
  | "ACCEPTED" // PRICE_INCREASE: User accepted increase
  | "FAILURE" // RENEWAL_EXTENSION: Extension request failed
  | "SUMMARY"; // RENEWAL_EXTENSION: Summary of mass extension

/**
 * Subscription status values
 */
export type SubscriptionStatus =
  | "active"
  | "expired"
  | "in_grace_period"
  | "in_billing_retry"
  | "revoked"
  | "unknown";

/**
 * Environment the notification came from
 */
export type Environment = "Sandbox" | "Production";

/**
 * Transaction type
 */
export type TransactionType =
  | "Auto-Renewable Subscription"
  | "Non-Renewing Subscription"
  | "Consumable"
  | "Non-Consumable";

// =============================================================================
// Decoded Payload Types
// =============================================================================

/**
 * The main decoded payload from responseBodyV2
 */
export interface ResponseBodyV2DecodedPayload {
  /** The type of notification */
  notificationType: NotificationType;

  /** Optional subtype providing additional context */
  subtype?: NotificationSubtype;

  /** Unique identifier for this notification (for idempotency) */
  notificationUUID: string;

  /** App Store Server Notifications version */
  version: string;

  /** Timestamp when the notification was signed */
  signedDate: number;

  /** The notification data containing transaction and renewal info */
  data: NotificationData;

  /** Present for some notification types */
  summary?: SummaryData;

  /** Present for EXTERNAL_PURCHASE_TOKEN notifications */
  externalPurchaseToken?: ExternalPurchaseTokenData;
}

/**
 * The data object within the notification
 */
export interface NotificationData {
  /** App's bundle ID */
  bundleId: string;

  /** App's version at time of notification */
  bundleVersion: string;

  /** Environment: Sandbox or Production */
  environment: Environment;

  /** Signed transaction info (JWS) - needs separate verification/decoding */
  signedTransactionInfo: string;

  /** Signed renewal info (JWS) - needs separate verification/decoding */
  signedRenewalInfo?: string;

  /** App Account Token set by your app during purchase */
  appAccountToken?: string;

  /** Status of the subscription */
  status?: number;
}

/**
 * Decoded transaction info from signedTransactionInfo
 */
export interface JWSTransactionDecodedPayload {
  /** The unique identifier for the transaction */
  transactionId: string;

  /** The original transaction identifier for subscription tracking */
  originalTransactionId: string;

  /** The web order line item ID */
  webOrderLineItemId?: string;

  /** Bundle ID of the app */
  bundleId: string;

  /** Product identifier */
  productId: string;

  /** Subscription group identifier */
  subscriptionGroupIdentifier?: string;

  /** Purchase date in milliseconds */
  purchaseDate: number;

  /** Original purchase date in milliseconds */
  originalPurchaseDate: number;

  /** Expiration date in milliseconds (subscriptions only) */
  expiresDate?: number;

  /** Quantity */
  quantity: number;

  /** Transaction type */
  type: TransactionType;

  /** App Account Token (UUID string if set) */
  appAccountToken?: string;

  /** In-app ownership type */
  inAppOwnershipType: "FAMILY_SHARED" | "PURCHASED";

  /** Signed date */
  signedDate: number;

  /** Revocation date in milliseconds (if refunded) */
  revocationDate?: number;

  /** Revocation reason (if refunded) */
  revocationReason?: number;

  /** Whether this is from the App Store (not promoted) */
  isUpgraded?: boolean;

  /** Offer type (if promotional offer was used) */
  offerType?: number;

  /** Offer identifier */
  offerIdentifier?: string;

  /** Environment */
  environment: Environment;

  /** Storefront */
  storefront?: string;

  /** Storefront ID */
  storefrontId?: string;

  /** Transaction reason */
  transactionReason?: "PURCHASE" | "RENEWAL";

  /** Price in milliunits */
  price?: number;

  /** Currency */
  currency?: string;

  /** Offer discount type */
  offerDiscountType?: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT";
}

/**
 * Decoded renewal info from signedRenewalInfo
 */
export interface JWSRenewalInfoDecodedPayload {
  /** Original transaction ID */
  originalTransactionId: string;

  /** Current product's renewal product ID */
  autoRenewProductId: string;

  /** Current product ID */
  productId: string;

  /** Auto-renew status: 1 = will renew, 0 = will not renew */
  autoRenewStatus: number;

  /** Renewal price */
  renewalPrice?: number;

  /** Renewal price currency */
  currency?: string;

  /** Signed date */
  signedDate: number;

  /** Environment */
  environment: Environment;

  /** Recent subscription start date */
  recentSubscriptionStartDate?: number;

  /** Renewal date */
  renewalDate?: number;

  /** Expiration intent */
  expirationIntent?: number;

  /** Price increase status */
  priceIncreaseStatus?: number;

  /** Is in billing retry period */
  isInBillingRetryPeriod?: boolean;

  /** Grace period expires date */
  gracePeriodExpiresDate?: number;

  /** Offer type */
  offerType?: number;

  /** Offer identifier */
  offerIdentifier?: string;
}

/**
 * Summary data for bulk operations
 */
export interface SummaryData {
  /** Request identifier */
  requestIdentifier: string;

  /** Environment */
  environment: Environment;

  /** App Apple ID */
  appAppleId: number;

  /** Bundle ID */
  bundleId: string;

  /** Product ID */
  productId: string;

  /** Storefront country codes */
  storefrontCountryCodes: string[];

  /** Count of succeeded extensions */
  succeededCount: number;

  /** Count of failed extensions */
  failedCount: number;
}

/**
 * External purchase token data
 */
export interface ExternalPurchaseTokenData {
  /** Sandbox app account token */
  sandboxAppAccountToken?: string;

  /** Production app account token */
  appAccountToken?: string;

  /** External purchase ID */
  externalPurchaseId: string;
}

// =============================================================================
// Mapping Functions
// =============================================================================

/**
 * Map a notification type (and subtype) to a subscription status
 */
export function mapNotificationToStatus(
  notificationType: NotificationType,
  _subtype?: NotificationSubtype,
  renewalInfo?: JWSRenewalInfoDecodedPayload,
): SubscriptionStatus {
  switch (notificationType) {
    case "SUBSCRIBED":
      return "active";

    case "DID_RENEW":
      return "active";

    case "DID_FAIL_TO_RENEW":
      // Check if in grace period or billing retry
      if (renewalInfo?.gracePeriodExpiresDate && renewalInfo.gracePeriodExpiresDate > Date.now()) {
        return "in_grace_period";
      }
      if (renewalInfo?.isInBillingRetryPeriod) {
        return "in_billing_retry";
      }
      return "in_billing_retry";

    case "GRACE_PERIOD_EXPIRED":
      return "in_billing_retry";

    case "EXPIRED":
      return "expired";

    case "REFUND":
    case "REVOKE":
      return "revoked";

    case "DID_CHANGE_RENEWAL_STATUS":
      // Subscription is still active, just renewal status changed
      return "active";

    case "DID_CHANGE_RENEWAL_PREF":
      // Subscription is still active, just changed plan
      return "active";

    case "OFFER_REDEEMED":
      return "active";

    case "RENEWAL_EXTENDED":
    case "RENEWAL_EXTENSION":
      return "active";

    case "PRICE_INCREASE":
      // Subscription is still active during price increase consideration
      return "active";

    case "REFUND_DECLINED":
    case "REFUND_REVERSED":
      // Refund was declined or reversed, subscription should be active
      return "active";

    case "CONSUMPTION_REQUEST":
    case "TEST":
    case "EXTERNAL_PURCHASE_TOKEN":
      // These don't affect subscription status
      return "unknown";

    default:
      return "unknown";
  }
}

/**
 * Determine if a notification should trigger a subscription update
 * Some notifications are informational and don't require status updates
 */
export function shouldUpdateSubscription(notificationType: NotificationType): boolean {
  switch (notificationType) {
    // These notifications should update subscription state
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "DID_FAIL_TO_RENEW":
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
    case "REFUND":
    case "REVOKE":
    case "DID_CHANGE_RENEWAL_STATUS":
    case "DID_CHANGE_RENEWAL_PREF":
    case "OFFER_REDEEMED":
    case "RENEWAL_EXTENDED":
    case "REFUND_DECLINED":
    case "REFUND_REVERSED":
      return true;

    // These are informational or don't affect subscription state
    case "CONSUMPTION_REQUEST":
    case "TEST":
    case "EXTERNAL_PURCHASE_TOKEN":
    case "PRICE_INCREASE": // Only affects future, not current state
    case "RENEWAL_EXTENSION": // Summary notification, individual updates handled separately
      return false;

    default:
      return false;
  }
}

/**
 * Get a human-readable description of the notification
 */
export function getNotificationDescription(
  notificationType: NotificationType,
  subtype?: NotificationSubtype,
): string {
  const descriptions: Record<NotificationType, string> = {
    "CONSUMPTION_REQUEST": "App Store is requesting consumption information",
    "DID_CHANGE_RENEWAL_PREF": subtype === "DOWNGRADE"
      ? "User downgraded to a cheaper subscription"
      : subtype === "UPGRADE"
      ? "User upgraded to a more expensive subscription"
      : "User changed their renewal preference",
    "DID_CHANGE_RENEWAL_STATUS": subtype === "AUTO_RENEW_ENABLED"
      ? "User re-enabled auto-renewal"
      : "User disabled auto-renewal",
    "DID_FAIL_TO_RENEW": "Subscription renewal failed due to billing issue",
    "DID_RENEW": subtype === "BILLING_RECOVERY"
      ? "Subscription renewed after billing recovery"
      : "Subscription successfully renewed",
    "EXPIRED": subtype === "VOLUNTARY"
      ? "Subscription expired (user chose not to renew)"
      : subtype === "BILLING_RETRY"
      ? "Subscription expired after billing retry failed"
      : "Subscription expired",
    "EXTERNAL_PURCHASE_TOKEN": "External purchase token notification",
    "GRACE_PERIOD_EXPIRED": "Grace period expired, subscription is now in billing retry",
    "OFFER_REDEEMED": "User redeemed a promotional offer",
    "PRICE_INCREASE": subtype === "ACCEPTED"
      ? "User accepted the price increase"
      : subtype === "PENDING"
      ? "Price increase pending user response"
      : "Price increase notification",
    "REFUND": "Subscription was refunded",
    "REFUND_DECLINED": "Refund request was declined",
    "REFUND_REVERSED": "Previous refund was reversed",
    "RENEWAL_EXTENDED": "Subscription renewal date was extended",
    "RENEWAL_EXTENSION": "Bulk renewal extension summary",
    "REVOKE": "Subscription access was revoked (Family Sharing)",
    "SUBSCRIBED": subtype === "INITIAL_BUY"
      ? "New subscription purchase"
      : subtype === "RESUBSCRIBE"
      ? "User resubscribed after expiration"
      : "User subscribed",
    "TEST": "Test notification from App Store Connect",
  };

  return descriptions[notificationType] || `Unknown notification: ${notificationType}`;
}

/**
 * Check if the notification indicates the user has active premium access
 */
export function hasPremiumAccess(status: SubscriptionStatus): boolean {
  return status === "active" || status === "in_grace_period";
}

/**
 * Parse the app account token from various formats
 * Apple sends it as a string, but it should be a UUID
 */
export function parseAppAccountToken(token: string | undefined): string | null {
  if (!token) return null;

  // Remove any hyphens and validate UUID format
  const cleaned = token.toLowerCase().replace(/-/g, "");
  if (cleaned.length !== 32) return null;

  // Reconstruct with hyphens
  const uuid = `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${
    cleaned.slice(16, 20)
  }-${cleaned.slice(20)}`;

  // Validate UUID v4 pattern (or accept any valid UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uuid)) return null;

  return uuid;
}
