/**
 * Sync Subscription Edge Function
 *
 * Called by the iOS app after a successful purchase to register
 * the user-transaction mapping. This enables webhook processing
 * for future subscription lifecycle events.
 *
 * Authentication: Required (JWT)
 *
 * Flow:
 * 1. iOS app completes purchase with appAccountToken set to user's UUID
 * 2. iOS app calls this endpoint with transaction details
 * 3. This creates/updates the subscription record with user mapping
 * 4. Future Apple webhooks can now find the user by transaction ID or app_account_token
 */

import { createAPIHandler, ok, created, type HandlerContext } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { ValidationError, AppError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "1.1.0";
const SERVICE = "sync-subscription";

// =============================================================================
// Request Schema
// =============================================================================

const syncSubscriptionSchema = z.object({
  // Platform (apple, google_play, stripe)
  platform: z.enum(["apple", "google_play", "stripe"]).default("apple"),

  // Transaction identifiers
  originalTransactionId: z.string().min(1, "originalTransactionId is required"),
  transactionId: z.string().min(1, "transactionId is required"),

  // Product info
  productId: z.string().min(1, "productId is required"),
  bundleId: z.string().min(1, "bundleId is required"),

  // Dates (milliseconds since epoch)
  purchaseDate: z.number().int().positive(),
  originalPurchaseDate: z.number().int().positive().optional(),
  expiresDate: z.number().int().positive().optional(),

  // Environment
  environment: z.enum(["Production", "Sandbox"]).default("Production"),

  // App account token (should match user's UUID)
  appAccountToken: z.string().uuid().optional(),

  // Current subscription status from StoreKit
  status: z.enum([
    "active",
    "expired",
    "in_grace_period",
    "in_billing_retry",
    "revoked",
  ]).default("active"),

  // Renewal info
  autoRenewStatus: z.boolean().default(true),
  autoRenewProductId: z.string().optional(),
});

type SyncSubscriptionBody = z.infer<typeof syncSubscriptionSchema>;

// =============================================================================
// Handler
// =============================================================================

async function handleSyncSubscription(
  ctx: HandlerContext<SyncSubscriptionBody>
): Promise<Response> {
  const { body, userId, supabase } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  logger.info("Syncing subscription", {
    userId,
    platform: body.platform,
    originalTransactionId: body.originalTransactionId,
    productId: body.productId,
    status: body.status,
    environment: body.environment,
  });

  // Validate app_account_token matches user ID if provided
  if (body.appAccountToken && body.appAccountToken !== userId) {
    logger.warn("App account token mismatch", {
      expected: userId,
      received: body.appAccountToken,
    });
    // Don't fail - just log for investigation
  }

  // Upsert the subscription record
  const { data: subscriptionId, error: upsertError } = await supabase.rpc(
    "billing.upsert_subscription",
    {
      p_user_id: userId,
      p_platform: body.platform,
      p_original_transaction_id: body.originalTransactionId,
      p_product_id: body.productId,
      p_bundle_id: body.bundleId,
      p_status: body.status,
      p_purchase_date: new Date(body.purchaseDate).toISOString(),
      p_original_purchase_date: body.originalPurchaseDate
        ? new Date(body.originalPurchaseDate).toISOString()
        : new Date(body.purchaseDate).toISOString(),
      p_expires_date: body.expiresDate
        ? new Date(body.expiresDate).toISOString()
        : null,
      p_auto_renew_status: body.autoRenewStatus,
      p_auto_renew_product_id: body.autoRenewProductId || null,
      p_environment: body.environment,
      p_app_account_token: body.appAccountToken || userId,
    }
  );

  if (upsertError) {
    logger.error("Failed to sync subscription", new Error(upsertError.message), {
      userId,
      originalTransactionId: body.originalTransactionId,
    });
    throw new AppError(
      "Failed to sync subscription",
      "SUBSCRIPTION_SYNC_FAILED",
      500
    );
  }

  logger.info("Subscription synced successfully", {
    userId,
    subscriptionId,
    originalTransactionId: body.originalTransactionId,
    status: body.status,
  });

  // Return subscription details
  const { data: subscription, error: fetchError } = await supabase.rpc(
    "billing.get_user_subscription",
    { p_user_id: userId }
  );

  if (fetchError) {
    logger.warn("Failed to fetch subscription after sync", {
      error: fetchError.message,
      userId,
    });
  }

  return created(
    {
      subscription_id: subscriptionId,
      synced: true,
      subscription: subscription || {
        subscription_id: subscriptionId,
        platform: body.platform,
        product_id: body.productId,
        status: body.status,
        expires_date: body.expiresDate ? new Date(body.expiresDate).toISOString() : null,
        auto_renew_status: body.autoRenewStatus,
        is_active: body.status === "active" || body.status === "in_grace_period",
        environment: body.environment,
      },
    },
    ctx
  );
}

// =============================================================================
// Check Subscription Handler
// =============================================================================

async function handleCheckSubscription(
  ctx: HandlerContext
): Promise<Response> {
  const { userId, supabase } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Get subscription status
  const { data: subscription, error } = await supabase.rpc(
    "billing.get_user_subscription",
    { p_user_id: userId }
  );

  if (error) {
    logger.error("Failed to get subscription", new Error(error.message), { userId });
    throw new AppError(
      "Failed to get subscription status",
      "SUBSCRIPTION_FETCH_FAILED",
      500
    );
  }

  // Also check is_premium for quick boolean check
  const { data: isPremium } = await supabase.rpc(
    "billing.is_user_premium",
    { p_user_id: userId }
  );

  return ok(
    {
      is_premium: isPremium ?? false,
      subscription: subscription || null,
    },
    ctx
  );
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: true,
  routes: {
    // POST: Sync subscription after purchase
    POST: {
      schema: syncSubscriptionSchema,
      handler: handleSyncSubscription,
    },
    // GET: Check current subscription status
    GET: {
      handler: handleCheckSubscription,
    },
  },
});
