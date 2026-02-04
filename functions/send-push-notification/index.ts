/**
 * Cross-Platform Push Notification Service v2.3
 *
 * Supports: iOS (APNs), Android (FCM v1), Web (VAPID)
 *
 * Features:
 * - Circuit breaker pattern for resilience
 * - Automatic retry with exponential backoff
 * - Batch processing with concurrency control
 * - Dead token cleanup
 * - Metrics and observability
 * - Rate limiting awareness
 * - Schema validation via Zod
 * - Platform-specific payload optimization (v2.3)
 * - iOS 15+ interruption levels
 * - Android notification channels per type
 * - Cross-platform deep linking
 * - Rich media support per platform
 *
 * Uses shared patterns from _shared/ for consistency.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as jose from "https://deno.land/x/jose@v5.2.0/index.ts";
import webpush from "npm:web-push@3.6.7";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// Shared utilities
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { handleWithContext, getContext, getElapsedMs } from "../_shared/context.ts";
import { logger } from "../_shared/logger.ts";
import { withCircuitBreaker, getCircuitStatus, CircuitBreakerError } from "../_shared/circuit-breaker.ts";
import { withRetry, RETRY_PRESETS } from "../_shared/retry.ts";
import { recordMetricFromContext, flushMetrics } from "../_shared/metrics.ts";
import { initSentry, captureException, withSentry } from "../_shared/sentry.ts";
import { createErrorResponse, createSuccessResponse, ValidationError } from "../_shared/errors.ts";
import { TIMEOUT_DEFAULTS, withOperationTimeout } from "../_shared/timeout.ts";
import {
  checkNotificationPreferences,
  mapTypeToCategory,
  shouldBypassPreferences,
  type NotificationCategory,
} from "../_shared/notification-preferences.ts";

// Initialize Sentry
initSentry({ release: "send-push-notification@2.3.0" });

// =============================================================================
// Request Schema (Zod Validation)
// =============================================================================

const platformSchema = z.enum(["ios", "android", "web"]);

// iOS 15+ interruption levels
const iosInterruptionLevelSchema = z.enum([
  "passive",      // Silent, no sound/vibration
  "active",       // Normal notification
  "time-sensitive", // Breaks through Focus modes
  "critical",     // Emergency alerts (requires entitlement)
]);

// Android notification channels
const androidChannelSchema = z.enum([
  "default",      // General notifications
  "messages",     // Chat messages (high priority)
  "listings",     // New listings nearby
  "alerts",       // Time-sensitive alerts
  "updates",      // App updates, tips
  "social",       // Social interactions
]);

const payloadSchema = z.object({
  type: z.string().default("notification"),
  title: z.string().min(1, "Title is required"),
  body: z.string().min(1, "Body is required"),
  icon: z.string().optional(),
  badge: z.union([z.string(), z.number()]).optional(),
  image: z.string().url().optional(),
  url: z.string().optional(),
  tag: z.string().optional(),
  data: z.record(z.string()).optional(),
  sound: z.string().optional(),
  priority: z.enum(["high", "normal"]).optional(),
  ttl: z.number().int().positive().optional(),
  collapseKey: z.string().optional(),
  actions: z.array(z.object({
    action: z.string(),
    title: z.string(),
    icon: z.string().optional(),
  })).optional(),
  // Platform-specific enhancements (v2.3)
  ios: z.object({
    interruptionLevel: iosInterruptionLevelSchema.optional(),
    relevanceScore: z.number().min(0).max(1).optional(), // For notification summary
    targetContentId: z.string().optional(), // For grouped notifications
    subtitle: z.string().optional(),
    category: z.string().optional(), // Action category
    threadId: z.string().optional(), // Thread grouping
    liveActivityToken: z.string().optional(), // For Live Activities
  }).optional(),
  android: z.object({
    channelId: androidChannelSchema.optional(),
    visibility: z.enum(["private", "public", "secret"]).optional(),
    groupKey: z.string().optional(),
    groupSummary: z.boolean().optional(),
    ongoing: z.boolean().optional(), // Persistent notification
    autoCancel: z.boolean().optional(),
    localOnly: z.boolean().optional(),
    ticker: z.string().optional(),
    vibrationPattern: z.array(z.number()).optional(),
    lightColor: z.string().optional(),
    smallIcon: z.string().optional(),
    largeIcon: z.string().url().optional(),
  }).optional(),
  web: z.object({
    requireInteraction: z.boolean().optional(),
    renotify: z.boolean().optional(),
    silent: z.boolean().optional(),
    vibrate: z.array(z.number()).optional(),
    timestamp: z.number().optional(), // Epoch ms
    dir: z.enum(["auto", "ltr", "rtl"]).optional(),
  }).optional(),
  // Cross-platform deep linking
  deepLink: z.object({
    entityType: z.enum(["listing", "profile", "chat", "notification"]),
    entityId: z.string(),
  }).optional(),
});

const sendRequestSchema = z.object({
  user_ids: z.array(z.string().uuid()).optional(),
  tokens: z.array(z.object({
    token: z.string(),
    platform: platformSchema,
  })).optional(),
  platforms: z.array(platformSchema).optional(),
  payload: payloadSchema,
  options: z.object({
    dryRun: z.boolean().optional(),
    priority: z.enum(["high", "normal"]).optional(),
    ttl: z.number().int().positive().optional(),
    bypassQuietHours: z.boolean().optional(),
    useQueue: z.boolean().optional(),
    consolidationKey: z.string().optional(),
  }).optional(),
}).refine(
  (data) => data.user_ids?.length || data.tokens?.length,
  { message: "Must provide user_ids or tokens" }
);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Batch processing
  batchSize: 100,
  concurrency: 10,

  // Token cleanup
  cleanupStaleTokensDays: 90,
} as const;

// Environment
const env = {
  // APNs
  apnsKeyId: Deno.env.get("APNS_KEY_ID"),
  apnsTeamId: Deno.env.get("APNS_TEAM_ID"),
  apnsBundleId: Deno.env.get("APNS_BUNDLE_ID") || "co.nz.foodshare.FoodShare",
  apnsPrivateKey: Deno.env.get("APNS_PRIVATE_KEY"),
  apnsEnvironment: Deno.env.get("APNS_ENVIRONMENT") || "production",
  // FCM
  fcmProjectId: Deno.env.get("FCM_PROJECT_ID"),
  fcmClientEmail: Deno.env.get("FCM_CLIENT_EMAIL"),
  fcmPrivateKey: Deno.env.get("FCM_PRIVATE_KEY"),
  // VAPID
  vapidPublicKey: Deno.env.get("VAPID_PUBLIC_KEY"),
  vapidPrivateKey: Deno.env.get("VAPID_PRIVATE_KEY"),
  vapidSubject: Deno.env.get("VAPID_SUBJECT") || "mailto:hello@foodshare.club",
};

// ============================================================================
// Types
// ============================================================================

type Platform = "ios" | "android" | "web";

interface IOSPayloadOptions {
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  relevanceScore?: number;
  targetContentId?: string;
  subtitle?: string;
  category?: string;
  threadId?: string;
  liveActivityToken?: string;
}

interface AndroidPayloadOptions {
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
}

interface WebPayloadOptions {
  requireInteraction?: boolean;
  renotify?: boolean;
  silent?: boolean;
  vibrate?: number[];
  timestamp?: number;
  dir?: "auto" | "ltr" | "rtl";
}

interface DeepLinkConfig {
  entityType: "listing" | "profile" | "chat" | "notification";
  entityId: string;
}

interface PushPayload {
  type: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string | number;
  image?: string;
  url?: string;
  tag?: string;
  data?: Record<string, string>;
  sound?: string;
  priority?: "high" | "normal";
  ttl?: number;
  collapseKey?: string;
  actions?: Array<{ action: string; title: string; icon?: string }>;
  // Platform-specific options (v2.3)
  ios?: IOSPayloadOptions;
  android?: AndroidPayloadOptions;
  web?: WebPayloadOptions;
  deepLink?: DeepLinkConfig;
}

// ============================================================================
// Deep Link Generation
// ============================================================================

const DEEP_LINK_CONFIG = {
  ios: { scheme: "foodshare://" },
  android: { scheme: "foodshare://" },
  web: { baseUrl: "https://foodshare.club" },
} as const;

function generateDeepLink(
  platform: Platform,
  deepLink: DeepLinkConfig
): string {
  const path = `/${deepLink.entityType}/${deepLink.entityId}`;

  switch (platform) {
    case "ios":
      return `${DEEP_LINK_CONFIG.ios.scheme}${path}`;
    case "android":
      return `${DEEP_LINK_CONFIG.android.scheme}${path}`;
    case "web":
    default:
      return `${DEEP_LINK_CONFIG.web.baseUrl}${path}`;
  }
}

interface SendRequest {
  user_ids?: string[];
  tokens?: Array<{ token: string; platform: Platform }>;
  platforms?: Platform[];
  payload: PushPayload;
  options?: {
    dryRun?: boolean;
    priority?: "high" | "normal";
    ttl?: number;
    bypassQuietHours?: boolean;
    useQueue?: boolean;
    consolidationKey?: string;
  };
}

interface DeviceToken {
  profile_id: string;
  token: string;
  platform: Platform;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
}

interface SendResult {
  success: boolean;
  platform: Platform;
  token?: string;
  messageId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

interface Metrics {
  total: number;
  sent: number;
  failed: number;
  retried: number;
  byPlatform: Record<Platform, { sent: number; failed: number }>;
  latencyMs: number;
  tokensRemoved: number;
}

// ============================================================================
// Circuit Breaker Helpers
// ============================================================================

/**
 * Get circuit name for a platform
 */
