/**
 * FCM (Firebase Cloud Messaging) Provider - HTTP v1 API
 */

import * as jose from "https://deno.land/x/jose@v5.2.0/index.ts";
import { CircuitBreakerError, withCircuitBreaker } from "../../../_shared/circuit-breaker.ts";
import { withOperationTimeout } from "../../../_shared/timeout.ts";
import type { DeviceToken, Platform, PushPayload, SendResult } from "./types.ts";
import { generateDeepLink } from "./types.ts";

const env = {
  fcmProjectId: Deno.env.get("FCM_PROJECT_ID"),
  fcmClientEmail: Deno.env.get("FCM_CLIENT_EMAIL"),
  fcmPrivateKey: Deno.env.get("FCM_PRIVATE_KEY"),
};

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

const ANDROID_CHANNEL_CONFIG: Record<string, { importance: string; sound: string }> = {
  default: { importance: "DEFAULT", sound: "default" },
  messages: { importance: "HIGH", sound: "message.mp3" },
  listings: { importance: "DEFAULT", sound: "listing.mp3" },
  alerts: { importance: "MAX", sound: "alert.mp3" },
  updates: { importance: "LOW", sound: "default" },
  social: { importance: "DEFAULT", sound: "social.mp3" },
};

export async function sendFcm(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  try {
    return await withCircuitBreaker(
      "push-android",
      async () => {
        const accessToken = await getFcmAccessToken();

        const androidOptions = payload.android || {};
        const channelId = androidOptions.channelId || "default";
        const channelConfig = ANDROID_CHANNEL_CONFIG[channelId] || ANDROID_CHANNEL_CONFIG.default;

        const deepLinkUrl = payload.deepLink
          ? generateDeepLink("android", payload.deepLink)
          : payload.url;

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
                color: "#FF2D55",
                sound: channelConfig.sound,
                tag: payload.tag,
                click_action: "OPEN_URL",
                channel_id: channelId,
                visibility: androidOptions.visibility
                  ? visibilityMap[androidOptions.visibility]
                  : undefined,
                notification_priority: channelConfig.importance === "HIGH"
                  ? "PRIORITY_HIGH"
                  : "PRIORITY_DEFAULT",
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
              deepLinkType: payload.deepLink?.entityType || "",
              deepLinkId: payload.deepLink?.entityId || "",
              groupKey: androidOptions.groupKey || "",
              groupSummary: String(androidOptions.groupSummary || false),
              ...payload.data,
            },
          },
        };

        if (androidOptions.largeIcon) {
          (fcmPayload.message.android.notification as Record<string, unknown>).image =
            androidOptions.largeIcon;
        }

        if (androidOptions.vibrationPattern) {
          (fcmPayload.message.android.notification as Record<string, unknown>).vibrate_timings =
            androidOptions.vibrationPattern.map((ms) => `${ms / 1000}s`);
        }

        if (androidOptions.lightColor) {
          (fcmPayload.message.android.notification as Record<string, unknown>).light_settings = {
            color: { red: 1, green: 0, blue: 0.33 },
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
            },
          ),
          "push",
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
      { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 },
    );
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return { success: false, platform: "android", error: "Circuit open", retryable: true };
    }
    return {
      success: false,
      platform: "android",
      error: (e as Error).message,
      retryable: true,
    };
  }
}
