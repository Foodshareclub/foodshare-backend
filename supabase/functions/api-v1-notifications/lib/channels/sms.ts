/**
 * SMS Channel Adapter
 *
 * SMS notifications via Twilio (or other SMS providers).
 * Currently placeholder for future implementation.
 *
 * @module api-v1-notifications/channels/sms
 */

import type {
  ChannelAdapter,
  ChannelDeliveryResult,
  NotificationContext,
  SmsPayload,
} from "../types.ts";
import { logger } from "../../../_shared/logger.ts";

export class SmsChannelAdapter implements ChannelAdapter {
  name = "sms";
  channel = "sms" as const;

  async send(
    payload: SmsPayload,
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult> {
    try {
      logger.info("Sending SMS notification", {
        requestId: context.requestId,
        to: payload.to,
      });

      // TODO: Implement SMS sending via Twilio or other provider
      // For now, return not implemented

      logger.warn("SMS notifications not yet implemented", {
        requestId: context.requestId,
      });

      return {
        channel: "sms",
        success: false,
        error: "SMS notifications not yet implemented",
        attemptedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("SMS channel error", error as Error, {
        requestId: context.requestId,
        to: payload.to,
      });

      return {
        channel: "sms",
        success: false,
        error: (error as Error).message,
        attemptedAt: new Date().toISOString(),
      };
    }
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    // SMS not yet implemented
    return {
      healthy: false,
      error: "SMS not yet implemented",
    };
  }
}

/**
 * Get user phone number from preferences
 */
export async function getUserPhoneNumber(
  context: NotificationContext,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await context.supabase.rpc(
      "get_notification_preferences",
      {
        p_user_id: userId,
      },
    );

    if (error || !data?.settings?.phone_number) {
      return null;
    }

    // Check if phone is verified
    if (!data.settings.phone_verified) {
      logger.info("Phone number not verified", { userId });
      return null;
    }

    return data.settings.phone_number;
  } catch (error) {
    logger.error("Failed to get user phone number", error as Error, { userId });
    return null;
  }
}
