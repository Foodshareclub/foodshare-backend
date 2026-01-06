/**
 * Notification Delivery Router
 *
 * Routes notifications to appropriate delivery channels (FCM, APNs, Web Push)
 * based on device type and user preferences.
 */

import { NotificationPayload, DeliveryResult, PriorityLevel } from "./index.ts";

// Device types
type DevicePlatform = "ios" | "android" | "web";

// Device record
interface UserDevice {
  id: string;
  user_id: string;
  platform: DevicePlatform;
  token: string;
  is_active: boolean;
  app_version?: string;
  last_seen_at?: string;
}

// Platform-specific payload
interface PlatformPayload {
  fcm?: FCMPayload;
  apns?: APNsPayload;
  webPush?: WebPushPayload;
}

// FCM payload (Android & Web)
interface FCMPayload {
  token: string;
  notification: {
    title: string;
    body: string;
    image?: string;
  };
  data: Record<string, string>;
  android?: {
    priority: "high" | "normal";
    notification: {
      channelId: string;
      sound?: string;
      clickAction?: string;
      color?: string;
      icon?: string;
    };
    ttl?: string;
    collapseKey?: string;
  };
  webpush?: {
    headers?: Record<string, string>;
    notification?: {
      icon?: string;
      badge?: string;
      actions?: Array<{ action: string; title: string }>;
    };
    fcmOptions?: {
      link?: string;
    };
  };
}

// APNs payload (iOS)
interface APNsPayload {
  deviceToken: string;
  headers: {
    "apns-priority": string;
    "apns-push-type": string;
    "apns-topic": string;
    "apns-collapse-id"?: string;
    "apns-expiration"?: string;
  };
  payload: {
    aps: {
      alert: {
        title: string;
        body: string;
        subtitle?: string;
      };
      sound?: string;
      badge?: number;
      category?: string;
      "thread-id"?: string;
      "mutable-content"?: number;
      "content-available"?: number;
    };
    data?: Record<string, unknown>;
  };
}

// Web Push payload
interface WebPushPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  payload: {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    image?: string;
    tag?: string;
    data?: Record<string, unknown>;
    actions?: Array<{ action: string; title: string }>;
    requireInteraction?: boolean;
  };
}

// Route notification to appropriate channels
export async function routeNotification(
  payload: NotificationPayload & { priority: PriorityLevel },
  devices: UserDevice[],
  preferences: any
): Promise<DeliveryResult> {
  const deliveredTo: string[] = [];
  const failedDevices: string[] = [];

  // Group devices by platform
  const devicesByPlatform = groupDevicesByPlatform(devices);

  // Send to each platform
  const results = await Promise.allSettled([
    // iOS devices
    sendToAPNs(payload, devicesByPlatform.ios),
    // Android devices
    sendToFCM(payload, devicesByPlatform.android, "android"),
    // Web clients
    sendToFCM(payload, devicesByPlatform.web, "web"),
  ]);

  // Aggregate results
  for (const result of results) {
    if (result.status === "fulfilled") {
      deliveredTo.push(...result.value.delivered);
      failedDevices.push(...result.value.failed);
    }
  }

  return {
    success: deliveredTo.length > 0,
    notificationId: payload.id ?? crypto.randomUUID(),
    deliveredTo,
    failedDevices,
    error: failedDevices.length > 0 && deliveredTo.length === 0
      ? "All delivery attempts failed"
      : undefined,
  };
}

function groupDevicesByPlatform(devices: UserDevice[]): Record<DevicePlatform, UserDevice[]> {
  return {
    ios: devices.filter((d) => d.platform === "ios"),
    android: devices.filter((d) => d.platform === "android"),
    web: devices.filter((d) => d.platform === "web"),
  };
}

