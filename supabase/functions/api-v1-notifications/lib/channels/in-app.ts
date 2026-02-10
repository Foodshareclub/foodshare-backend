/**
 * In-App Notification Channel Adapter
 *
 * Delivers notifications via Supabase Realtime for in-app notifications.
 * Stores notifications in database and broadcasts via Realtime channel.
 *
 * @module api-v1-notifications/channels/in-app
 */

import type {
  ChannelAdapter,
  ChannelDeliveryResult,
  InAppPayload,
  NotificationContext,
} from "../types.ts";
import { logger } from "../../../_shared/logger.ts";

export class InAppChannelAdapter implements ChannelAdapter {
  name = "in_app";
  channel = "in_app" as const;

  async send(
    payload: InAppPayload,
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult> {
    const startTime = performance.now();

    try {
      logger.info("Sending in-app notification", {
        requestId: context.requestId,
        userId: payload.userId,
        title: payload.title,
      });

      // Store notification in database
      const { data: notification, error: insertError } = await context.supabase
        .from("in_app_notifications")
        .insert({
          user_id: payload.userId,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          image_url: payload.imageUrl,
          action_url: payload.actionUrl,
          category: payload.category || "system",
          read_at: null,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (insertError) {
        logger.error("Failed to store in-app notification", new Error(insertError.message), {
          userId: payload.userId,
        });

        return {
          channel: "in_app",
          success: false,
          error: insertError.message,
          attemptedAt: new Date().toISOString(),
        };
      }

      // Broadcast via Realtime channel
      const channel = context.supabase.channel(`user:${payload.userId}:notifications`);

      await channel.send({
        type: "broadcast",
        event: "notification",
        payload: {
          id: notification.id,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          imageUrl: payload.imageUrl,
          actionUrl: payload.actionUrl,
          category: payload.category,
          timestamp: new Date().toISOString(),
        },
      });

      const duration = performance.now() - startTime;

      logger.info("In-app notification sent", {
        requestId: context.requestId,
        userId: payload.userId,
        notificationId: notification.id,
        durationMs: Math.round(duration),
      });

      return {
        channel: "in_app",
        success: true,
        deliveredTo: [payload.userId],
        attemptedAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("In-app channel error", error as Error, {
        requestId: context.requestId,
        userId: payload.userId,
      });

      return {
        channel: "in_app",
        success: false,
        error: (error as Error).message,
        attemptedAt: new Date().toISOString(),
      };
    }
  }

  async sendBatch(
    payloads: InAppPayload[],
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult[]> {
    logger.info("Sending batch in-app notifications", {
      requestId: context.requestId,
      count: payloads.length,
    });

    // Send in parallel
    const results = await Promise.all(
      payloads.map((payload) => this.send(payload, context)),
    );

    return results;
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    try {
      const startTime = performance.now();

      // Check if in_app_notifications table exists
      // This is a simple check - just query the table
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
      const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

      const response = await fetch(`${SUPABASE_URL}/rest/v1/in_app_notifications?limit=1`, {
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
      });

      const latencyMs = Math.round(performance.now() - startTime);

      return {
        healthy: response.ok,
        latencyMs,
      };
    } catch (error) {
      return {
        healthy: false,
        error: (error as Error).message,
      };
    }
  }
}

/**
 * Mark in-app notification as read
 */
export async function markAsRead(
  context: NotificationContext,
  notificationId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { error } = await context.supabase
      .from("in_app_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("user_id", userId);

    if (error) {
      logger.error("Failed to mark notification as read", new Error(error.message), {
        notificationId,
        userId,
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to mark notification as read", error as Error, {
      notificationId,
      userId,
    });
    return false;
  }
}

/**
 * Get unread count for user
 */
export async function getUnreadCount(
  context: NotificationContext,
  userId: string,
): Promise<number> {
  try {
    const { count, error } = await context.supabase
      .from("in_app_notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);

    if (error) {
      logger.error("Failed to get unread count", new Error(error.message), { userId });
      return 0;
    }

    return count || 0;
  } catch (error) {
    logger.error("Failed to get unread count", error as Error, { userId });
    return 0;
  }
}

/**
 * Mark all notifications as read for user
 */
export async function markAllAsRead(
  context: NotificationContext,
  userId: string,
): Promise<boolean> {
  try {
    const { error } = await context.supabase
      .from("in_app_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("read_at", null);

    if (error) {
      logger.error("Failed to mark all as read", new Error(error.message), { userId });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to mark all as read", error as Error, { userId });
    return false;
  }
}