function getCircuitName(platform: Platform): string {
  return `push-${platform}`;
}

// ============================================================================
// APNs Provider (iOS)
// ============================================================================

let apnsJwtCache: { token: string; expires: number } | null = null;

async function getApnsToken(): Promise<string> {
  // Cache JWT for 50 minutes (APNs tokens valid for 60 min)
  if (apnsJwtCache && apnsJwtCache.expires > Date.now()) {
    return apnsJwtCache.token;
  }

  if (!env.apnsPrivateKey || !env.apnsKeyId || !env.apnsTeamId) {
    throw new Error("APNs not configured");
  }

  const privateKey = await jose.importPKCS8(env.apnsPrivateKey.replace(/\\n/g, "\n"), "ES256");

  const token = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.apnsKeyId })
    .setIssuedAt()
    .setIssuer(env.apnsTeamId)
    .sign(privateKey);

  apnsJwtCache = { token, expires: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function sendApns(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  const circuitName = getCircuitName("ios");

  try {
    return await withCircuitBreaker(
      circuitName,
      async () => {
        const jwt = await getApnsToken();
        const host =
          env.apnsEnvironment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";

        // iOS-specific options
        const iosOptions = payload.ios || {};

        // Generate deep link URL if provided
        const deepLinkUrl = payload.deepLink
          ? generateDeepLink("ios", payload.deepLink)
          : payload.url;

        // Build APNs payload with iOS 15+ features
        const apnsPayload: Record<string, unknown> = {
          aps: {
            alert: {
              title: payload.title,
              subtitle: iosOptions.subtitle,
              body: payload.body,
            },
            sound: iosOptions.interruptionLevel === "passive" ? undefined : (payload.sound || "default"),
            badge: typeof payload.badge === "number" ? payload.badge : undefined,
            "mutable-content": 1,
            "content-available": 1,
            "thread-id": iosOptions.threadId || payload.collapseKey,
            "category": iosOptions.category,
            // iOS 15+ features
            "interruption-level": iosOptions.interruptionLevel || "active",
            "relevance-score": iosOptions.relevanceScore,
            "target-content-id": iosOptions.targetContentId,
          },
          type: payload.type,
          url: deepLinkUrl,
          // Include deep link info for client-side handling
          deepLink: payload.deepLink,
          ...payload.data,
        };

        // Add image attachment hint (for Notification Service Extension)
        if (payload.image) {
          apnsPayload["image-url"] = payload.image;
        }

        // Build headers
        const headers: Record<string, string> = {
          Authorization: `Bearer ${jwt}`,
          "apns-topic": env.apnsBundleId,
          "apns-push-type": "alert",
          "apns-priority": iosOptions.interruptionLevel === "passive" ? "5" : (payload.priority === "normal" ? "5" : "10"),
          "apns-expiration": String(Math.floor(Date.now() / 1000) + (payload.ttl || 86400)),
          "Content-Type": "application/json",
        };

        // Add collapse-id if provided
        if (payload.collapseKey) {
          headers["apns-collapse-id"] = payload.collapseKey;
        }

        const response = await withOperationTimeout(
          fetch(`https://${host}/3/device/${device.token}`, {
            method: "POST",
            headers,
            body: JSON.stringify(apnsPayload),
          }),
          "push"
        );

        if (response.status === 200) {
          const apnsId = response.headers.get("apns-id");
          return { success: true, platform: "ios" as Platform, messageId: apnsId || undefined };
        }

        const errorBody = await response.json().catch(() => ({}));
        const reason = errorBody.reason || `HTTP ${response.status}`;

        // Determine if token is invalid (don't count as circuit failure)
        const invalidTokenReasons = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"];
        const isInvalidToken = invalidTokenReasons.includes(reason) || response.status === 410;

        if (isInvalidToken) {
          // Invalid token is not a service failure
          return {
            success: false,
            platform: "ios" as Platform,
            token: device.token,
            error: reason,
            errorCode: reason,
            retryable: false,
          };
        }

        // Throw to trigger circuit breaker for real failures
        throw new Error(reason);
      },
      { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 }
    );
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return { success: false, platform: "ios", error: "Circuit open", retryable: true };
    }
    return {
      success: false,
      platform: "ios",
      error: (e as Error).message,
      retryable: true
    };
  }
}

