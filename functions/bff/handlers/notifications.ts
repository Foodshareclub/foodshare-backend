/**
 * BFF Notifications Handler
 *
 * Aggregates notification data:
 * - Paginated notifications list
 * - Grouped by date for display
 * - Unread counts by category
 * - User notification settings
 * - Batch mark as read
 *
 * Reduces client round-trips from 3-4 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";
import type {
  NotificationsResponse,
  NotificationItem,
  NotificationGroup,
  NotificationSettings,
  NotificationType,
  NotificationAction,
  PaginationMeta,
} from "../_types/bff-responses.ts";

// =============================================================================
// Request Schema
// =============================================================================

const notificationsQuerySchema = z.object({
  page: z.string().transform(Number).pipe(z.number().int().min(1)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  unreadOnly: z.string().transform((v) => v === "true").optional(),
  types: z.string().transform((s) => s.split(",") as NotificationType[]).optional(),
  includeSettings: z.string().transform((v) => v === "true").optional(),
  groupByDate: z.string().transform((v) => v === "true").optional(),
});

type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetNotifications(
  ctx: HandlerContext<unknown, NotificationsQuery>
): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const unreadOnly = query.unreadOnly ?? false;
  const types = query.types || [];
  const includeSettings = query.includeSettings ?? true;
  const groupByDate = query.groupByDate ?? true;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC for notifications
  const { data, error } = await supabase.rpc("get_bff_notifications", {
    p_user_id: userId,
    p_page: page,
    p_limit: limit,
    p_unread_only: unreadOnly,
    p_types: types.length > 0 ? types : null,
    p_include_settings: includeSettings,
  });

  if (error) {
    logger.error("Failed to fetch notifications", new Error(error.message));
    throw new Error("Failed to fetch notifications");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Transform notifications
  const notifications: NotificationItem[] = (result.notifications || []).map(
    (n: Record<string, unknown>) => {
      // Parse action if present
      let action: NotificationAction | undefined;
      if (n.action_type && n.action_destination) {
        action = {
          type: n.action_type as "navigate" | "deep_link" | "web_url",
          destination: n.action_destination as string,
        };
      }

      return {
        id: n.id as string,
        type: n.type as NotificationType,
        title: n.title as string,
        body: n.body as string,
        imageUrl: n.image_url as string | undefined,
        data: (n.data as Record<string, string>) || {},
        isRead: n.is_read as boolean,
        createdAt: n.created_at as string,
        action,
      };
    }
  );

  // Group by date if requested
  let grouped: NotificationGroup[] = [];
  if (groupByDate) {
    const dateGroups = new Map<string, NotificationItem[]>();

    notifications.forEach((notification) => {
      const date = notification.createdAt.split("T")[0]; // YYYY-MM-DD
      const existing = dateGroups.get(date) || [];
      existing.push(notification);
      dateGroups.set(date, existing);
    });

    grouped = Array.from(dateGroups.entries())
      .sort(([a], [b]) => b.localeCompare(a)) // Sort descending
      .map(([date, items]) => ({
        date,
        notifications: items,
      }));
  }

  // Build pagination
  const totalCount = result.total_count || 0;
  const pagination: PaginationMeta = {
    page,
    limit,
    total: totalCount,
    hasMore: page * limit < totalCount,
  };

  // Build settings
  let settings: NotificationSettings | undefined;
  if (includeSettings && result.settings) {
    const s = result.settings;
    settings = {
      pushEnabled: s.push_enabled ?? true,
      emailEnabled: s.email_enabled ?? true,
      categories: {
        messages: s.notify_messages ?? true,
        listings: s.notify_listings ?? true,
        reviews: s.notify_reviews ?? true,
        challenges: s.notify_challenges ?? true,
        promotions: s.notify_promotions ?? false,
      },
    };
  }

  // Build response
  const response: NotificationsResponse = {
    notifications,
    grouped,
    pagination,
    unreadCount: result.unread_count || 0,
    settings: settings || {
      pushEnabled: true,
      emailEnabled: true,
      categories: {
        messages: true,
        listings: true,
        reviews: true,
        challenges: true,
        promotions: false,
      },
    },
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(response, platform, {
    resourceType: "notifications",
    imageUseCase: "icon",
    includeCapabilities: false,
  });

  logger.info("Notifications fetched", {
    userId,
    count: notifications.length,
    unreadCount: result.unread_count,
    platform,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Mark Read Handler
// =============================================================================

const markReadBodySchema = z.object({
  notificationIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  markAllRead: z.boolean().optional(),
});

async function handleMarkRead(
  ctx: HandlerContext<z.infer<typeof markReadBodySchema>>
): Promise<Response> {
  const { supabase, userId, body } = ctx;

  const { notificationIds, markAllRead } = body;

  if (markAllRead) {
    // Mark all notifications as read
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("is_read", false);

    if (error) {
      logger.error("Failed to mark all as read", new Error(error.message));
      throw new Error("Failed to mark notifications as read");
    }

    logger.info("All notifications marked read", { userId });

    return ok({ success: true, markedCount: "all" }, ctx);
  }

  if (!notificationIds || notificationIds.length === 0) {
    throw new Error("Either notificationIds or markAllRead must be provided");
  }

  // Mark specific notifications as read
  const { error, count } = await supabase
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .in("id", notificationIds);

  if (error) {
    logger.error("Failed to mark notifications as read", new Error(error.message));
    throw new Error("Failed to mark notifications as read");
  }

  logger.info("Notifications marked read", {
    userId,
    requestedCount: notificationIds.length,
    markedCount: count,
  });

  return ok({ success: true, markedCount: count }, ctx);
}

// =============================================================================
// Update Settings Handler
// =============================================================================

const updateSettingsBodySchema = z.object({
  pushEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  categories: z
    .object({
      messages: z.boolean().optional(),
      listings: z.boolean().optional(),
      reviews: z.boolean().optional(),
      challenges: z.boolean().optional(),
      promotions: z.boolean().optional(),
    })
    .optional(),
});

async function handleUpdateSettings(
  ctx: HandlerContext<z.infer<typeof updateSettingsBodySchema>>
): Promise<Response> {
  const { supabase, userId, body } = ctx;

  // Build update object
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.pushEnabled !== undefined) {
    updates.push_enabled = body.pushEnabled;
  }
  if (body.emailEnabled !== undefined) {
    updates.email_enabled = body.emailEnabled;
  }
  if (body.categories) {
    if (body.categories.messages !== undefined) {
      updates.notify_messages = body.categories.messages;
    }
    if (body.categories.listings !== undefined) {
      updates.notify_listings = body.categories.listings;
    }
    if (body.categories.reviews !== undefined) {
      updates.notify_reviews = body.categories.reviews;
    }
    if (body.categories.challenges !== undefined) {
      updates.notify_challenges = body.categories.challenges;
    }
    if (body.categories.promotions !== undefined) {
      updates.notify_promotions = body.categories.promotions;
    }
  }

  // Upsert notification settings
  const { error } = await supabase
    .from("notification_settings")
    .upsert(
      {
        user_id: userId,
        ...updates,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    logger.error("Failed to update notification settings", new Error(error.message));
    throw new Error("Failed to update settings");
  }

  logger.info("Notification settings updated", { userId, updates: Object.keys(updates) });

  return ok({ success: true }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-notifications",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: notificationsQuerySchema,
      handler: handleGetNotifications,
    },
    POST: {
      bodySchema: markReadBodySchema,
      handler: handleMarkRead,
    },
    PATCH: {
      bodySchema: updateSettingsBodySchema,
      handler: handleUpdateSettings,
    },
  },
});
