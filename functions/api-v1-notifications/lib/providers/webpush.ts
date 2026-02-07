/**
 * Web Push Provider (VAPID)
 */

import webpush from "npm:web-push@3.6.7";
import { withCircuitBreaker, CircuitBreakerError } from "../../../_shared/circuit-breaker.ts";
import type { DeviceToken, PushPayload, SendResult } from "./types.ts";
import { generateDeepLink } from "./types.ts";

const env = {
  vapidPublicKey: Deno.env.get("VAPID_PUBLIC_KEY"),
  vapidPrivateKey: Deno.env.get("VAPID_PRIVATE_KEY"),
  vapidSubject: Deno.env.get("VAPID_SUBJECT") || "mailto:hello@foodshare.club",
};

let webPushInitialized = false;

function initWebPush(): boolean {
  if (webPushInitialized) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;

  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  webPushInitialized = true;
  return true;
}

export async function sendWebPush(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
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

  const webOptions = payload.web || {};
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
      deepLinkType: payload.deepLink?.entityType || "",
      deepLinkId: payload.deepLink?.entityId || "",
      ...payload.data,
    },
    actions: payload.actions,
    requireInteraction: webOptions.requireInteraction ?? false,
    renotify: webOptions.renotify ?? true,
    silent: webOptions.silent ?? false,
    vibrate: webOptions.vibrate,
    timestamp: webOptions.timestamp || Date.now(),
    dir: webOptions.dir || "auto",
  });

  try {
    return await withCircuitBreaker(
      "push-web",
      async () => {
        const result = await webpush.sendNotification(subscription, webPayload, {
          TTL: payload.ttl || 86400,
          urgency: payload.priority === "normal" ? "normal" : "high",
        });

        return { success: true, platform: "web", messageId: result.headers?.location };
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
