/**
 * APNs (Apple Push Notification service) Provider
 */

import * as jose from "https://deno.land/x/jose@v5.2.0/index.ts";
import { CircuitBreakerError, withCircuitBreaker } from "../../../_shared/circuit-breaker.ts";
import { withOperationTimeout } from "../../../_shared/timeout.ts";
import type { DeviceToken, Platform, PushPayload, SendResult } from "./types.ts";
import { generateDeepLink } from "./types.ts";

const env = {
  apnsKeyId: Deno.env.get("APNS_KEY_ID"),
  apnsTeamId: Deno.env.get("APNS_TEAM_ID"),
  apnsBundleId: Deno.env.get("APNS_BUNDLE_ID") || "co.nz.foodshare.FoodShare",
  apnsPrivateKey: Deno.env.get("APNS_PRIVATE_KEY"),
  apnsEnvironment: Deno.env.get("APNS_ENVIRONMENT") || "production",
};

let apnsJwtCache: { token: string; expires: number } | null = null;

async function getApnsToken(): Promise<string> {
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

export async function sendApns(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  try {
    return await withCircuitBreaker(
      "push-ios",
      async () => {
        const jwt = await getApnsToken();
        const host = env.apnsEnvironment === "production"
          ? "api.push.apple.com"
          : "api.sandbox.push.apple.com";

        const iosOptions = payload.ios || {};
        const deepLinkUrl = payload.deepLink
          ? generateDeepLink("ios", payload.deepLink)
          : payload.url;

        const apnsPayload: Record<string, unknown> = {
          aps: {
            alert: {
              title: payload.title,
              subtitle: iosOptions.subtitle,
              body: payload.body,
            },
            sound: iosOptions.interruptionLevel === "passive"
              ? undefined
              : (payload.sound || "default"),
            badge: typeof payload.badge === "number" ? payload.badge : undefined,
            "mutable-content": 1,
            "content-available": 1,
            "thread-id": iosOptions.threadId || payload.collapseKey,
            "category": iosOptions.category,
            "interruption-level": iosOptions.interruptionLevel || "active",
            "relevance-score": iosOptions.relevanceScore,
            "target-content-id": iosOptions.targetContentId,
          },
          type: payload.type,
          url: deepLinkUrl,
          deepLink: payload.deepLink,
          ...payload.data,
        };

        if (payload.image) {
          apnsPayload["image-url"] = payload.image;
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${jwt}`,
          "apns-topic": env.apnsBundleId,
          "apns-push-type": "alert",
          "apns-priority": iosOptions.interruptionLevel === "passive"
            ? "5"
            : (payload.priority === "normal" ? "5" : "10"),
          "apns-expiration": String(Math.floor(Date.now() / 1000) + (payload.ttl || 86400)),
          "Content-Type": "application/json",
        };

        if (payload.collapseKey) {
          headers["apns-collapse-id"] = payload.collapseKey;
        }

        const response = await withOperationTimeout(
          fetch(`https://${host}/3/device/${device.token}`, {
            method: "POST",
            headers,
            body: JSON.stringify(apnsPayload),
          }),
          "push",
        );

        if (response.status === 200) {
          const apnsId = response.headers.get("apns-id");
          return { success: true, platform: "ios" as Platform, messageId: apnsId || undefined };
        }

        const errorBody = await response.json().catch(() => ({}));
        const reason = errorBody.reason || `HTTP ${response.status}`;

        const invalidTokenReasons = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"];
        const isInvalidToken = invalidTokenReasons.includes(reason) || response.status === 410;

        if (isInvalidToken) {
          return {
            success: false,
            platform: "ios" as Platform,
            token: device.token,
            error: reason,
            errorCode: reason,
            retryable: false,
          };
        }

        throw new Error(reason);
      },
      { failureThreshold: 5, resetTimeout: 60000, halfOpenRequests: 3 },
    );
  } catch (e) {
    if (e instanceof CircuitBreakerError) {
      return { success: false, platform: "ios", error: "Circuit open", retryable: true };
    }
    return {
      success: false,
      platform: "ios",
      error: (e as Error).message,
      retryable: true,
    };
  }
}