// ============================================================================
// FCM Provider (Android) - HTTP v1 API
// ============================================================================

let fcmAccessTokenCache: { token: string; expires: number } | null = null;

async function getFcmAccessToken(): Promise<string> {
  if (fcmAccessTokenCache && fcmAccessTokenCache.expires > Date.now()) {
    return fcmAccessTokenCache.token;
  }

  if (!env.fcmClientEmail || !env.fcmPrivateKey || !env.fcmProjectId) {
    throw new Error("FCM not configured");
  }

  const privateKey = await jose.importPKCS8(env.fcmPrivateKey.replace(/\\n/g, "\n"), "RS256");

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new jose.SignJWT({
    iss: env.fcmClientEmail,
    sub: env.fcmClientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(privateKey);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    throw new Error(`FCM auth failed: ${response.status}`);
  }

  const data = await response.json();
  fcmAccessTokenCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

// Android notification channel configuration
const ANDROID_CHANNEL_CONFIG: Record<string, { importance: string; sound: string }> = {
  default: { importance: "DEFAULT", sound: "default" },
  messages: { importance: "HIGH", sound: "message.mp3" },
  listings: { importance: "DEFAULT", sound: "listing.mp3" },
  alerts: { importance: "MAX", sound: "alert.mp3" },
  updates: { importance: "LOW", sound: "default" },
  social: { importance: "DEFAULT", sound: "social.mp3" },
};

async function sendFcm(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  const circuitName = getCircuitName("android");

  try {
    return await withCircuitBreaker(
      circuitName,
      async () => {
        const accessToken = await getFcmAccessToken();

        // Android-specific options
        const androidOptions = payload.android || {};
        const channelId = androidOptions.channelId || "default";
        const channelConfig = ANDROID_CHANNEL_CONFIG[channelId] || ANDROID_CHANNEL_CONFIG.default;

        // Generate deep link URL if provided
        const deepLinkUrl = payload.deepLink
          ? generateDeepLink("android", payload.deepLink)
          : payload.url;

        // Map visibility to Android enum
        const visibilityMap: Record<string, number> = {
          private: 0,
          public: 1,
          secret: -1,
        };

        const fcmPayload = {
          message: {
            token: device.token,
            notification: {
              title: payload.title,
              body: payload.body,
              image: payload.image,
            },
            android: {
              priority: payload.priority === "normal" ? "NORMAL" : "HIGH",
              ttl: `${payload.ttl || 86400}s`,
              collapse_key: payload.collapseKey,
              restricted_package_name: "com.flutterflow.foodshare",
              notification: {
                icon: androidOptions.smallIcon || payload.icon || "ic_notification",
                color: "#FF2D55", // Brand color
                sound: channelConfig.sound,
                tag: payload.tag,
                click_action: "OPEN_URL",
                // Android-specific options
                channel_id: channelId,
                visibility: androidOptions.visibility
                  ? visibilityMap[androidOptions.visibility]
                  : undefined,
                notification_priority: channelConfig.importance === "HIGH" ? "PRIORITY_HIGH" : "PRIORITY_DEFAULT",
                default_sound: true,
                default_vibrate_timings: !androidOptions.vibrationPattern,
                default_light_settings: !androidOptions.lightColor,
                local_only: androidOptions.localOnly,
                ticker: androidOptions.ticker || payload.title,
                sticky: androidOptions.ongoing,
                image: payload.image,
              },
            },
            data: {
              type: payload.type,
              url: deepLinkUrl || "/",
              // Include deep link info for client-side handling
              deepLinkType: payload.deepLink?.entityType || "",
              deepLinkId: payload.deepLink?.entityId || "",
              // Group info
              groupKey: androidOptions.groupKey || "",
              groupSummary: String(androidOptions.groupSummary || false),
              ...payload.data,
            },
          },
        };

        // Add large icon if provided
        if (androidOptions.largeIcon) {
          (fcmPayload.message.android.notification as Record<string, unknown>).image = androidOptions.largeIcon;
        }

        // Add vibration pattern if provided
        if (androidOptions.vibrationPattern) {
          (fcmPayload.message.android.notification as Record<string, unknown>).vibrate_timings =
            androidOptions.vibrationPattern.map(ms => `${ms / 1000}s`);
        }

        // Add light color if provided
        if (androidOptions.lightColor) {
          (fcmPayload.message.android.notification as Record<string, unknown>).light_settings = {
            color: { red: 1, green: 0, blue: 0.33 }, // Brand pink
            light_on_duration: "0.5s",
            light_off_duration: "1s",
          };
        }

        const response = await withOperationTimeout(
          fetch(
            `https://fcm.googleapis.com/v1/projects/${env.fcmProjectId}/messages:send`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fcmPayload),
            }
          ),
          "push"
        );

        if (response.ok) {
          const data = await response.json();
          return { success: true, platform: "android" as Platform, messageId: data.name };
        }

        const errorBody = await response.json().catch(() => ({}));
        const errorCode = errorBody.error?.details?.[0]?.errorCode || errorBody.error?.code;

        const invalidTokenCodes = ["UNREGISTERED", "INVALID_ARGUMENT"];
        const isInvalidToken = invalidTokenCodes.includes(errorCode);

        if (isInvalidToken) {
          return {
            success: false,
            platform: "android" as Platform,
            token: device.token,
            error: errorBody.error?.message || `HTTP ${response.status}`,
            errorCode,
            retryable: false,
          };
        }

        throw new Error(errorBody.error?.message || `HTTP ${response.status}`);
      },
      { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 }
    );
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return { success: false, platform: "android", error: "Circuit open", retryable: true };
    }
    return {
      success: false,
      platform: "android",
      error: (e as Error).message,
      retryable: true
    };
  }
}

