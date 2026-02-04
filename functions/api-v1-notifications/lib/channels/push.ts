/**
 * Push Notification Channel Adapter
 *
 * Integrates with push notification providers:
 * - FCM (Firebase Cloud Messaging) for Android
 * - APNs (Apple Push Notification service) for iOS
 * - Web Push (VAPID) for browsers
 *
 * Uses the existing send-push-notification infrastructure.
 *
 * @module api-v1-notifications/channels/push
 */

import type {
  ChannelAdapter,
  ChannelDeliveryResult,
  NotificationContext,
  PushPayload,
  DeviceToken,
} from "../types.ts";
import { logger } from "../../../_shared/logger.ts";
import { withCircuitBreaker } from "../../../_shared/circuit-breaker.ts";

export class PushChannelAdapter implements ChannelAdapter {
  name = "push";
  channel = "push" as const;

  async send(
    payload: PushPayload,
    context: NotificationContext
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

      // Get user's device tokens
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

      // Call the existing send-push-notification function
      const result = await this.sendToDevices(payload, devices, context);

      const duration = performance.now() - startTime;

      logger.info("Push notification completed", {
        requestId: context.requestId,
        userId: context.userId,
        delivered: result.deliveredTo?.length || 0,
        failed: result.failedDevices?.length || 0,
        durationMs: Math.round(duration),
      });

      return result;
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
    context: NotificationContext
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
        batch.map((payload) => this.send(payload, context))
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

      // Check if FCM and APNs credentials are available
      const fcmConfigured = !!(
        Deno.env.get("FCM_PROJECT_ID") &&
        Deno.env.get("FCM_CLIENT_EMAIL") &&
        Deno.env.get("FCM_PRIVATE_KEY")
      );

      const apnsConfigured = !!(
        Deno.env.get("APNS_KEY_ID") &&
        Deno.env.get("APNS_PRIVATE_KEY") &&
        Deno.env.get("APPLE_TEAM_ID")
      );

      const latencyMs = Math.round(performance.now() - startTime);

      return {
        healthy: fcmConfigured || apnsConfigured,
        latencyMs,
      };
    } catch (error) {
      return {
        healthy: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get user's device tokens
   */
  private async getUserDevices(
    context: NotificationContext
  ): Promise<DeviceToken[]> {
    const { data, error } = await context.supabase
      .from("device_tokens")
      .select("*")
      .eq("profile_id", context.userId!)
      .eq("is_active", true);

    if (error) {
      logger.error("Failed to get device tokens", new Error(error.message), {
        userId: context.userId,
      });
      return [];
    }

    return data || [];
  }

  /**
   * Send push notification to devices using the existing function
   */
  private async sendToDevices(
    payload: PushPayload,
    devices: DeviceToken[],
    context: NotificationContext
  ): Promise<ChannelDeliveryResult> {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    try {
      // Call send-push-notification function
      const response = await withCircuitBreaker(
        "push-notification",
        async () => {
          return await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              userId: context.userId,
              title: payload.title,
              body: payload.body,
              data: payload.data,
              imageUrl: payload.imageUrl,
              sound: payload.sound,
              badge: payload.badge,
              priority: payload.priority || "normal",
              ttl: payload.ttl,
              collapseKey: payload.collapseKey,
              channelId: payload.channelId,
              category: payload.category,
              threadId: payload.threadId,
            }),
          });
        },
        {
          failureThreshold: 5,
          resetTimeoutMs: 60000,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Push notification failed: ${errorText}`);
      }

      const result = await response.json();

      return {
        channel: "push",
        success: result.success || false,
        deliveredTo: result.deliveredTo || [],
        failedDevices: result.failedDevices || [],
        error: result.error,
        attemptedAt: new Date().toISOString(),
        deliveredAt: result.success ? new Date().toISOString() : undefined,
      };
    } catch (error) {
      logger.error("Failed to send push notification", error as Error, {
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
}

/**
 * Clean up inactive device tokens
 */
export async function cleanupInactiveTokens(
  context: NotificationContext,
  tokenIds: string[]
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
