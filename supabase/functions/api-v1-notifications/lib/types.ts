/**
 * Unified Notification API Types
 *
 * Enterprise-grade type definitions for the unified notification system.
 * Supports email, push, SMS, and in-app notifications across all channels.
 *
 * @module api-v1-notifications/types
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Buffer } from "node:buffer";

// =============================================================================
// Authentication
// =============================================================================

export type AuthMode = "none" | "jwt" | "service" | "webhook" | "admin";

export interface AuthResult {
  authenticated: boolean;
  userId?: string;
  isAdmin?: boolean;
  error?: string;
}

// =============================================================================
// Notification Types & Categories
// =============================================================================

export type NotificationType =
  | "new_message"
  | "listing_favorited"
  | "listing_expired"
  | "new_listing_nearby"
  | "arrangement_confirmed"
  | "arrangement_cancelled"
  | "arrangement_completed"
  | "challenge_complete"
  | "challenge_reminder"
  | "review_received"
  | "review_reminder"
  | "system_announcement"
  | "app_release"
  | "marketing_campaign"
  | "moderation_warning"
  | "account_security"
  | "welcome"
  | "verification"
  | "password_reset"
  | "digest";

export type NotificationCategory =
  | "posts"
  | "forum"
  | "challenges"
  | "comments"
  | "chats"
  | "social"
  | "system"
  | "marketing";

export type NotificationChannel = "push" | "email" | "sms" | "in_app";

export type NotificationFrequency =
  | "instant"
  | "hourly"
  | "daily"
  | "weekly"
  | "never";

export type PriorityLevel = "critical" | "high" | "normal" | "low";

// =============================================================================
// Send Request & Response
// =============================================================================

export interface SendRequest {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
  channels?: NotificationChannel[];
  priority?: PriorityLevel;
  scheduledFor?: string;
  imageUrl?: string;
  sound?: string;
  badge?: number;
  ttl?: number;
  collapseKey?: string;
  channelId?: string;
  category?: string;
  threadId?: string;
}

export interface BatchSendRequest {
  notifications: SendRequest[];
  options?: {
    parallel?: boolean;
    stopOnError?: boolean;
  };
}

export interface TemplateSendRequest {
  userId: string;
  template: string;
  variables: Record<string, unknown>;
  channels?: NotificationChannel[];
  priority?: PriorityLevel;
}

export interface DeliveryResult {
  success: boolean;
  notificationId: string;
  userId: string;
  channels: ChannelDeliveryResult[];
  scheduled?: boolean;
  scheduledFor?: string;
  blocked?: boolean;
  reason?: string;
  error?: string;
  timestamp: string;
}

export interface ChannelDeliveryResult {
  channel: NotificationChannel;
  success: boolean;
  provider?: string;
  deliveredTo?: string[];
  failedDevices?: string[];
  error?: string;
  attemptedAt: string;
  deliveredAt?: string;
}

export interface BatchDeliveryResult {
  success: boolean;
  total: number;
  delivered: number;
  failed: number;
  scheduled: number;
  blocked: number;
  results: DeliveryResult[];
  durationMs: number;
}

// =============================================================================
// Digest Processing
// =============================================================================

export interface DigestRequest {
  frequency: "hourly" | "daily" | "weekly";
  limit?: number;
  dryRun?: boolean;
}

export interface DigestItem {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface DigestResult {
  success: boolean;
  frequency: string;
  usersProcessed: number;
  notificationsSent: number;
  notificationsFailed: number;
  emailsSent: number;
  emailsFailed: number;
  errors: string[];
  dryRun: boolean;
  durationMs: number;
}

// =============================================================================
// User Preferences
// =============================================================================

export interface NotificationPreferences {
  push_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  phone_number?: string;
  phone_verified?: boolean;
  quiet_hours?: QuietHours;
  digest?: DigestSettings;
  dnd?: DndSettings;
  categories: CategoryPreferences;
}

export interface QuietHours {
  enabled: boolean;
  start: string; // HH:mm format
  end: string; // HH:mm format
  timezone: string;
}

export interface DigestSettings {
  daily_enabled: boolean;
  daily_time: string; // HH:mm format
  weekly_enabled: boolean;
  weekly_day: number; // 0-6 (Sunday-Saturday)
}

export interface DndSettings {
  enabled: boolean;
  until?: string; // ISO timestamp
}

export interface CategoryPreferences {
  [category: string]: ChannelPreferences;
}

export interface ChannelPreferences {
  push?: ChannelPreference;
  email?: ChannelPreference;
  sms?: ChannelPreference;
}

export interface ChannelPreference {
  enabled: boolean;
  frequency: NotificationFrequency;
}

export interface UpdatePreferencesRequest {
  push_enabled?: boolean;
  email_enabled?: boolean;
  sms_enabled?: boolean;
  phone_number?: string;
  quiet_hours?: Partial<QuietHours>;
  digest?: Partial<DigestSettings>;
  dnd?: Partial<DndSettings>;
  categories?: {
    [category: string]: {
      [channel: string]: {
        enabled?: boolean;
        frequency?: NotificationFrequency;
      };
    };
  };
}

// =============================================================================
// Webhooks
// =============================================================================

export interface WebhookEvent {
  provider: string;
  eventType: string;
  messageId?: string;
  email?: string;
  status?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Dashboard & Metrics
// =============================================================================

export interface DashboardStats {
  period: "24h" | "7d" | "30d";
  deliveryStats: {
    total: number;
    delivered: number;
    failed: number;
    pending: number;
  };
  channelBreakdown: {
    channel: NotificationChannel;
    total: number;
    delivered: number;
    failed: number;
  }[];
  typeBreakdown: {
    type: NotificationType;
    count: number;
  }[];
  providerHealth: ProviderHealth[];
  recentErrors: ErrorSummary[];
}

export interface ProviderHealth {
  provider: string;
  channel: NotificationChannel;
  status: "operational" | "degraded" | "down";
  successRate: number;
  avgLatencyMs: number;
  lastError?: string;
  lastErrorAt?: string;
  circuitBreakerState?: "CLOSED" | "OPEN" | "HALF_OPEN";
}

export interface ErrorSummary {
  error: string;
  count: number;
  lastOccurrence: string;
  affectedUsers: number;
}

export interface UserMetrics {
  userId: string;
  totalSent: number;
  delivered: number;
  failed: number;
  channels: {
    push: number;
    email: number;
    sms: number;
    in_app: number;
  };
  lastNotification?: string;
  preferences: NotificationPreferences;
}

// =============================================================================
// Admin Operations
// =============================================================================

export interface AdminSendRequest extends SendRequest {
  bypassPreferences?: boolean;
  bypassRateLimits?: boolean;
}

export interface QueueItem {
  id: string;
  userId: string;
  type: NotificationType;
  payload: SendRequest;
  status: "pending" | "processing" | "delivered" | "failed";
  scheduledFor?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SuppressionEntry {
  email: string;
  reason: string;
  addedAt: string;
  expiresAt?: string;
}

// =============================================================================
// Channel-Specific Types
// =============================================================================

export interface EmailPayload {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  template?: string;
  variables?: Record<string, unknown>;
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  contentType: string;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
  sound?: string;
  badge?: number;
  priority?: PriorityLevel;
  ttl?: number;
  collapseKey?: string;
  channelId?: string;
  category?: string;
  threadId?: string;
  // Platform-specific options
  ios?: {
    interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
    relevanceScore?: number;
    targetContentId?: string;
    subtitle?: string;
    category?: string;
    threadId?: string;
    liveActivityToken?: string;
  };
  android?: {
    channelId?: "default" | "messages" | "listings" | "alerts" | "updates" | "social";
    visibility?: "private" | "public" | "secret";
    groupKey?: string;
    groupSummary?: boolean;
    ongoing?: boolean;
    autoCancel?: boolean;
    localOnly?: boolean;
    ticker?: string;
    vibrationPattern?: number[];
    lightColor?: string;
    smallIcon?: string;
    largeIcon?: string;
  };
  web?: {
    requireInteraction?: boolean;
    renotify?: boolean;
    silent?: boolean;
    vibrate?: number[];
    timestamp?: number;
    dir?: "auto" | "ltr" | "rtl";
  };
  deepLink?: {
    entityType: "listing" | "profile" | "chat" | "notification";
    entityId: string;
  };
}

export interface DeviceToken {
  profile_id: string;
  token: string;
  platform: "ios" | "android" | "web";
  endpoint?: string;
  p256dh?: string;
  auth?: string;
}

export interface SmsPayload {
  to: string;
  body: string;
  from?: string;
}

export interface InAppPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  imageUrl?: string;
  actionUrl?: string;
  category?: NotificationCategory;
}

// =============================================================================
// Device Management
// =============================================================================

export interface DeviceToken {
  id: string;
  profile_id: string;
  token: string;
  platform: "ios" | "android" | "web";
  is_active: boolean;
  last_used_at?: string;
  created_at: string;
}

// =============================================================================
// Context
// =============================================================================

export interface NotificationContext {
  supabase: SupabaseClient;
  requestId: string;
  userId?: string;
  isAdmin?: boolean;
}

// =============================================================================
// Channel Adapter Interface
// =============================================================================

export interface ChannelAdapter {
  name: string;
  channel: NotificationChannel;
  send(payload: unknown, context: NotificationContext): Promise<ChannelDeliveryResult>;
  sendBatch?(
    payloads: unknown[],
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult[]>;
  healthCheck?(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }>;
}

// =============================================================================
// Rate Limiting
// =============================================================================

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyBy: "user" | "ip" | "global";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: string;
}