// ============================================================================
// Web Push Provider
// ============================================================================

let webPushInitialized = false;

function initWebPush(): boolean {
  if (webPushInitialized) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;

  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  webPushInitialized = true;
  return true;
}

async function sendWebPush(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  const circuitName = getCircuitName("web");

  if (!initWebPush()) {
    return { success: false, platform: "web", error: "VAPID not configured" };
  }

  if (!device.endpoint || !device.p256dh || !device.auth) {
    return { success: false, platform: "web", error: "Invalid subscription" };
  }

  const subscription = {
    endpoint: device.endpoint,
    keys: { p256dh: device.p256dh, auth: device.auth },
  };

  // Web-specific options
  const webOptions = payload.web || {};

  // Generate deep link URL if provided
  const deepLinkUrl = payload.deepLink
    ? generateDeepLink("web", payload.deepLink)
    : payload.url;

  const webPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || "/logo192.png",
    badge: payload.badge || "/favicon-32x32.png",
    image: payload.image,
    tag: payload.tag || payload.type,
    data: {
      url: deepLinkUrl || "/",
      type: payload.type,
      // Include deep link info for client-side handling
      deepLinkType: payload.deepLink?.entityType || "",
      deepLinkId: payload.deepLink?.entityId || "",
      ...payload.data,
    },
    actions: payload.actions,
    // Web-specific options
    requireInteraction: webOptions.requireInteraction ?? false,
    renotify: webOptions.renotify ?? true,
    silent: webOptions.silent ?? false,
    vibrate: webOptions.vibrate,
    timestamp: webOptions.timestamp || Date.now(),
    dir: webOptions.dir || "auto",
  });

  try {
    return await withCircuitBreaker(
      circuitName,
      async () => {
        const result = await webpush.sendNotification(subscription, webPayload, {
          TTL: payload.ttl || 86400,
          urgency: payload.priority === "normal" ? "normal" : "high",
        });

        return { success: true, platform: "web" as Platform, messageId: result.headers?.location };
      },
      { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 }
    );
  } catch (e: unknown) {
    if (e instanceof CircuitBreakerError) {
      return { success: false, platform: "web", error: "Circuit open", retryable: true };
    }

    const err = e as { statusCode?: number; body?: string };
    const isInvalidSubscription = err.statusCode === 404 || err.statusCode === 410;

    return {
      success: false,
      platform: "web",
      token: device.endpoint,
      error: err.body || String(e),
      errorCode: String(err.statusCode),
      retryable: !isInvalidSubscription && (err.statusCode || 0) >= 500,
    };
  }
}

