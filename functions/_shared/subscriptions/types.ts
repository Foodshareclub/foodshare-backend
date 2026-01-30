/**
 * Cross-Platform Subscription Types
 *
 * Common types and interfaces for subscription management across all platforms:
 * - Apple App Store (iOS)
 * - Google Play (Android)
 * - Stripe (Web)
 */

// =============================================================================
// Platform Identifiers
// =============================================================================

export type SubscriptionPlatform = "apple" | "google_play" | "stripe";

export type SubscriptionStatus =
  | "active"           // Subscription is active and in good standing
  | "expired"          // Subscription has expired
  | "in_grace_period"  // Payment failed but in grace period
  | "in_billing_retry" // Payment failed, provider is retrying
  | "on_hold"          // Account hold (Google Play)
  | "revoked"          // Subscription was refunded or revoked
  | "refunded"         // Subscription was refunded
  | "paused"           // Subscription is paused (Google Play only)
  | "pending"          // Subscription is pending (awaiting payment)
  | "unknown";         // Initial state before first webhook

export type SubscriptionEnvironment = "production" | "sandbox" | "test";

// =============================================================================
// Common Subscription Event
// =============================================================================

/**
 * Normalized subscription event from any platform
 */
export interface SubscriptionEvent {
  /** Platform-specific event ID for idempotency */
  eventId: string;

  /** Platform that sent the event */
  platform: SubscriptionPlatform;

  /** Normalized event type */
  eventType: SubscriptionEventType;

  /** Platform-specific event type (for logging) */
  rawEventType: string;

  /** Platform-specific subtype if applicable */
  rawSubtype?: string;

  /** Timestamp when the event occurred */
  eventTime: Date;

  /** The subscription this event relates to */
  subscription: SubscriptionData;

  /** Raw payload for debugging (JSON string) */
  rawPayload: string;

  /** Environment */
  environment: SubscriptionEnvironment;
}

/**
 * Normalized event types across platforms
 */
export type SubscriptionEventType =
  | "subscription_created"      // New subscription started
  | "subscription_renewed"      // Subscription successfully renewed
  | "subscription_expired"      // Subscription ended
  | "subscription_canceled"     // User canceled (may still be active until period ends)
  | "subscription_reactivated"  // User reactivated after cancellation
  | "billing_issue"             // Payment failed
  | "billing_recovered"         // Payment recovered after issue
  | "grace_period_started"      // Entered grace period
  | "grace_period_expired"      // Grace period ended
  | "refunded"                  // Subscription was refunded
  | "revoked"                   // Access revoked (family sharing, etc.)
  | "price_change"              // Price change notification
  | "plan_changed"              // User changed plans (upgrade/downgrade)
  | "paused"                    // Subscription paused (Google Play)
  | "resumed"                   // Subscription resumed after pause
  | "test"                      // Test notification
  | "unknown";                  // Unrecognized event type

// =============================================================================
// Subscription Data
// =============================================================================

/**
 * Normalized subscription data from any platform
 */
export interface SubscriptionData {
  /** Platform-specific subscription/transaction ID */
  platformSubscriptionId: string;

  /** Original transaction ID (for tracking renewals) */
  originalTransactionId: string;

  /** Product/SKU identifier */
  productId: string;

  /** Bundle ID / Package name */
  bundleId: string;

  /** Current subscription status */
  status: SubscriptionStatus;

  /** Purchase date */
  purchaseDate?: Date;

  /** Original purchase date (first subscription) */
  originalPurchaseDate?: Date;

  /** Current period expiration date */
  expiresDate?: Date;

  /** Whether auto-renewal is enabled */
  autoRenewEnabled: boolean;

  /** Product ID that will be used for next renewal (if different) */
  autoRenewProductId?: string;

  /** User identifier from the app (appAccountToken, obfuscatedAccountId, etc.) */
  appUserId?: string;

  /** Grace period expiration date if in grace period */
  gracePeriodExpiresDate?: Date;

  /** Price in smallest currency unit (cents, etc.) */
  priceAmount?: number;

  /** Currency code (USD, EUR, etc.) */
  priceCurrency?: string;

  /** Country/region code */
  countryCode?: string;
}

// =============================================================================
// Handler Interface
// =============================================================================

/**
 * Platform-specific webhook handler interface
 */
export interface PlatformHandler {
  /** Platform identifier */
  platform: SubscriptionPlatform;

  /**
   * Detect if this handler should process the request
   * @param request The incoming request
   * @returns true if this handler can process the request
   */
  canHandle(request: Request): boolean;

  /**
   * Verify the webhook signature/authenticity
   * @param request The incoming request
   * @param body The raw request body
   * @returns true if the webhook is authentic
   */
  verifyWebhook(request: Request, body: string): Promise<boolean>;

