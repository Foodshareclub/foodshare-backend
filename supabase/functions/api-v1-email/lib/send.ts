/**
 * Direct email sending handlers
 *
 * - POST /send — Send a single email (JWT auth)
 * - POST /send/template — Send using a named template slug (JWT auth)
 * - POST /send/invitation — Send invitation to non-user (JWT auth)
 * - GET  /providers — Provider health + quota status (service auth)
 * - GET  /health — Health check (no auth)
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { type HandlerContext, ok } from "../../_shared/api-handler.ts";
import { AppError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import {
  type EmailType,
  getEmailService,
  type SendTemplateEmailParams,
} from "../../_shared/email/index.ts";
import { escapeHtml, requireServiceAuth, VERSION } from "./utils.ts";
import type { sendInvitationSchema, sendSchema, sendTemplateSchema } from "./schemas.ts";

// =============================================================================
// Invitation Email Builder
// =============================================================================

function buildInvitationEmail(
  senderName: string,
  message?: string,
): { subject: string; html: string } {
  const personalMessage = message
    ? `<p style="color: #555; font-style: italic; border-left: 3px solid #2ECC71; padding-left: 12px; margin: 20px 0;">"${
      escapeHtml(message)
    }"</p>`
    : "";

  const subject = `${senderName} invited you to join FoodShare!`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join FoodShare</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2ECC71; font-size: 28px; margin: 0 0 10px;">You're Invited!</h1>
        <p style="color: #666; font-size: 16px; margin: 0;">${
    escapeHtml(senderName)
  } wants you to join FoodShare</p>
      </div>
      ${personalMessage}
      <div style="background: #f8faf8; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <h2 style="color: #333; font-size: 18px; margin: 0 0 12px;">What is FoodShare?</h2>
        <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0;">
          FoodShare connects people in your community to share surplus food instead of throwing it away.
          Whether you have extra groceries, leftover party food, or garden produce, someone nearby could use it!
        </p>
      </div>
      <div style="text-align: center; margin: 32px 0;">
        <a href="https://foodshare.club/invite"
           style="display: inline-block; background: linear-gradient(135deg, #2ECC71, #27AE60); color: white; padding: 16px 40px; border-radius: 30px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(46, 204, 113, 0.4);">
          Join FoodShare
        </a>
      </div>
      <div style="text-align: center; padding-top: 24px; border-top: 1px solid #eee;">
        <p style="color: #999; font-size: 12px; margin: 0;">
          This invitation was sent by ${escapeHtml(senderName)} via FoodShare.
        </p>
        <p style="color: #999; font-size: 12px; margin: 8px 0 0;">
          <a href="https://foodshare.club" style="color: #2ECC71; text-decoration: none;">foodshare.club</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;

  return { subject, html };
}

// =============================================================================
// Route Handlers
// =============================================================================

/** POST /send — Send a single email (JWT auth) */
export async function handleSend(
  ctx: HandlerContext<z.infer<typeof sendSchema>>,
): Promise<Response> {
  if (!ctx.userId) {
    throw new ValidationError("Authentication required");
  }

  const { to, subject, html, text, replyTo, tags, emailType } = ctx.body;

  const emailService = getEmailService();
  const result = await emailService.sendEmail(
    { to, subject, html, text, replyTo, tags },
    emailType as EmailType,
  );

  if (!result.success) {
    throw new AppError(
      result.error || "Failed to send email",
      "EMAIL_SEND_FAILED",
      502,
    );
  }

  return ok(
    {
      messageId: result.messageId,
      provider: result.provider,
      latencyMs: result.latencyMs,
    },
    ctx,
  );
}

/** POST /send/template — Send using a named template slug (JWT auth) */
export async function handleSendTemplate(
  ctx: HandlerContext<z.infer<typeof sendTemplateSchema>>,
): Promise<Response> {
  if (!ctx.userId) {
    throw new ValidationError("Authentication required");
  }

  const { to, slug, variables, emailType } = ctx.body;

  const emailService = getEmailService();
  const params: SendTemplateEmailParams = { to, slug, variables };
  const result = await emailService.sendTemplateEmail(params, emailType as EmailType);

  if (!result.success) {
    throw new AppError(
      result.error || "Failed to send template email",
      "TEMPLATE_SEND_FAILED",
      502,
    );
  }

  return ok(
    {
      messageId: result.messageId,
      provider: result.provider,
      latencyMs: result.latencyMs,
    },
    ctx,
  );
}

/** POST /send/invitation — Send invitation to non-user (JWT auth) */
export async function handleSendInvitation(
  ctx: HandlerContext<z.infer<typeof sendInvitationSchema>>,
): Promise<Response> {
  if (!ctx.userId) {
    throw new ValidationError("Authentication required");
  }

  const { recipientEmail, senderName, message } = ctx.body;
  const { subject, html } = buildInvitationEmail(senderName, message);

  logger.info("Sending invitation email", {
    recipientEmail: recipientEmail.substring(0, 3) + "***",
    senderName,
    userId: ctx.userId,
  });

  const emailService = getEmailService();
  const result = await emailService.sendEmail(
    {
      to: recipientEmail,
      subject,
      html,
      tags: ["invitation", "referral"],
      metadata: {
        type: "invitation",
        sender_id: ctx.userId,
        sender_name: senderName,
      },
    },
    "notification",
  );

  if (!result.success) {
    throw new AppError(
      result.error || "Failed to send invitation",
      "INVITATION_SEND_FAILED",
      502,
    );
  }

  // Log analytics (non-blocking)
  ctx.supabase.from("post_activity_logs").insert({
    actor_id: ctx.userId,
    activity_type: "shared",
    notes: `invitation:email=${recipientEmail.substring(0, 3)}***`,
  }).then(undefined, () => {/* analytics failure is non-critical */});

  return ok(
    {
      messageId: result.messageId,
      provider: result.provider,
      latencyMs: result.latencyMs,
    },
    ctx,
  );
}

/** GET /providers — Provider health + quota status (service auth) */
export async function handleProviders(ctx: HandlerContext): Promise<Response> {
  requireServiceAuth(ctx.request);

  const emailService = getEmailService();
  const status = await emailService.getStatus();

  return ok(status, ctx);
}

/** GET /health — Health check (no auth) */
export function handleHealth(ctx: HandlerContext): Promise<Response> {
  return Promise.resolve(
    ok({ status: "healthy", version: VERSION, timestamp: new Date().toISOString() }, ctx),
  );
}