// Send to Firebase Cloud Messaging (Android & Web)
async function sendToFCM(
  payload: NotificationPayload & { priority: PriorityLevel },
  devices: UserDevice[],
  platform: "android" | "web"
): Promise<{ delivered: string[]; failed: string[] }> {
  if (devices.length === 0) {
    return { delivered: [], failed: [] };
  }

  const fcmServerKey = Deno.env.get("FCM_SERVER_KEY");
  if (!fcmServerKey) {
    console.error("FCM_SERVER_KEY not configured");
    return { delivered: [], failed: devices.map((d) => d.id) };
  }

  const delivered: string[] = [];
  const failed: string[] = [];

  // Build FCM messages
  const messages = devices.map((device) => buildFCMPayload(payload, device, platform));

  // Send in batches (FCM allows up to 500 per request)
  const batchSize = 500;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);

    try {
      const response = await fetch(
        "https://fcm.googleapis.com/v1/projects/foodshare-app/messages:send",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fcmServerKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: batch }),
        }
      );

      if (response.ok) {
        const result = await response.json();
        // Track successes and failures
        result.responses?.forEach((res: any, idx: number) => {
          const deviceId = devices[i + idx].id;
          if (res.success) {
            delivered.push(deviceId);
          } else {
            failed.push(deviceId);
          }
        });
      } else {
        // Entire batch failed
        failed.push(...devices.slice(i, i + batchSize).map((d) => d.id));
      }
    } catch (error) {
      console.error("FCM send error:", error);
      failed.push(...devices.slice(i, i + batchSize).map((d) => d.id));
    }
  }

  return { delivered, failed };
}

function buildFCMPayload(
  payload: NotificationPayload & { priority: PriorityLevel },
  device: UserDevice,
  platform: "android" | "web"
): FCMPayload {
  const fcmPayload: FCMPayload = {
    token: device.token,
    notification: {
      title: payload.title,
      body: payload.body,
      image: payload.imageUrl,
    },
    data: {
      type: payload.type,
      ...(payload.data ?? {}),
    },
  };

  if (platform === "android") {
    fcmPayload.android = {
      priority: payload.priority === "critical" || payload.priority === "high" ? "high" : "normal",
      notification: {
        channelId: payload.channelId ?? getChannelForType(payload.type),
        sound: payload.sound ?? "default",
        color: "#4CAF50", // Foodshare green
      },
      collapseKey: payload.collapseKey,
      ttl: payload.ttl ? `${payload.ttl}s` : undefined,
    };
  }

  if (platform === "web") {
    fcmPayload.webpush = {
      notification: {
        icon: "/icons/notification-icon.png",
        badge: "/icons/badge-icon.png",
        actions: getActionsForType(payload.type),
      },
      fcmOptions: {
        link: getLinkForType(payload.type, payload.data),
      },
    };
  }

  return fcmPayload;
}

// Send to Apple Push Notification service (iOS)
async function sendToAPNs(
  payload: NotificationPayload & { priority: PriorityLevel },
  devices: UserDevice[]
): Promise<{ delivered: string[]; failed: string[] }> {
  if (devices.length === 0) {
    return { delivered: [], failed: [] };
  }

  const apnsKeyId = Deno.env.get("APNS_KEY_ID");
  const apnsTeamId = Deno.env.get("APNS_TEAM_ID");
  const apnsKey = Deno.env.get("APNS_KEY");

  if (!apnsKeyId || !apnsTeamId || !apnsKey) {
    console.error("APNs credentials not configured");
    return { delivered: [], failed: devices.map((d) => d.id) };
  }

  const delivered: string[] = [];
  const failed: string[] = [];

  // Generate JWT for APNs
  const jwt = await generateAPNsJWT(apnsKeyId, apnsTeamId, apnsKey);

  // APNs requires individual requests per device
  const sendPromises = devices.map(async (device) => {
    const apnsPayload = buildAPNsPayload(payload, device);

    try {
      const isProduction = Deno.env.get("ENVIRONMENT") === "production";
      const host = isProduction
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com";

      const response = await fetch(`https://${host}/3/device/${device.token}`, {
        method: "POST",
        headers: {
          Authorization: `bearer ${jwt}`,
          ...apnsPayload.headers,
        },
        body: JSON.stringify(apnsPayload.payload),
      });

      if (response.ok) {
        delivered.push(device.id);
      } else {
        const error = await response.json();
        console.error(`APNs error for device ${device.id}:`, error);
        failed.push(device.id);
      }
    } catch (error) {
      console.error(`APNs send error for device ${device.id}:`, error);
      failed.push(device.id);
    }
  });

  await Promise.allSettled(sendPromises);

  return { delivered, failed };
}