// ============================================================================
// Quiet Hours & Queue Integration
// ============================================================================

/**
 * Check if user is in quiet hours
 */
async function checkQuietHours(
  supabase: SupabaseClient,
  userId: string
): Promise<{ inQuietHours: boolean; resumeAt?: string }> {
  try {
    const { data } = await supabase.rpc("check_quiet_hours", { p_user_id: userId });
    if (data?.inQuietHours) {
      return { inQuietHours: true, resumeAt: data.resumeAt };
    }
  } catch {
    // If check fails, assume not in quiet hours
  }
  return { inQuietHours: false };
}

/**
 * Queue notification for later delivery or consolidation
 */
async function queueNotification(
  supabase: SupabaseClient,
  userId: string,
  payload: PushPayload,
  options: {
    consolidationKey?: string;
    scheduledFor?: string;
    priority?: number;
  }
): Promise<{ queued: boolean; queueId?: string }> {
  try {
    const { data, error } = await supabase.rpc("queue_notification", {
      p_user_id: userId,
      p_type: payload.type,
      p_title: payload.title,
      p_body: payload.body,
      p_data: payload.data || {},
      p_consolidation_key: options.consolidationKey || null,
      p_scheduled_for: options.scheduledFor || null,
      p_priority: options.priority || 5,
    });

    if (error) {
      logger.warn("Failed to queue notification", { error: error.message });
      return { queued: false };
    }

    return { queued: true, queueId: data?.queueId };
  } catch {
    return { queued: false };
  }
}

