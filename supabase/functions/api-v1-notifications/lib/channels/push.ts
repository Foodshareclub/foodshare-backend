/**
 * Push Notification Channel Adapter
 *
 * Direct integration with push notification providers:
 * - FCM (Firebase Cloud Messaging) for Android
 * - APNs (Apple Push Notification service) for iOS
 * - Web Push (VAPID) for browsers
 *
 * @module api-v1-notifications/channels/push
 */

import type { ChannelAdapter, ChannelDeliveryResult, NotificationContext } from "../types.ts";
import { logger } from "../../../_shared/logger.ts";
import { RETRY_PRESETS, withRetry } from "../../../_shared/retry.ts";
import { getCircuitStatus } from "../../../_shared/circuit-breaker.ts";
import {
  type DeviceToken,
  type Platform,
  type PushPayload,
  sendApns,
  sendFcm,
  type SendResult,
  sendWebPush,
} from "../providers/index.ts";

export class PushChannelAdapter implements ChannelAdapter {
  name = "push";
  channel = "push" as const;

  async send(
    payload: PushPayload,
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult> {
    const startTime = performance.now();

    try {
      if (!context.userId) {
        return {
          channel: "push",
          success: false,
          error: "User ID required for push notifications",
          attemptedAt: new Date().toISOString(),
        };
      }

      logger.info("Sending push notification", {
        requestId: context.requestId,
        userId: context.userId,
        title: payload.title,
      });

      const devices = await this.getUserDevices(context);

      if (devices.length === 0) {
        logger.info("No device tokens found", {
          requestId: context.requestId,
          userId: context.userId,
        });

        return {
          channel: "push",
          success: false,
          error: "No device tokens registered",
          attemptedAt: new Date().toISOString(),
        };
      }

      const results = await this.sendToDevices(payload, devices, context);

      const duration = performance.now() - startTime;

      logger.info("Push notification completed", {
        requestId: context.requestId,
        userId: context.userId,
        delivered: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        durationMs: Math.round(duration),
      });

      await this.cleanupInvalidTokens(context, results);

      const deliveredTo = results
        .filter((r) => r.success)
        .map((r) => r.platform);

      return {
        channel: "push",
        success: deliveredTo.length > 0,
        deliveredTo,
        error: deliveredTo.length === 0 ? "All deliveries failed" : undefined,
        attemptedAt: new Date().toISOString(),
        deliveredAt: deliveredTo.length > 0 ? new Date().toISOString() : undefined,
      };
    } catch (error) {
      logger.error("Push channel error", error as Error, {
        requestId: context.requestId,
        userId: context.userId,
      });

      return {
        channel: "push",
        success: false,
        error: (error as Error).message,
        attemptedAt: new Date().toISOString(),
      };
    }
  }

  async sendBatch(
    payloads: PushPayload[],
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult[]> {
    logger.info("Sending batch push notifications", {
      requestId: context.requestId,
      count: payloads.length,
    });

    // Send in parallel with concurrency limit
    const BATCH_SIZE = 100;
    const results: ChannelDeliveryResult[] = [];

    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((payload) => this.send(payload, context)),
      );
      results.push(...batchResults);
    }

    return results;
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    try {
      const startTime = performance.now();

      const fcmConfigured = !!(
        Deno.env.get("FCM_PROJECT_ID") &&
        Deno.env.get("FCM_CLIENT_EMAIL") &&
        Deno.env.get("FCM_PRIVATE_KEY")
      );

      const apnsConfigured = !!(
        Deno.env.get("APNS_KEY_ID") &&
        Deno.env.get("APNS_PRIVATE_KEY") &&
        Deno.env.get("APNS_TEAM_ID")
      );

      const circuits = {
        ios: getCircuitStatus("push-ios")?.state || "closed",
        android: getCircuitStatus("push-android")?.state || "closed",
        web: getCircuitStatus("push-web")?.state || "closed",
      };

      const latencyMs = Math.round(performance.now() - startTime);

      return {
        healthy: (fcmConfigured || apnsConfigured) &&
          Object.values(circuits).every((s) => s !== "open"),
        latencyMs,
      };
    } catch (error) {
      return {
        healthy: false,
        error: (error as Error).message,
      };
    }
  }

  private async getUserDevices(context: NotificationContext): Promise<DeviceToken[]> {
    const { data, error } = await context.supabase
      .from("device_tokens")
      .select("profile_id, token, platform, endpoint, p256dh, auth")
      .eq("profile_id", context.userId!)
      .eq("is_active", true);

    if (error) {
      logger.error("Failed to get device tokens", new Error(error.message), {
        userId: context.userId,
      });
      return [];
    }

    return (data || []) as DeviceToken[];
  }

  private async sendToDevices(
    payload: PushPayload,
    devices: DeviceToken[],
    _context: NotificationContext,
  ): Promise<SendResult[]> {
    const CONCURRENCY = 10;
    const results: SendResult[] = [];

    for (let i = 0; i < devices.length; i += CONCURRENCY) {
      const chunk = devices.slice(i, i + CONCURRENCY);

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
                  platform: device.platform as Platform,
                  error: "Unknown platform",
                };
            }
          };

          try {
            return await withRetry(sendFn, {
              ...RETRY_PRESETS.standard,
              shouldRetry: (_error, result) => {
                if (result && "retryable" in result) {
                  return (result as SendResult).retryable === true;
                }
                return true;
              },
            });
          } catch (e) {
            return {
              success: false,
              platform: device.platform as Platform,
              token: device.platform === "web" ? device.endpoint : device.token,
              error: (e as Error).message,
            } as SendResult;
          }
        }),
      );

      results.push(...chunkResults);
    }

    return results;
  }

  private async cleanupInvalidTokens(
    context: NotificationContext,
    results: SendResult[],
  ): Promise<void> {
    const invalidTokens = results.filter((r) => !r.success && !r.retryable && r.token);

    if (!invalidTokens.length) return;

    for (const result of invalidTokens) {
      try {
        if (result.platform === "web" && result.token?.startsWith("http")) {
          await context.supabase.from("device_tokens").delete().eq("endpoint", result.token);
        } else if (result.token) {
          await context.supabase
            .from("device_tokens")
            .delete()
            .eq("token", result.token)
            .eq("platform", result.platform);
        }
      } catch (error) {
        logger.error("Failed to cleanup token", error as Error, {
          platform: result.platform,
          token: result.token?.substring(0, 20),
        });
      }
    }

    logger.info("Cleaned up invalid tokens", { count: invalidTokens.length });
  }
}

export async function cleanupInactiveTokens(
  context: NotificationContext,
  tokenIds: string[],
): Promise<void> {
  if (tokenIds.length === 0) return;

  try {
    await context.supabase
      .from("device_tokens")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in("id", tokenIds);

    logger.info("Cleaned up inactive device tokens", {
      count: tokenIds.length,
    });
  } catch (error) {
    logger.error("Failed to cleanup device tokens", error as Error, {
      tokenIds,
    });
  }
}
