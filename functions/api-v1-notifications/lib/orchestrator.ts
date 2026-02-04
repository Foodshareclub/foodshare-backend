/**
 * Notification Orchestrator
 *
 * Smart routing and orchestration logic for multi-channel notifications.
 * Handles:
 * - Channel selection based on user preferences
 * - Quiet hours and DND mode
 * - Digest batching
 * - Fallback chains (push → email → SMS)
 * - Priority bypasses
 *
 * @module api-v1-notifications/orchestrator
 */

import type {
  SendRequest,
  DeliveryResult,
  ChannelDeliveryResult,
  NotificationContext,
  NotificationChannel,
} from "./types.ts";
import { getChannelAdapter } from "./channels/index.ts";
import {
  shouldSendNotification,
  mapTypeToCategory,
  shouldBypassPreferences,
} from "../../_shared/notification-preferences.ts";
import { logger } from "../../_shared/logger.ts";
import { getUserEmail, isEmailSuppressed } from "./channels/email.ts";
import { getUserPhoneNumber } from "./channels/sms.ts";

// =============================================================================
// Main Orchestration
// =============================================================================

export async function sendNotification(
  request: SendRequest,
  context: NotificationContext
): Promise<DeliveryResult> {
  const startTime = performance.now();
  const notificationId = crypto.randomUUID();

  logger.info("Orchestrating notification delivery", {
    requestId: context.requestId,
    notificationId,
    userId: request.userId,
    type: request.type,
    channels: request.channels,
  });

  try {
    // 1. Determine channels (explicit or from preferences)
    const channels = await determineChannels(request, context);

    if (channels.length === 0) {
      logger.warn("No channels available for notification", {
        requestId: context.requestId,
        userId: request.userId,
        type: request.type,
      });

      return {
        success: false,
        notificationId,
        userId: request.userId,
        channels: [],
        blocked: true,
        reason: "no_channels_available",
        error: "No notification channels available",
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Check preferences, quiet hours, DND
    const category = mapTypeToCategory(request.type);
    const bypassPreferences =
      shouldBypassPreferences(request.type) || request.priority === "critical";

    const preferenceResults = await Promise.all(
      channels.map((channel) =>
        shouldSendNotification(context.supabase, request.userId, {
          category,
          channel,
          bypassPreferences,
        })
      )
    );

    // 3. Handle scheduling (quiet hours)
    const firstSchedule = preferenceResults.find((r) => r.scheduleFor);
    if (firstSchedule && !bypassPreferences) {
      await scheduleNotification(request, firstSchedule.scheduleFor!, context);

      return {
        success: true,
        notificationId,
        userId: request.userId,
        channels: [],
        scheduled: true,
        scheduledFor: firstSchedule.scheduleFor,
        reason: firstSchedule.reason || "quiet_hours",
        timestamp: new Date().toISOString(),
      };
    }

    // 4. Handle digest batching
    const firstDigest = preferenceResults.find(
      (r) => r.frequency && r.frequency !== "instant"
    );
    if (firstDigest && !bypassPreferences) {
      await queueForDigest(request, firstDigest.frequency!, context);

      return {
        success: true,
        notificationId,
        userId: request.userId,
        channels: [],
        scheduled: true,
        reason: `queued_for_${firstDigest.frequency}_digest`,
        timestamp: new Date().toISOString(),
      };
    }

    // 5. Filter blocked channels
    const allowedChannels = channels.filter((channel, index) => {
      const result = preferenceResults[index];
      return result?.send === true;
    });

    if (allowedChannels.length === 0) {
      logger.info("All channels blocked by preferences", {
        requestId: context.requestId,
        userId: request.userId,
        type: request.type,
      });

      return {
        success: false,
        notificationId,
        userId: request.userId,
        channels: [],
        blocked: true,
        reason: "blocked_by_preferences",
        timestamp: new Date().toISOString(),
      };
    }

    // 6. Send to each channel with fallback
    const channelResults = await sendToChannels(
      request,
      allowedChannels,
      context,
      notificationId
    );

    // 7. Track delivery
    await trackDelivery(notificationId, request, channelResults, context);

    // 8. Handle fallbacks if needed
    await handleFallbacks(request, channelResults, context);

    const duration = performance.now() - startTime;
    const success = channelResults.some((r) => r.success);

    logger.info("Notification delivery completed", {
      requestId: context.requestId,
      notificationId,
      userId: request.userId,
      success,
      channels: channelResults.map((r) => ({ channel: r.channel, success: r.success })),
      durationMs: Math.round(duration),
    });

    return {
      success,
      notificationId,
      userId: request.userId,
      channels: channelResults,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error("Orchestration error", error as Error, {
      requestId: context.requestId,
      userId: request.userId,
      type: request.type,
    });

    return {
      success: false,
      notificationId,
      userId: request.userId,
      channels: [],
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    };
  }
}

// =============================================================================
// Channel Determination
// =============================================================================

async function determineChannels(
  request: SendRequest,
  context: NotificationContext
): Promise<NotificationChannel[]> {
  // If channels explicitly specified, use those
  if (request.channels && request.channels.length > 0) {
    return request.channels;
  }

  // Otherwise, get from user preferences
  const category = mapTypeToCategory(request.type);

  try {
    const { data, error } = await context.supabase.rpc("get_notification_preferences", {
      p_user_id: request.userId,
    });

    if (error || !data) {
      logger.warn("Failed to get notification preferences, using defaults", {
        userId: request.userId,
        error: error?.message,
      });
      return getDefaultChannels(category);
    }

    // Extract enabled channels from preferences
    const channels: NotificationChannel[] = [];
    const categoryPrefs = data.preferences?.[category];

    if (data.settings?.push_enabled && categoryPrefs?.push?.enabled !== false) {
      channels.push("push");
    }
    if (data.settings?.email_enabled && categoryPrefs?.email?.enabled !== false) {
      channels.push("email");
    }
    if (data.settings?.sms_enabled && categoryPrefs?.sms?.enabled !== false) {
      channels.push("sms");
    }

    // Always include in-app
    channels.push("in_app");

    return channels;
  } catch (error) {
    logger.error("Error determining channels", error as Error, {
      userId: request.userId,
    });
    return getDefaultChannels(category);
  }
}

function getDefaultChannels(category: string): NotificationChannel[] {
  // Default channel preferences
  const defaults: Record<string, NotificationChannel[]> = {
    posts: ["push", "in_app"],
    forum: ["push", "in_app"],
    challenges: ["push", "in_app"],
    comments: ["push", "in_app"],
    chats: ["push", "in_app"],
    social: ["push", "in_app"],
    system: ["email", "in_app"],
    marketing: ["email"],
  };

  return defaults[category] || ["push", "in_app"];
}

// =============================================================================
// Channel Sending
// =============================================================================

async function sendToChannels(
  request: SendRequest,
  channels: NotificationChannel[],
  context: NotificationContext,
  notificationId: string
): Promise<ChannelDeliveryResult[]> {
  const results: ChannelDeliveryResult[] = [];

  // Send to all channels in parallel
  const promises = channels.map(async (channel) => {
    try {
      const adapter = getChannelAdapter(channel);
      if (!adapter) {
        logger.warn("Channel adapter not found", { channel });
        return {
          channel,
          success: false,
          error: "Channel adapter not available",
          attemptedAt: new Date().toISOString(),
        };
      }

      // Build channel-specific payload
      const payload = await buildChannelPayload(request, channel, context);
      if (!payload) {
        return {
          channel,
          success: false,
          error: "Could not build channel payload",
          attemptedAt: new Date().toISOString(),
        };
      }

      // Send via adapter
      return await adapter.send(payload, context);
    } catch (error) {
      logger.error("Channel send error", error as Error, {
        channel,
        userId: request.userId,
      });
      return {
        channel,
        success: false,
        error: (error as Error).message,
        attemptedAt: new Date().toISOString(),
      };
    }
  });

  results.push(...(await Promise.all(promises)));

  return results;
}

async function buildChannelPayload(
  request: SendRequest,
  channel: NotificationChannel,
  context: NotificationContext
): Promise<unknown | null> {
  switch (channel) {
    case "email": {
      const email = await getUserEmail(context, request.userId);
      if (!email) return null;

      // Check suppression
      const suppressed = await isEmailSuppressed(context, email);
      if (suppressed) {
        logger.info("Email suppressed", { email, userId: request.userId });
        return null;
      }

      return {
        to: email,
        subject: request.title,
        html: formatEmailHtml(request),
        text: request.body,
      };
    }

    case "push": {
      return {
        title: request.title,
        body: request.body,
        data: request.data,
        imageUrl: request.imageUrl,
        sound: request.sound,
        badge: request.badge,
        priority: request.priority,
        ttl: request.ttl,
        collapseKey: request.collapseKey,
        channelId: request.channelId,
        category: request.category,
        threadId: request.threadId,
      };
    }

    case "sms": {
      const phoneNumber = await getUserPhoneNumber(context, request.userId);
      if (!phoneNumber) return null;

      return {
        to: phoneNumber,
        body: `${request.title}\n\n${request.body}`,
      };
    }

    case "in_app": {
      return {
        userId: request.userId,
        title: request.title,
        body: request.body,
        data: request.data,
        imageUrl: request.imageUrl,
        category: mapTypeToCategory(request.type),
      };
    }

    default:
      return null;
  }
}

function formatEmailHtml(request: SendRequest): string {
  // Basic HTML email formatting
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a; margin-bottom: 20px;">${request.title}</h2>
  <p style="margin-bottom: 20px;">${request.body}</p>
  ${request.imageUrl ? `<img src="${request.imageUrl}" alt="" style="max-width: 100%; height: auto; border-radius: 8px; margin-bottom: 20px;">` : ""}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="font-size: 12px; color: #666;">
    You received this notification because you are subscribed to FoodShare updates.
    <a href="{{unsubscribe_url}}" style="color: #666;">Unsubscribe</a>
  </p>
</body>
</html>
  `.trim();
}

// =============================================================================
// Scheduling & Queueing
// =============================================================================

async function scheduleNotification(
  request: SendRequest,
  scheduledFor: string,
  context: NotificationContext
): Promise<void> {
  try {
    await context.supabase.from("notification_queue").insert({
      user_id: request.userId,
      type: request.type,
      payload: request,
      status: "pending",
      scheduled_for: scheduledFor,
      created_at: new Date().toISOString(),
    });

    logger.info("Notification scheduled", {
      userId: request.userId,
      type: request.type,
      scheduledFor,
    });
  } catch (error) {
    logger.error("Failed to schedule notification", error as Error, {
      userId: request.userId,
    });
  }
}

async function queueForDigest(
  request: SendRequest,
  frequency: string,
  context: NotificationContext
): Promise<void> {
  try {
    const now = new Date();
    let scheduledFor: Date;

    switch (frequency) {
      case "hourly":
        scheduledFor = new Date(now);
        scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);
        break;
      case "daily":
        scheduledFor = new Date(now);
        scheduledFor.setDate(scheduledFor.getDate() + 1);
        scheduledFor.setHours(9, 0, 0, 0);
        break;
      case "weekly":
        scheduledFor = new Date(now);
        const daysUntilMonday = (8 - scheduledFor.getDay()) % 7 || 7;
        scheduledFor.setDate(scheduledFor.getDate() + daysUntilMonday);
        scheduledFor.setHours(9, 0, 0, 0);
        break;
      default:
        scheduledFor = new Date(now.getTime() + 60 * 60 * 1000);
    }

    await context.supabase.from("notification_digest_queue").insert({
      user_id: request.userId,
      notification_type: request.type,
      category: mapTypeToCategory(request.type),
      title: request.title,
      body: request.body,
      data: request.data || {},
      frequency,
      scheduled_for: scheduledFor.toISOString(),
      created_at: now.toISOString(),
    });

    logger.info("Notification queued for digest", {
      userId: request.userId,
      type: request.type,
      frequency,
      scheduledFor: scheduledFor.toISOString(),
    });
  } catch (error) {
    logger.error("Failed to queue for digest", error as Error, {
      userId: request.userId,
    });
  }
}

// =============================================================================
// Tracking & Fallbacks
// =============================================================================

async function trackDelivery(
  notificationId: string,
  request: SendRequest,
  results: ChannelDeliveryResult[],
  context: NotificationContext
): Promise<void> {
  try {
    await context.supabase.from("notification_delivery_log").insert({
      notification_id: notificationId,
      user_id: request.userId,
      type: request.type,
      title: request.title,
      body: request.body,
      channels: results.map((r) => ({
        channel: r.channel,
        success: r.success,
        provider: r.provider,
        error: r.error,
        deliveredAt: r.deliveredAt,
      })),
      status: results.some((r) => r.success) ? "delivered" : "failed",
      delivered_at: results.some((r) => r.success) ? new Date().toISOString() : null,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Failed to track delivery", error as Error, { notificationId });
  }
}

async function handleFallbacks(
  request: SendRequest,
  results: ChannelDeliveryResult[],
  context: NotificationContext
): Promise<void> {
  // Fallback chain: push → email → SMS
  const pushResult = results.find((r) => r.channel === "push");
  const emailResult = results.find((r) => r.channel === "email");

  // If push failed and email not attempted, try email
  if (pushResult && !pushResult.success && !emailResult && request.priority !== "low") {
    logger.info("Push failed, attempting email fallback", {
      userId: request.userId,
      type: request.type,
    });

    try {
      const emailAdapter = getChannelAdapter("email");
      if (emailAdapter) {
        const email = await getUserEmail(context, request.userId);
        if (email) {
          const payload = {
            to: email,
            subject: `[Fallback] ${request.title}`,
            html: formatEmailHtml(request),
            text: request.body,
          };

          await emailAdapter.send(payload, context);
        }
      }
    } catch (error) {
      logger.error("Fallback email failed", error as Error, {
        userId: request.userId,
      });
    }
  }
}
