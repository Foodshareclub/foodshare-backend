/**
 * SMS Channel Adapter
 *
 * SMS notifications via Twilio REST API.
 * Includes circuit breaker protection and traced fetch for observability.
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
import { withCircuitBreaker } from "../../../_shared/circuit-breaker.ts";
import { tracedFetch } from "../../../_shared/traced-fetch.ts";

// =============================================================================
// Configuration
// =============================================================================

function getTwilioConfig(): {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
} | null {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const phoneNumber = Deno.env.get("TWILIO_PHONE_NUMBER");

  if (!accountSid || !authToken || !phoneNumber) {
    return null;
  }

  return { accountSid, authToken, phoneNumber };
}

// =============================================================================
// SMS Channel Adapter
// =============================================================================

export class SmsChannelAdapter implements ChannelAdapter {
  name = "sms";
  channel = "sms" as const;

  async send(
    payload: SmsPayload,
    context: NotificationContext,
  ): Promise<ChannelDeliveryResult> {
    try {
      const config = getTwilioConfig();

      if (!config) {
        logger.warn("SMS not configured: missing Twilio credentials", {
          requestId: context.requestId,
        });
        return {
          channel: "sms",
          success: false,
          error: "SMS not configured",
          attemptedAt: new Date().toISOString(),
        };
      }

      logger.info("Sending SMS notification via Twilio", {
        requestId: context.requestId,
        to: payload.to,
      });

      const result = await withCircuitBreaker(
        "twilio-sms",
        async () => {
          const twilioUrl =
            `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

          const body = new URLSearchParams({
            To: payload.to,
            From: payload.from || config.phoneNumber,
            Body: payload.body,
          });

          const response = await tracedFetch(
            twilioUrl,
            {
              method: "POST",
              headers: {
                "Authorization": `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: body.toString(),
            },
            "twilio.sms.send",
          );

          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Twilio API error ${response.status}: ${errorBody}`);
          }

          const data = await response.json();
          return data;
        },
        { failureThreshold: 3, resetTimeoutMs: 60000 },
      );

      logger.info("SMS sent successfully", {
        requestId: context.requestId,
        sid: result.sid,
      });

      return {
        channel: "sms",
        success: true,
        provider: "twilio",
        deliveredTo: [payload.to],
        attemptedAt: new Date().toISOString(),
        deliveredAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error("SMS channel error", error as Error, {
        requestId: context.requestId,
        to: payload.to,
      });

      return {
        channel: "sms",
        success: false,
        provider: "twilio",
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
    const config = getTwilioConfig();

    if (!config) {
      return {
        healthy: false,
        error: "SMS not configured: missing Twilio credentials",
      };
    }

    const start = Date.now();
    try {
      const response = await tracedFetch(
        `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}.json`,
        {
          method: "GET",
          headers: {
            "Authorization": `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`,
          },
        },
        "twilio.healthcheck",
      );

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          healthy: false,
          latencyMs,
          error: `Twilio health check failed: ${response.status}`,
        };
      }

      return { healthy: true, latencyMs };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: (error as Error).message,
      };
    }
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