/**
 * Filter users by quiet hours setting
 */
async function filterByQuietHours(
  supabase: SupabaseClient,
  userIds: string[],
  bypassQuietHours: boolean
): Promise<{ sendNow: string[]; deferred: Array<{ userId: string; resumeAt: string }> }> {
  if (bypassQuietHours || userIds.length === 0) {
    return { sendNow: userIds, deferred: [] };
  }

  const sendNow: string[] = [];
  const deferred: Array<{ userId: string; resumeAt: string }> = [];

  // Check quiet hours in parallel for all users
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const status = await checkQuietHours(supabase, userId);
      return { userId, ...status };
    })
  );

  for (const result of results) {
    if (result.inQuietHours && result.resumeAt) {
      deferred.push({ userId: result.userId, resumeAt: result.resumeAt });
    } else {
      sendNow.push(result.userId);
    }
  }

  return { sendNow, deferred };
}

// ============================================================================
// Token Management
// ============================================================================

async function removeInvalidTokens(
  supabase: SupabaseClient,
  results: SendResult[]
): Promise<number> {
  const invalidTokens = results.filter((r) => !r.success && !r.retryable && r.token);

  if (!invalidTokens.length) return 0;

  let removed = 0;

  for (const result of invalidTokens) {
    if (result.platform === "web" && result.token?.startsWith("http")) {
      await supabase.from("device_tokens").delete().eq("endpoint", result.token);
    } else if (result.token) {
      await supabase
        .from("device_tokens")
        .delete()
        .eq("token", result.token)
        .eq("platform", result.platform);
    }
    removed++;
  }

  if (removed > 0) {
    logger.info("Removed invalid tokens", { count: removed });
  }

  return removed;
}

