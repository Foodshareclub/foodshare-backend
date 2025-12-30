/**
 * notify-new-listing Edge Function
 *
 * Notifies nearby users about a new food listing.
 * All notification logic moved to PostgreSQL RPC for thick server architecture.
 *
 * POST /notify-new-listing
 * Authorization: Bearer <jwt>
 *
 * Request:
 * {
 *   "foodItemId": "uuid",
 *   "title": "Fresh Apples",
 *   "latitude": 51.5074,
 *   "longitude": -0.1278,
 *   "radiusKm": 10,
 *   "useQueue": true,
 *   "bypassQuietHours": false
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Notified 15 nearby users",
 *   "foodItemId": "uuid",
 *   "notificationCount": 15
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Schemas
// =============================================================================

const notifyListingSchema = z.object({
  foodItemId: z.string().uuid(),
  title: z.string().min(1).max(200),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusKm: z.number().min(1).max(50).default(10),
  useQueue: z.boolean().default(true),
  bypassQuietHours: z.boolean().default(false),
});

type NotifyListingRequest = z.infer<typeof notifyListingSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface NotifyListingResponse {
  success: boolean;
  message?: string;
  foodItemId?: string;
  notificationCount?: number;
  queuedCount?: number;
  deferredCount?: number;
  error?: string;
}

// =============================================================================
// Handler
// =============================================================================

async function handleNotifyListing(
  ctx: HandlerContext<NotifyListingRequest>
): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const {
    foodItemId,
    title,
    latitude,
    longitude,
    radiusKm,
    useQueue,
    bypassQuietHours,
  } = body;

  let notificationCount = 0;
  let queuedCount = 0;
  let deferredCount = 0;

  // =========================================================================
  // Queue-based notification with consolidation support
  // =========================================================================

  if (useQueue) {
    // Use queue_nearby_notifications for consolidation
    // This groups "nearby_post" notifications: "5 new listings nearby"
    const { data: queueResult, error: queueError } = await supabase.rpc(
      "queue_nearby_notifications",
      {
        p_food_item_id: foodItemId,
        p_sender_id: userId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_title: title,
        p_notification_type: "nearby_post",
        p_radius_km: radiusKm,
        p_consolidation_key: `nearby_post_${latitude.toFixed(2)}_${longitude.toFixed(2)}`,
        p_bypass_quiet_hours: bypassQuietHours,
      }
    );

    if (queueError) {
      logger.warn("Queue error, falling back to direct send", {
        error: queueError.message,
      });
      // Fall back to direct send if queue fails
    } else if (queueResult) {
      queuedCount = queueResult.queued || 0;
      deferredCount = queueResult.deferred || 0;
      notificationCount = queueResult.immediate || 0;
    }
  }

  // If queue wasn't used or failed, fall back to direct bulk notification
  if (!useQueue || (queuedCount === 0 && notificationCount === 0)) {
    const { data: directCount, error: rpcError } = await supabase.rpc(
      "notify_nearby_users_bulk",
      {
        p_food_item_id: foodItemId,
        p_sender_id: userId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_title: title,
        p_notification_type: "new_listing",
        p_radius_km: radiusKm,
      }
    );

    if (rpcError) {
      logger.error("RPC error sending notifications", new Error(rpcError.message));
      return ok({
        success: false,
        error: "Failed to send notifications",
      } as NotifyListingResponse, ctx);
    }

    notificationCount = directCount || 0;
  }

  const response: NotifyListingResponse = {
    success: true,
    message: `Notified ${notificationCount} users immediately, ${queuedCount} queued for consolidation, ${deferredCount} deferred`,
    foodItemId,
    notificationCount,
    queuedCount,
    deferredCount,
  };

  logger.info("Notifications sent", {
    foodItemId,
    notificationCount,
    queuedCount,
    deferredCount,
  });

  return ok(response, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "notify-new-listing",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 20,
    windowMs: 60000, // 20 notifications per minute
    keyBy: "user",
  },
  routes: {
    POST: {
      schema: notifyListingSchema,
      handler: handleNotifyListing,
    },
  },
});