  /**
   * Parse and normalize the webhook payload
   * @param request The incoming request
   * @param body The raw request body
   * @returns Normalized subscription event
   */
  parseEvent(request: Request, body: string): Promise<SubscriptionEvent>;
}

// =============================================================================
// Database Types
// =============================================================================

/**
 * Parameters for upserting a subscription record
 */
export interface UpsertSubscriptionParams {
  userId: string;
  platform: SubscriptionPlatform;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  status: SubscriptionStatus;
  purchaseDate?: string;
  originalPurchaseDate?: string;
  expiresDate?: string;
  autoRenewStatus: boolean;
  autoRenewProductId?: string;
  environment: SubscriptionEnvironment;
  appAccountToken?: string;
}

/**
 * Parameters for recording a subscription event
 */
export interface RecordEventParams {
  notificationUuid: string;
  platform: SubscriptionPlatform;
  notificationType: string;
  subtype?: string;
  originalTransactionId: string;
  signedPayload: string;
  decodedPayload: unknown;
  signedDate?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a status indicates active premium access
 */
export function hasPremiumAccess(status: SubscriptionStatus): boolean {
  return status === "active" || status === "in_grace_period";
}

/**
 * Check if an event type should trigger a subscription status update
 */
export function shouldUpdateSubscription(eventType: SubscriptionEventType): boolean {
  switch (eventType) {
    case "subscription_created":
    case "subscription_renewed":
    case "subscription_expired":
    case "subscription_canceled":
    case "subscription_reactivated":
    case "billing_issue":
    case "billing_recovered":
    case "grace_period_started":
    case "grace_period_expired":
    case "refunded":
    case "revoked":
    case "plan_changed":
    case "paused":
    case "resumed":
      return true;

    case "price_change":
    case "test":
    case "unknown":
      return false;

    default:
      return false;
  }
}

/**
 * Map environment string to normalized type
 */
export function normalizeEnvironment(env: string): SubscriptionEnvironment {
  const lower = env.toLowerCase();
  if (lower === "sandbox" || lower === "test" || lower === "xcode") {
    return "sandbox";
  }
  if (lower === "production" || lower === "prod") {
    return "production";
  }
  return "sandbox"; // Default to sandbox for safety
}

/**
 * Get severity level for a subscription event (for alerting/logging)
 */
export function getEventSeverity(eventType: SubscriptionEventType): "info" | "warn" | "error" {
  switch (eventType) {
    case "subscription_expired":
    case "revoked":
    case "refunded":
      return "warn";

    case "billing_issue":
    case "grace_period_expired":
      return "error";

    default:
      return "info";
  }
}

/**
 * Check if event indicates a positive state change
 */
export function isPositiveEvent(eventType: SubscriptionEventType): boolean {
  switch (eventType) {
    case "subscription_created":
    case "subscription_renewed":
    case "subscription_reactivated":
    case "billing_recovered":
    case "resumed":
      return true;

    default:
      return false;
  }
}

/**
 * Check if event indicates a negative state change
 */
export function isNegativeEvent(eventType: SubscriptionEventType): boolean {
  switch (eventType) {
    case "subscription_expired":
    case "subscription_canceled":
    case "billing_issue":
    case "grace_period_expired":
    case "refunded":
    case "revoked":
    case "paused":
      return true;

    default:
      return false;
  }
}

/**
 * Get human-readable description for event type
 */
export function getEventDescription(eventType: SubscriptionEventType): string {
  const descriptions: Record<SubscriptionEventType, string> = {
    subscription_created: "New subscription started",
    subscription_renewed: "Subscription renewed successfully",
    subscription_expired: "Subscription has expired",
    subscription_canceled: "Subscription was canceled",
    subscription_reactivated: "Subscription was reactivated",
    billing_issue: "Payment failed",
    billing_recovered: "Payment recovered",
    grace_period_started: "Entered grace period",
    grace_period_expired: "Grace period expired",
    refunded: "Subscription was refunded",
    revoked: "Subscription access revoked",
    price_change: "Price change notification",
    plan_changed: "Subscription plan changed",
    paused: "Subscription paused",
    resumed: "Subscription resumed",
    test: "Test notification",
    unknown: "Unknown event type",
  };
  return descriptions[eventType] || "Unknown event";
}

/**
 * Validate subscription event has required fields
 */
export function validateEvent(event: SubscriptionEvent): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!event.eventId) {
    errors.push("Missing eventId");
  }

  if (!event.platform) {
    errors.push("Missing platform");
  }

  if (!event.subscription.originalTransactionId) {
    errors.push("Missing originalTransactionId");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
