/**
 * Email Channel Adapter
 *
 * Integrates with the existing email service from _shared/email/
 * Supports 4 providers: Resend, Brevo, AWS SES, MailerSend
 *
 * @module api-v1-notifications/channels/email
 */

import { getEmailService } from "../../../_shared/email/index.ts";
import type {
  ChannelAdapter,
  ChannelDeliveryResult,
  NotificationContext,
  EmailPayload,
} from "../types.ts";
import { logger } from "../../../_shared/logger.ts";

export class EmailChannelAdapter implements ChannelAdapter {
  name = "email";
  channel = "email" as const;

  private emailService = getEmailService();

  async send(
    payload: EmailPayload,
    context: NotificationContext
  ): Promise<ChannelDeliveryResult> {
    const startTime = performance.now();

    try {
      logger.info("Sending email notification", {
        requestId: context.requestId,
        to: payload.to,
        subject: payload.subject,
      });

      // Determine email type for provider selection
      const emailType = this.determineEmailType(payload);

      // Send email using the unified email service
      const result = await this.emailService.sendEmail(
        {
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          from: payload.from,
          replyTo: payload.replyTo,
          attachments: payload.attachments,
        },
        emailType
      );

      const duration = performance.now() - startTime;

      if (result.sent) {
        logger.info("Email sent successfully", {
          requestId: context.requestId,
          to: payload.to,
          provider: result.provider,
          messageId: result.messageId,
          durationMs: Math.round(duration),
        });

        return {
          channel: "email",
          success: true,
          provider: result.provider,
          deliveredTo: [payload.to],
          attemptedAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
        };
      } else {
        logger.warn("Email send failed", {
          requestId: context.requestId,
          to: payload.to,
          error: result.error,
          durationMs: Math.round(duration),
        });

        return {
          channel: "email",
          success: false,
          error: result.error || "Failed to send email",
          attemptedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error("Email channel error", error as Error, {
        requestId: context.requestId,
        to: payload.to,
      });

      return {
        channel: "email",
        success: false,
        error: (error as Error).message,
        attemptedAt: new Date().toISOString(),
      };
    }
  }

  async sendBatch(
    payloads: EmailPayload[],
    context: NotificationContext
  ): Promise<ChannelDeliveryResult[]> {
    logger.info("Sending batch email notifications", {
      requestId: context.requestId,
      count: payloads.length,
    });

    // Send emails in parallel with concurrency limit
    const BATCH_SIZE = 10;
    const results: ChannelDeliveryResult[] = [];

    for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
      const batch = payloads.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((payload) => this.send(payload, context))
      );
      results.push(...batchResults);
    }

    const successCount = results.filter((r) => r.success).length;
    logger.info("Batch email notifications completed", {
      requestId: context.requestId,
      total: payloads.length,
      succeeded: successCount,
      failed: payloads.length - successCount,
    });

    return results;
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    latencyMs?: number;
    error?: string;
  }> {
    try {
      const startTime = performance.now();

      // Check health of all email providers
      const health = await this.emailService.checkAllHealth();
      const latencyMs = Math.round(performance.now() - startTime);

      // Consider healthy if at least one provider is operational
      const anyHealthy = Object.values(health).some((p) => p.operational);

      return {
        healthy: anyHealthy,
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
   * Determine email type for provider selection
   */
  private determineEmailType(payload: EmailPayload): string {
    if (payload.template) {
      // Template-based email type detection
      if (payload.template.includes("welcome")) return "welcome";
      if (payload.template.includes("verify")) return "auth";
      if (payload.template.includes("password")) return "auth";
      if (payload.template.includes("digest")) return "newsletter";
    }

    // Default based on content
    if (payload.subject.toLowerCase().includes("verify")) return "auth";
    if (payload.subject.toLowerCase().includes("reset")) return "auth";
    if (payload.subject.toLowerCase().includes("message")) return "chat";
    if (payload.subject.toLowerCase().includes("digest")) return "newsletter";

    return "notification";
  }
}

/**
 * Get user email from profile
 */
export async function getUserEmail(
  context: NotificationContext,
  userId: string
): Promise<string | null> {
  try {
    const { data, error } = await context.supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (error || !data?.email) {
      logger.warn("User email not found", { userId });
      return null;
    }

    return data.email;
  } catch (error) {
    logger.error("Failed to get user email", error as Error, { userId });
    return null;
  }
}

/**
 * Check if email is suppressed
 */
export async function isEmailSuppressed(
  context: NotificationContext,
  email: string
): Promise<boolean> {
  try {
    const { data, error } = await context.supabase
      .from("email_suppressions")
      .select("email")
      .eq("email", email.toLowerCase())
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .single();

    if (error && error.code !== "PGRST116") {
      // Not found error is OK
      logger.warn("Error checking email suppression", { email, error: error.message });
    }

    return !!data;
  } catch (error) {
    logger.error("Failed to check email suppression", error as Error, { email });
    return false; // Fail open
  }
}