async function getDeviceTokens(
  supabase: SupabaseClient,
  userIds: string[],
  platforms?: Platform[]
): Promise<DeviceToken[]> {
  let query = supabase
    .from("device_tokens")
    .select("profile_id, token, platform, endpoint, p256dh, auth")
    .in("profile_id", userIds);

  if (platforms?.length) {
    query = query.in("platform", platforms);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to fetch tokens", { error: error.message });
    return [];
  }

  return (data as DeviceToken[]) || [];
}

// ============================================================================
// Batch Processing
// ============================================================================

async function processBatch(
  devices: DeviceToken[],
  payload: PushPayload,
  concurrency: number
): Promise<SendResult[]> {
  const results: SendResult[] = [];

  // Process in chunks
  for (let i = 0; i < devices.length; i += concurrency) {
    const chunk = devices.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (device) => {
        const sendFn = async (): Promise<SendResult> => {
          switch (device.platform) {
            case "ios":
              return sendApns(device, payload);
            case "android":
              return sendFcm(device, payload);
            case "web":
              return sendWebPush(device, payload);
            default:
              return {
                success: false,
                platform: device.platform,
                error: "Unknown platform",
              };
          }
        };

        try {
          // Use shared retry with standard preset
          return await withRetry(sendFn, {
            ...RETRY_PRESETS.standard,
            shouldRetry: (error, result) => {
              // Retry on retryable errors
              if (result && "retryable" in result) {
                return (result as SendResult).retryable === true;
              }
              return true;
            },
          });
        } catch (e) {
          return {
            success: false,
            platform: device.platform,
            token: device.platform === "web" ? device.endpoint : device.token,
            error: (e as Error).message,
          } as SendResult;
        }
      })
    );

    results.push(...chunkResults);
  }

  return results;
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  // Use request context for tracing
  return handleWithContext(req, "send-push-notification", async () => {
    const ctx = getContext()!;
    const corsHeaders = getCorsHeaders(req);
    const supabase = getSupabaseClient();

    try {
      // Parse and validate request with Zod schema
      const rawRequest = await req.json();
      const parseResult = sendRequestSchema.safeParse(rawRequest);

      if (!parseResult.success) {
        const errors = parseResult.error.errors.map(e => ({
          field: e.path.join("."),
          message: e.message,
        }));
        recordMetricFromContext("send-push-notification", 400, { errorCode: "VALIDATION_ERROR" });
        return createErrorResponse(
          `Validation failed: ${errors.map(e => e.message).join(", ")}`,
          400,
          ctx.requestId,
          corsHeaders
        );
      }

      const request = parseResult.data;
      const { user_ids, tokens, platforms, payload, options } = request;

      // Get device tokens
      let deviceTokens: DeviceToken[] = [];
      let deferredCount = 0;
      let queuedCount = 0;

      // Mutable copy of payload (Zod parsed data is readonly)
      const mutablePayload = { ...payload };

      if (user_ids?.length) {
        // Map notification type to category for preference checking
        const category = mapTypeToCategory(mutablePayload.type) as NotificationCategory;
        const bypassPrefs = options?.bypassQuietHours || shouldBypassPreferences(mutablePayload.type);

        // Check notification preferences using enterprise system
        const { sendNow, deferred, blocked } = await checkNotificationPreferences(
          supabase,
          user_ids,
          {
            category,
            channel: "push",
            bypassPreferences: bypassPrefs,
          }
        );

        // Log blocked notifications
        if (blocked.length > 0) {
          logger.info("Notifications blocked by preferences", {
            count: blocked.length,
            reasons: blocked.reduce((acc, b) => {
              acc[b.reason] = (acc[b.reason] || 0) + 1;
              return acc;
            }, {} as Record<string, number>),
          });
        }

        // Queue notifications for users in quiet hours or with deferred delivery
        if (deferred.length > 0) {
          for (const { userId, scheduleFor } of deferred) {
            if (options?.useQueue !== false && scheduleFor) {
              await queueNotification(supabase, userId, mutablePayload as PushPayload, {
                consolidationKey: options?.consolidationKey,
                scheduledFor: scheduleFor,
                priority: options?.priority === "high" ? 10 : 5,
              });
              queuedCount++;
            }
          }
          deferredCount = deferred.length;
          logger.info("Deferred notifications", { count: deferredCount });
        }

        // Get tokens only for users we're sending to now
        if (sendNow.length > 0) {
          deviceTokens = await getDeviceTokens(supabase, sendNow, platforms);
        }
      } else if (tokens?.length) {
        // Direct token mode
        deviceTokens = tokens.map((t) => ({
          profile_id: "",
          token: t.token,
          platform: t.platform,
        }));
      }
      // Note: Zod schema already validates that user_ids or tokens is provided

      if (!deviceTokens.length && deferredCount === 0) {
        recordMetricFromContext("send-push-notification", 200);
        return createSuccessResponse(
          { sent: 0, failed: 0, message: "No device tokens found" },
          ctx.requestId,
          corsHeaders
        );
      }

      // If all notifications were deferred, return early
      if (!deviceTokens.length && deferredCount > 0) {
        recordMetricFromContext("send-push-notification", 200);
        return createSuccessResponse(
          {
            sent: 0,
            failed: 0,
            deferred: deferredCount,
            queued: queuedCount,
            message: "All notifications deferred due to quiet hours",
          },
          ctx.requestId,
          corsHeaders
        );
      }

      // Apply options to mutable payload
      if (options?.priority) mutablePayload.priority = options.priority;
      if (options?.ttl) mutablePayload.ttl = options.ttl;

      // Dry run mode
      if (options?.dryRun) {
        recordMetricFromContext("send-push-notification", 200, { metadata: { dryRun: true } });
        return createSuccessResponse(
          {
            dryRun: true,
            wouldSend: deviceTokens.length,
            byPlatform: {
              ios: deviceTokens.filter((d) => d.platform === "ios").length,
              android: deviceTokens.filter((d) => d.platform === "android").length,
              web: deviceTokens.filter((d) => d.platform === "web").length,
            },
          },
          ctx.requestId,
          corsHeaders
        );
      }

      // Process notifications
      const results = await processBatch(deviceTokens, mutablePayload as PushPayload, CONFIG.concurrency);

      // Cleanup invalid tokens
      const tokensRemoved = await removeInvalidTokens(supabase, results);

      // Calculate metrics
      const metrics: Metrics = {
        total: results.length,
        sent: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        retried: 0,
        byPlatform: {
          ios: {
            sent: results.filter((r) => r.platform === "ios" && r.success).length,
            failed: results.filter((r) => r.platform === "ios" && !r.success).length,
          },
          android: {
            sent: results.filter((r) => r.platform === "android" && r.success).length,
            failed: results.filter((r) => r.platform === "android" && !r.success).length,
          },
          web: {
            sent: results.filter((r) => r.platform === "web" && r.success).length,
            failed: results.filter((r) => r.platform === "web" && !r.success).length,
          },
        },
        latencyMs: getElapsedMs(),
        tokensRemoved,
      };

      logger.info("Push notifications sent", metrics);

      // Record metric
      recordMetricFromContext("send-push-notification", 200, {
        metadata: {
          total: metrics.total,
          sent: metrics.sent,
          failed: metrics.failed,
        },
      });

      // Get circuit statuses using shared utility
      const circuitStatuses = {
        ios: getCircuitStatus(getCircuitName("ios"))?.state || "closed",
        android: getCircuitStatus(getCircuitName("android"))?.state || "closed",
        web: getCircuitStatus(getCircuitName("web"))?.state || "closed",
      };

      // Flush metrics before responding
      await flushMetrics();

      return createSuccessResponse(
        {
          ...metrics,
          deferred: deferredCount,
          queued: queuedCount,
          circuits: circuitStatuses,
        },
        ctx.requestId,
        corsHeaders
      );
    } catch (e) {
      const error = e as Error;
      logger.error("Push notification error", { error: error.message, stack: error.stack });

      // Report to Sentry
      await captureException(error, { handler: "send-push-notification" });

      // Record error metric
      recordMetricFromContext("send-push-notification", 500, {
        errorCode: "INTERNAL_ERROR",
        errorMessage: error.message,
      });

      return createErrorResponse(error.message, 500, ctx.requestId, corsHeaders);
    }
  });
});