function buildAPNsPayload(
  payload: NotificationPayload & { priority: PriorityLevel },
  device: UserDevice
): APNsPayload {
  const apnsPriority = payload.priority === "critical" ? "10" : "5";
  const bundleId = Deno.env.get("IOS_BUNDLE_ID") ?? "com.foodshare.app";

  return {
    deviceToken: device.token,
    headers: {
      "apns-priority": apnsPriority,
      "apns-push-type": "alert",
      "apns-topic": bundleId,
      "apns-collapse-id": payload.collapseKey,
      "apns-expiration": payload.ttl
        ? String(Math.floor(Date.now() / 1000) + payload.ttl)
        : undefined,
    },
    payload: {
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        sound: payload.sound ?? "default",
        badge: payload.badge,
        category: payload.category ?? getCategoryForType(payload.type),
        "thread-id": payload.threadId,
        "mutable-content": payload.imageUrl ? 1 : undefined,
      },
      data: payload.data,
    },
  };
}

async function generateAPNsJWT(
  keyId: string,
  teamId: string,
  privateKey: string
): Promise<string> {
  // Create JWT header
  const header = {
    alg: "ES256",
    kid: keyId,
  };

  // Create JWT payload
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: teamId,
    iat: now,
  };

  // Encode header and claims
  const encodedHeader = btoa(JSON.stringify(header));
  const encodedClaims = btoa(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;

  // Sign with ES256 (would use proper crypto library in production)
  // For now, return a placeholder - in production use jose or similar
  const signature = await signES256(unsignedToken, privateKey);

  return `${unsignedToken}.${signature}`;
}

async function signES256(data: string, privateKey: string): Promise<string> {
  // In production, use a proper JWT library like jose
  // This is a placeholder that would be replaced with actual signing
  const encoder = new TextEncoder();
  const keyData = encoder.encode(privateKey);
  const messageData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData.slice(0, 32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, messageData);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// Helper functions for platform-specific features
function getChannelForType(type: string): string {
  const channels: Record<string, string> = {
    new_message: "messages",
    listing_favorited: "activity",
    listing_expired: "listings",
    arrangement_confirmed: "arrangements",
    arrangement_cancelled: "arrangements",
    arrangement_completed: "arrangements",
    challenge_complete: "challenges",
    challenge_reminder: "challenges",
    review_received: "reviews",
    review_reminder: "reviews",
    system_announcement: "system",
    moderation_warning: "system",
    account_security: "security",
  };
  return channels[type] ?? "default";
}

function getCategoryForType(type: string): string {
  const categories: Record<string, string> = {
    new_message: "MESSAGE",
    arrangement_confirmed: "ARRANGEMENT",
    arrangement_cancelled: "ARRANGEMENT",
    challenge_complete: "CHALLENGE",
    review_received: "REVIEW",
    account_security: "SECURITY",
  };
  return categories[type] ?? "DEFAULT";
}

function getActionsForType(type: string): Array<{ action: string; title: string }> {
  const actions: Record<string, Array<{ action: string; title: string }>> = {
    new_message: [
      { action: "reply", title: "Reply" },
      { action: "view", title: "View" },
    ],
    arrangement_confirmed: [
      { action: "view", title: "View Details" },
      { action: "message", title: "Message" },
    ],
    challenge_complete: [
      { action: "view", title: "View Reward" },
      { action: "share", title: "Share" },
    ],
  };
  return actions[type] ?? [];
}

function getLinkForType(type: string, data?: Record<string, string>): string {
  const baseUrl = Deno.env.get("WEB_APP_URL") ?? "https://foodshare.app";

  const routes: Record<string, (data?: Record<string, string>) => string> = {
    new_message: (d) => `${baseUrl}/messages/${d?.roomId ?? ""}`,
    listing_favorited: (d) => `${baseUrl}/listings/${d?.listingId ?? ""}`,
    arrangement_confirmed: (d) => `${baseUrl}/arrangements/${d?.arrangementId ?? ""}`,
    challenge_complete: (d) => `${baseUrl}/challenges/${d?.challengeId ?? ""}`,
    review_received: (d) => `${baseUrl}/reviews`,
    account_security: () => `${baseUrl}/settings/security`,
  };

  const routeBuilder = routes[type];
  return routeBuilder ? routeBuilder(data) : baseUrl;
}

export { UserDevice, PlatformPayload, DevicePlatform };
