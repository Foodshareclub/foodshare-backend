/**
 * Validation Schemas
 *
 * Zod schemas for request validation across all notification endpoints.
 *
 * @module api-v1-notifications/validation
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Enums
// =============================================================================

export const notificationTypeEnum = z.enum([
  "new_message",
  "listing_favorited",
  "listing_expired",
  "new_listing_nearby",
  "arrangement_confirmed",
  "arrangement_cancelled",
  "arrangement_completed",
  "challenge_complete",
  "challenge_reminder",
  "review_received",
  "review_reminder",
  "system_announcement",
  "app_release",
  "marketing_campaign",
  "moderation_warning",
  "account_security",
  "welcome",
  "verification",
  "password_reset",
  "digest",
]);

export const notificationCategoryEnum = z.enum([
  "posts",
  "forum",
  "challenges",
  "comments",
  "chats",
  "social",
  "system",
  "marketing",
]);

export const notificationChannelEnum = z.enum(["push", "email", "sms", "in_app"]);

export const notificationFrequencyEnum = z.enum([
  "instant",
  "hourly",
  "daily",
  "weekly",
  "never",
]);

export const priorityLevelEnum = z.enum(["critical", "high", "normal", "low"]);

// =============================================================================
// Send Notification
// =============================================================================

export const sendRequestSchema = z.object({
  userId: z.string().uuid(),
  type: notificationTypeEnum,
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(50000), // Allow HTML templates up to 50KB
  data: z.record(z.string()).optional(),
  channels: z.array(notificationChannelEnum).optional(),
  priority: priorityLevelEnum.optional(),
  scheduledFor: z.string().datetime().optional(),
  imageUrl: z.string().url().optional(),
  sound: z.string().max(50).optional(),
  badge: z.number().int().min(0).optional(),
  ttl: z.number().int().min(0).max(2592000).optional(), // Max 30 days
  collapseKey: z.string().max(100).optional(),
  channelId: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  threadId: z.string().max(100).optional(),
});

export const batchSendRequestSchema = z.object({
  notifications: z.array(sendRequestSchema).min(1).max(1000),
  options: z
    .object({
      parallel: z.boolean().optional(),
      stopOnError: z.boolean().optional(),
    })
    .optional(),
});

export const templateSendRequestSchema = z.object({
  userId: z.string().uuid(),
  template: z.string().min(1).max(100),
  variables: z.record(z.unknown()),
  channels: z.array(notificationChannelEnum).optional(),
  priority: priorityLevelEnum.optional(),
});

// =============================================================================
// Digest
// =============================================================================

export const digestRequestSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly"]),
  limit: z.number().int().min(1).max(10000).optional().default(100),
  dryRun: z.boolean().optional().default(false),
});

// =============================================================================
// Preferences
// =============================================================================

export const quietHoursSchema = z.object({
  enabled: z.boolean().optional(),
  start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().max(50).optional(),
});

export const digestSettingsSchema = z.object({
  daily_enabled: z.boolean().optional(),
  daily_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weekly_enabled: z.boolean().optional(),
  weekly_day: z.number().int().min(0).max(6).optional(),
});

export const dndSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  until: z.string().datetime().optional(),
});

export const updatePreferencesSchema = z.object({
  push_enabled: z.boolean().optional(),
  email_enabled: z.boolean().optional(),
  sms_enabled: z.boolean().optional(),
  phone_number: z.string().max(20).optional(),
  quiet_hours: quietHoursSchema.optional(),
  digest: digestSettingsSchema.optional(),
  dnd: dndSettingsSchema.optional(),
  categories: z
    .record(
      z.record(
        z.object({
          enabled: z.boolean().optional(),
          frequency: notificationFrequencyEnum.optional(),
        }),
      ),
    )
    .optional(),
});

export const dndRequestSchema = z.object({
  until: z.string().datetime().optional(),
  duration_hours: z.number().int().min(1).max(168).optional(), // Max 1 week
});

// =============================================================================
// Admin
// =============================================================================

export const adminSendRequestSchema = sendRequestSchema.extend({
  bypassPreferences: z.boolean().optional(),
  bypassRateLimits: z.boolean().optional(),
});

export const providerControlSchema = z.object({
  provider: z.string().min(1).max(50),
  action: z.enum(["enable", "disable", "reset_circuit"]),
});

export const suppressionAddSchema = z.object({
  email: z.string().email(),
  reason: z.string().min(1).max(500),
  expiresAt: z.string().datetime().optional(),
});

// =============================================================================
// Query Parameters
// =============================================================================

export const statusQuerySchema = z.object({
  status: z.enum(["pending", "processing", "delivered", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const metricsQuerySchema = z.object({
  period: z.enum(["24h", "7d", "30d"]).optional().default("24h"),
});

// =============================================================================
// Validation Helpers
// =============================================================================

export function validateScheduledTime(scheduledFor: string): {
  valid: boolean;
  error?: string;
} {
  const scheduledTime = new Date(scheduledFor);

  if (isNaN(scheduledTime.getTime())) {
    return { valid: false, error: "Invalid date format" };
  }

  if (scheduledTime <= new Date()) {
    return { valid: false, error: "Scheduled time must be in the future" };
  }

  // Max 90 days in future
  const maxFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  if (scheduledTime > maxFuture) {
    return { valid: false, error: "Scheduled time too far in future (max 90 days)" };
  }

  return { valid: true };
}

export function validatePhoneNumber(phone: string): {
  valid: boolean;
  error?: string;
} {
  // Basic E.164 format validation
  const e164Regex = /^\+[1-9]\d{1,14}$/;

  if (!e164Regex.test(phone)) {
    return {
      valid: false,
      error: "Phone number must be in E.164 format (e.g., +1234567890)",
    };
  }

  return { valid: true };
}

export function validateDndDuration(durationHours: number): {
  valid: boolean;
  error?: string;
} {
  if (durationHours < 1 || durationHours > 168) {
    return {
      valid: false,
      error: "DND duration must be between 1 and 168 hours (1 week)",
    };
  }

  return { valid: true };
}
