/**
 * Notification Preferences Helper
 *
 * Enterprise-grade notification preference checking.
 * Integrates with the notification_preferences database system.
 *
 * Features:
 * - Master channel switches (push/email/sms enabled)
 * - Category-level preferences
 * - Frequency control (instant, hourly, daily, weekly, never)
 * - Quiet hours with timezone support
 * - Do Not Disturb mode
 * - System notifications bypass (always delivered)
 *
 * @module notification-preferences
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

// =============================================================================
// Types
// =============================================================================

export type NotificationCategory =
  | "posts"
  | "forum"
  | "challenges"
  | "comments"
  | "chats"
  | "social"
  | "system"
  | "marketing";

export type NotificationChannel = "push" | "email" | "sms";

export type NotificationFrequency =
  | "instant"
  | "hourly"
  | "daily"
  | "weekly"
  | "never";

export interface ShouldSendResult {
  send: boolean;
  reason?: string;
  frequency?: NotificationFrequency;
  scheduleFor?: string;
  resumeAt?: string;
}

export interface NotificationCheckOptions {
  /** Category of notification */
  category: NotificationCategory;
  /** Channel to send on */
  channel: NotificationChannel;
  /** Skip all preference checks (for critical system alerts) */
  bypassPreferences?: boolean;
}

// =============================================================================
// Main Check Function
// =============================================================================

/**
 * Check if a notification should be sent to a user.
 *
 * @param supabase - Supabase client
 * @param userId - Target user ID
 * @param options - Notification options
 * @returns Whether to send and any scheduling info
 *
 * @example
 * ```typescript
 * const result = await shouldSendNotification(supabase, userId, {
 *   category: "posts",
 *   channel: "push",
 * });
 *
 * if (!result.send) {
 *   if (result.scheduleFor) {
 *     // Queue for later
 *     await queueNotification(userId, payload, result.scheduleFor);
 *   }
 *   return;
 * }
 *
 * // Send immediately
 * await sendPushNotification(userId, payload);
 * ```
 */
export async function shouldSendNotification(
  supabase: SupabaseClient,
  userId: string,
  options: NotificationCheckOptions
): Promise<ShouldSendResult> {
  const { category, channel, bypassPreferences } = options;

  // Always send if bypassing preferences
  if (bypassPreferences) {
    return { send: true, frequency: "instant" };
  }

  try {
    const { data, error } = await supabase.rpc("should_send_notification", {
      p_user_id: userId,
      p_category: category,
      p_channel: channel,
    });

    if (error) {
      logger.warn("Failed to check notification preferences", {
        userId,
        category,
        channel,
        error: error.message,
      });
      // Fail open for non-marketing categories
      return {
        send: category !== "marketing",
        frequency: "instant",
      };
    }

    return {
      send: data?.send ?? true,
      reason: data?.reason,
      frequency: data?.frequency || "instant",
      scheduleFor: data?.schedule_for,
      resumeAt: data?.resume_at,
    };
  } catch (err) {
    logger.error("Notification preference check failed", {
      userId,
      category,
      channel,
      error: (err as Error).message,
    });
    // Fail open for non-marketing categories
    return {
      send: category !== "marketing",
      frequency: "instant",
    };
  }
}

/**
 * Check notification preferences for multiple users.
 * Returns users grouped by whether to send now or defer.
 *
 * @param supabase - Supabase client
 * @param userIds - Array of user IDs
 * @param options - Notification options
 * @returns Grouped results
 */
export async function checkNotificationPreferences(
  supabase: SupabaseClient,
  userIds: string[],
  options: NotificationCheckOptions
): Promise<{
  sendNow: string[];
  deferred: Array<{ userId: string; scheduleFor?: string; reason?: string }>;
  blocked: Array<{ userId: string; reason: string }>;
}> {
  const sendNow: string[] = [];
  const deferred: Array<{
    userId: string;
    scheduleFor?: string;
    reason?: string;
  }> = [];
  const blocked: Array<{ userId: string; reason: string }> = [];

  // Process in parallel
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const result = await shouldSendNotification(supabase, userId, options);
      return { userId, ...result };
    })
  );

  for (const result of results) {
    if (result.send) {
      sendNow.push(result.userId);
    } else if (result.scheduleFor) {
      // Can be scheduled for later (quiet hours)
      deferred.push({
        userId: result.userId,
        scheduleFor: result.scheduleFor,
        reason: result.reason,
      });
    } else {
      // Blocked entirely (disabled, never frequency, etc.)
      blocked.push({
        userId: result.userId,
        reason: result.reason || "preference_disabled",
      });
    }
  }

  logger.info("Notification preferences checked", {
    category: options.category,
    channel: options.channel,
    total: userIds.length,
    sendNow: sendNow.length,
    deferred: deferred.length,
    blocked: blocked.length,
  });

  return { sendNow, deferred, blocked };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Map notification type to category.
 * Used when converting from legacy notification types.
 */
export function mapTypeToCategory(type: string): NotificationCategory {
  const mapping: Record<string, NotificationCategory> = {
    // Posts
    new_listing: "posts",
    listing_update: "posts",
    listing_expired: "posts",
    nearby_listing: "posts",

    // Forum
    forum_post: "forum",
    forum_reply: "forum",
    forum_mention: "forum",

    // Challenges
    challenge_invite: "challenges",
    challenge_update: "challenges",
    challenge_complete: "challenges",
    challenge_reminder: "challenges",

    // Comments
    comment: "comments",
    comment_reply: "comments",
    comment_mention: "comments",

    // Chats
    message: "chats",
    chat_message: "chats",
    room_message: "chats",
    room_invite: "chats",

    // Social
    follow: "social",
    like: "social",
    share: "social",
    reaction: "social",

    // System
    welcome: "system",
    verification: "system",
    security: "system",
    billing: "system",
    subscription: "system",
    account: "system",

    // Marketing
    promo: "marketing",
    newsletter: "marketing",
    announcement: "marketing",
  };

  return mapping[type] || "system";
}

/**
 * Check if a notification type should bypass preferences.
 * Critical system notifications always get delivered.
 */
export function shouldBypassPreferences(type: string): boolean {
  const bypassTypes = [
    "verification",
    "security_alert",
    "password_reset",
    "two_factor",
    "account_locked",
    "payment_failed",
    "subscription_expired",
  ];

  return bypassTypes.includes(type);
}

/**
 * Get default channel for a notification category.
 */
export function getDefaultChannel(
  category: NotificationCategory
): NotificationChannel {
  const defaults: Record<NotificationCategory, NotificationChannel> = {
    posts: "push",
    forum: "push",
    challenges: "push",
    comments: "push",
    chats: "push",
    social: "push",
    system: "email",
    marketing: "email",
  };

  return defaults[category];
}
