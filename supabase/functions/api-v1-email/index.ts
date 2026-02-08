/**
 * Unified Email API v1 (api-v1-email)
 *
 * Full email API exposing queue processing, direct sending, template sending,
 * and provider health/quota monitoring.
 *
 * Routes:
 * - GET  /          - Queue stats (pending, failed, sent counts) [service/cron auth]
 * - POST /process   - Process batch from queue (existing cron logic) [service/cron auth]
 * - POST /process/automation - Process automation drip queue [service/cron auth]
 * - POST /send      - Send a single email (for apps) [JWT auth]
 * - POST /send/template - Send using a named template slug [JWT auth]
 * - POST /send/invitation - Send invitation to non-user [JWT auth]
 * - GET  /providers - Provider health + quota status [service auth]
 * - GET  /health    - Health check [no auth]
 *
 * @module api-v1-email
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { ValidationError, AppError, ForbiddenError, ServerError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import {
  getEmailService,
  type EmailType,
  type SendTemplateEmailParams,
} from "../_shared/email/index.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "1.0.0";

// =============================================================================
// Schemas
// =============================================================================

const processSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional().default(50),
  dryRun: z.boolean().optional().default(false),
  provider: z.string().optional(),
});

const emailTypeEnum = z.enum([
  "auth", "chat", "food_listing", "feedback", "review_reminder",
  "newsletter", "announcement", "welcome", "goodbye", "notification",
]);

const sendSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  subject: z.string().min(1).max(500),
  html: z.string().min(1),
  text: z.string().optional(),
  replyTo: z.string().email().optional(),
  tags: z.array(z.string()).max(10).optional(),
  emailType: emailTypeEnum.optional().default("notification"),
});

const sendTemplateSchema = z.object({
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  slug: z.string().min(1),
  variables: z.record(z.unknown()),
  emailType: emailTypeEnum.optional().default("notification"),
});

const sendInvitationSchema = z.object({
  recipientEmail: z.string().email(),
  senderName: z.string().min(1).max(100),
  senderEmail: z.string().email().optional(),
  message: z.string().max(500).optional(),
});

const automationProcessSchema = z.object({
  batchSize: z.number().int().min(1).max(200).optional().default(20),
  concurrency: z.number().int().min(1).max(10).optional().default(3),
  dryRun: z.boolean().optional().default(false),
});

// =============================================================================
// Types
// =============================================================================

interface AutomationQueueItem {
  id: string;
  enrollment_id: string;
  flow_id: string;
  profile_id: string;
  step_index: number;
  scheduled_for: string;
  status: string;
  attempts: number;
  email_data: {
    subject?: string;
    html?: string;
    text?: string;
    template_slug?: string;
    to?: string;
  };
}

interface QueuedEmail {
  id: string;
  user_id: string;
  campaign_id: string | null;
  email_type: string;
  template_slug: string | null;
  user_email: string;
  user_first_name: string | null;
  retry_count: number;
  metadata: Record<string, unknown>;
}

interface ProcessResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors?: string[];
}

// =============================================================================
// Service Role Client
// =============================================================================

function getServiceRoleClient() {
  return getSupabaseClient();
}

// =============================================================================
// Cron/Service Auth
// =============================================================================

function verifyServiceAuth(request: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = request.headers.get("X-Cron-Secret");
  if (authHeader && cronSecret && authHeader === cronSecret) return true;

  const bearerToken = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearerToken && cronSecret && bearerToken === cronSecret) return true;
  if (bearerToken === serviceRoleKey) return true;

  if (request.headers.get("x-supabase-cron") === "true") return true;

  return false;
}

function requireServiceAuth(request: Request): void {
  if (!verifyServiceAuth(request)) {
    throw new ForbiddenError("Service or cron authentication required");
  }
}

// =============================================================================
// Queue Processing (preserved from api-v1-email-queue)
// =============================================================================

async function processEmailQueue(
  _requestId: string,
  batchSize: number,
  dryRun: boolean,
  provider?: string,
): Promise<ProcessResult> {
  const supabase = getServiceRoleClient();

  const { data: pendingEmails, error: fetchError } = await supabase.rpc(
    "get_pending_emails_for_processing",
    {
      p_batch_size: batchSize,
      p_provider: provider || null,
    },
  );

  if (fetchError) {
    throw new AppError(
      `Failed to fetch pending emails: ${fetchError.message}`,
      "QUEUE_FETCH_FAILED",
      500,
    );
  }

  if (!pendingEmails || pendingEmails.length === 0) {
    return { processed: 0, sent: 0, failed: 0, skipped: 0, durationMs: 0 };
  }

  const emails = pendingEmails as QueuedEmail[];
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  const emailService = getEmailService();

  for (const email of emails) {
    if (dryRun) {
      logger.info("Dry run: would send email", {
        deliveryId: email.id,
        userId: email.user_id,
        emailType: email.email_type,
        recipient: email.user_email,
      });
      skipped++;
      continue;
    }

    try {
      if (!email.user_email) {
        logger.warn("Skipping email: no recipient address", {
          deliveryId: email.id,
          userId: email.user_id,
        });
        skipped++;
        continue;
      }

      const emailContent = await buildEmailContent(supabase, email);

      if (!emailContent) {
        logger.warn("Skipping email: could not build content", {
          deliveryId: email.id,
          emailType: email.email_type,
        });
        skipped++;
        continue;
      }

      const result = await emailService.sendEmail(
        {
          to: email.user_email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
          replyTo: emailContent.replyTo,
          tags: [email.email_type, email.template_slug || "default"].filter(Boolean) as string[],
        },
        email.email_type as EmailType,
      );

      if (result.success && result.messageId) {
        await supabase.rpc("mark_email_as_sent", {
          p_delivery_id: email.id,
          p_provider: result.provider || "unknown",
          p_message_id: result.messageId,
        });
        sent++;
      } else {
        throw new ServerError(result.error || "Unknown send error");
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      const shouldRetry = !isHardBounce(errorMessage);

      await supabase.rpc("mark_email_as_failed", {
        p_delivery_id: email.id,
        p_error_code: getErrorCode(errorMessage),
        p_error_message: errorMessage.slice(0, 500),
        p_should_retry: shouldRetry,
      });

      failed++;
      errors.push(`${email.id}: ${errorMessage}`);

      logger.warn("Email send failed", {
        deliveryId: email.id,
        error: errorMessage,
        retryCount: email.retry_count,
        willRetry: shouldRetry && email.retry_count < 2,
      });
    }
  }

  return {
    processed: emails.length,
    sent,
    failed,
    skipped,
    durationMs: 0,
    errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
  };
}

// =============================================================================
// Email Content Building (preserved from api-v1-email-queue)
// =============================================================================

async function buildEmailContent(
  supabase: ReturnType<typeof getServiceRoleClient>,
  email: QueuedEmail,
): Promise<{
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
} | null> {
  // Newsletter emails with a campaign
  if (email.email_type === "newsletter" && email.campaign_id) {
    const { data: campaign, error } = await supabase
      .from("newsletter_campaigns")
      .select("subject, html_content, text_content")
      .eq("id", email.campaign_id)
      .single();

    if (error || !campaign) {
      logger.error("Failed to fetch campaign", new Error(error?.message || "Campaign not found"), {
        campaignId: email.campaign_id,
      });
      return null;
    }

    const personalizedHtml = personalizeContent(
      campaign.html_content,
      email.user_first_name,
      email.user_email,
    );
    const personalizedText = campaign.text_content
      ? personalizeContent(campaign.text_content, email.user_first_name, email.user_email)
      : undefined;

    return {
      subject: campaign.subject,
      html: personalizedHtml,
      text: personalizedText,
    };
  }

  // Template-based emails
  if (email.template_slug) {
    const { data: template, error } = await supabase
      .from("email_templates")
      .select("subject, html_content, text_content")
      .eq("slug", email.template_slug)
      .single();

    if (error || !template) {
      logger.warn("Template not found, using fallback", {
        templateSlug: email.template_slug,
      });
    } else {
      const personalizedHtml = personalizeContent(
        template.html_content,
        email.user_first_name,
        email.user_email,
      );

      return {
        subject: template.subject,
        html: personalizedHtml,
        text: template.text_content,
      };
    }
  }

  // Digest emails
  if (email.email_type === "digest") {
    const metadata = email.metadata || {};
    const frequency = (metadata.frequency as string) || "daily";
    const itemCount = (metadata.itemCount as string) || "0";

    return {
      subject: `Your ${frequency} digest - ${itemCount} new notifications`,
      html: buildDigestHtml(email.user_first_name, metadata),
      text: buildDigestText(email.user_first_name, metadata),
    };
  }

  // Generic notification email
  const title = (email.metadata?.title as string) || "New notification";
  const body = (email.metadata?.body as string) || "";

  return {
    subject: title,
    html: buildGenericHtml(email.user_first_name, title, body),
    text: body,
  };
}

function personalizeContent(
  content: string,
  firstName: string | null,
  email: string,
): string {
  return content
    .replace(/\{\{first_name\}\}/gi, firstName || "there")
    .replace(/\{\{name\}\}/gi, firstName || "there")
    .replace(/\{\{email\}\}/gi, email);
}

function buildGenericHtml(firstName: string | null, title: string, body: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #f8f9fa; border-radius: 8px; padding: 30px; margin-bottom: 20px;">
    <h1 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px;">${escapeHtml(title)}</h1>
    <p style="margin: 0 0 15px;">Hi ${escapeHtml(firstName || "there")},</p>
    <p style="margin: 0;">${escapeHtml(body)}</p>
  </div>
  <p style="color: #666; font-size: 14px; text-align: center;">
    <a href="https://foodshare.app" style="color: #10b981;">FoodShare</a>
  </p>
</body>
</html>`;
}

function buildDigestHtml(firstName: string | null, metadata: Record<string, unknown>): string {
  const items = (metadata.items as Array<{ title?: string; body?: string }>) || [];
  const frequency = (metadata.frequency as string) || "daily";

  const itemsHtml = items
    .slice(0, 10)
    .map(
      (item) => `
    <li style="margin-bottom: 10px;">
      <strong>${escapeHtml(item.title || "Notification")}</strong>
      ${item.body ? `<br><span style="color: #666;">${escapeHtml(item.body)}</span>` : ""}
    </li>
  `,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your ${frequency} digest</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #f8f9fa; border-radius: 8px; padding: 30px;">
    <h1 style="margin: 0 0 20px; color: #1a1a1a; font-size: 24px;">Your ${escapeHtml(frequency)} digest</h1>
    <p style="margin: 0 0 20px;">Hi ${escapeHtml(firstName || "there")}, here's what you missed:</p>
    <ul style="padding-left: 20px; margin: 0;">
      ${itemsHtml}
    </ul>
    ${items.length > 10 ? `<p style="margin: 15px 0 0; color: #666;">...and ${items.length - 10} more</p>` : ""}
  </div>
  <p style="color: #666; font-size: 14px; text-align: center; margin-top: 20px;">
    <a href="https://foodshare.app" style="color: #10b981;">Open FoodShare</a>
  </p>
</body>
</html>`;
}

function buildDigestText(firstName: string | null, metadata: Record<string, unknown>): string {
  const items = (metadata.items as Array<{ title?: string; body?: string }>) || [];
  const frequency = (metadata.frequency as string) || "daily";

  const itemsText = items
    .slice(0, 10)
    .map((item) => `- ${item.title || "Notification"}${item.body ? `: ${item.body}` : ""}`)
    .join("\n");

  return `Your ${frequency} digest

Hi ${firstName || "there"}, here's what you missed:

${itemsText}
${items.length > 10 ? `\n...and ${items.length - 10} more` : ""}

Open FoodShare: https://foodshare.app`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isHardBounce(error: string): boolean {
  const hardBouncePatterns = [
    /invalid.*email/i,
    /not.*exist/i,
    /mailbox.*not.*found/i,
    /user.*unknown/i,
    /550.*5\.1\.1/i,
    /550.*5\.1\.2/i,
    /unsubscribed/i,
    /complained/i,
    /blocked/i,
    /blacklist/i,
  ];

  return hardBouncePatterns.some((pattern) => pattern.test(error));
}

function getErrorCode(error: string): string {
  const smtpMatch = error.match(/\b(4\d{2}|5\d{2})\b/);
  if (smtpMatch) return smtpMatch[1];

  if (/timeout/i.test(error)) return "TIMEOUT";
  if (/rate.*limit/i.test(error)) return "RATE_LIMIT";
  if (/auth/i.test(error)) return "AUTH_ERROR";
  if (/bounce/i.test(error)) return "BOUNCED";
  if (/invalid.*email/i.test(error)) return "INVALID_EMAIL";

  return "UNKNOWN";
}

// =============================================================================
// Automation Queue Processing (merged from process-automation-queue)
// =============================================================================

async function resolveAutomationEmailContent(
  supabase: ReturnType<typeof getServiceRoleClient>,
  emailData: AutomationQueueItem["email_data"],
  profileId: string,
): Promise<{ subject: string; html: string; to: string } | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("email, first_name, nickname")
    .eq("id", profileId)
    .single();

  if (!profile?.email) return null;

  if (emailData.template_slug) {
    const { data: template } = await supabase
      .from("email_templates")
      .select("subject, html_content")
      .eq("slug", emailData.template_slug)
      .eq("is_active", true)
      .single();

    if (template) {
      const name = profile.first_name || profile.nickname || "there";
      return {
        subject: template.subject.replace(/\{\{name\}\}/g, name),
        html: template.html_content
          .replace(/\{\{name\}\}/g, name)
          .replace(/\{\{email\}\}/g, profile.email),
        to: profile.email,
      };
    }
  }

  if (emailData.subject && emailData.html) {
    const name = profile.first_name || profile.nickname || "there";
    return {
      subject: emailData.subject.replace(/\{\{name\}\}/g, name),
      html: emailData.html
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{email\}\}/g, profile.email),
      to: profile.email,
    };
  }

  return null;
}

async function processAutomationQueueItem(
  supabase: ReturnType<typeof getServiceRoleClient>,
  item: AutomationQueueItem,
  dryRun: boolean,
): Promise<{ id: string; success: boolean; provider?: string; error?: string; latencyMs: number }> {
  const startTime = performance.now();
  const maxAttempts = 3;

  try {
    if (!dryRun) {
      await supabase
        .from("email_automation_queue")
        .update({ status: "processing", attempts: item.attempts + 1, updated_at: new Date().toISOString() })
        .eq("id", item.id);
    }

    const emailContent = await resolveAutomationEmailContent(supabase, item.email_data, item.profile_id);
    if (!emailContent) {
      if (!dryRun) {
        await supabase
          .from("email_automation_queue")
          .update({ status: "failed", error_message: "Could not resolve email content or recipient", updated_at: new Date().toISOString() })
          .eq("id", item.id);
      }
      return { id: item.id, success: false, error: "Could not resolve email content or recipient", latencyMs: Math.round(performance.now() - startTime) };
    }

    if (dryRun) {
      return { id: item.id, success: true, provider: "dry_run", latencyMs: Math.round(performance.now() - startTime) };
    }

    const emailService = getEmailService();
    const result = await emailService.sendEmail(
      { to: emailContent.to, subject: emailContent.subject, html: emailContent.html },
      "notification" as EmailType,
    );

    if (result.success && result.messageId) {
      await supabase.rpc("mark_automation_email_sent", {
        p_queue_id: item.id,
        p_provider: result.provider || "unknown",
        p_message_id: result.messageId,
      });
      return { id: item.id, success: true, provider: result.provider, latencyMs: Math.round(performance.now() - startTime) };
    }

    const newStatus = item.attempts + 1 >= maxAttempts ? "failed" : "pending";
    await supabase
      .from("email_automation_queue")
      .update({ status: newStatus, error_message: result.error || "Unknown error", updated_at: new Date().toISOString() })
      .eq("id", item.id);

    return { id: item.id, success: false, error: result.error, latencyMs: Math.round(performance.now() - startTime) };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (!dryRun) {
      await supabase
        .from("email_automation_queue")
        .update({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
        .eq("id", item.id);
    }
    return { id: item.id, success: false, error: errorMessage, latencyMs: Math.round(performance.now() - startTime) };
  }
}

/** POST /process/automation — Process automation drip queue (service/cron auth) */
async function handleProcessAutomation(
  ctx: HandlerContext<z.infer<typeof automationProcessSchema>>,
): Promise<Response> {
  requireServiceAuth(ctx.request);

  const { batchSize, concurrency, dryRun } = ctx.body;
  const startTime = performance.now();

  logger.info("Processing automation queue", { batchSize, concurrency, dryRun });

  const supabase = getServiceRoleClient();
  const now = new Date().toISOString();

  const { data: queueItems, error: fetchError } = await supabase
    .from("email_automation_queue")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", now)
    .order("scheduled_for", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    throw new AppError(`Failed to fetch automation queue: ${fetchError.message}`, "QUEUE_FETCH_FAILED", 500);
  }

  if (!queueItems?.length) {
    return ok({
      success: true,
      message: "No pending automation emails to process",
      dryRun,
      processed: 0,
      successful: 0,
      failed: 0,
      durationMs: Math.round(performance.now() - startTime),
    }, ctx);
  }

  const results: Awaited<ReturnType<typeof processAutomationQueueItem>>[] = [];
  for (let i = 0; i < queueItems.length; i += concurrency) {
    const chunk = queueItems.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((item) => processAutomationQueueItem(supabase, item as AutomationQueueItem, dryRun)),
    );
    results.push(...chunkResults);
  }

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logger.info("Automation queue processing complete", {
    processed: results.length,
    successful: successful.length,
    failed: failed.length,
    dryRun,
    durationMs: Math.round(performance.now() - startTime),
  });

  return ok({
    success: true,
    message: dryRun ? "Dry run completed" : "Automation queue processed",
    dryRun,
    processed: results.length,
    successful: successful.length,
    failed: failed.length,
    avgLatencyMs: results.length > 0 ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length) : 0,
    errors: failed.map((f) => ({ id: f.id, error: f.error })),
    durationMs: Math.round(performance.now() - startTime),
  }, ctx);
}

// =============================================================================
// Route Handlers
// =============================================================================

/** GET / — Queue stats (service/cron auth) */
async function handleGetStats(ctx: HandlerContext): Promise<Response> {
  requireServiceAuth(ctx.request);

  const supabase = getServiceRoleClient();

  const [pending, failed, sent] = await Promise.all([
    supabase
      .from("email_delivery_log")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("email_delivery_log")
      .select("*", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase
      .from("email_delivery_log")
      .select("*", { count: "exact", head: true })
      .eq("status", "sent"),
  ]);

  return ok(
    {
      queue: {
        pending: pending.count ?? 0,
        failed: failed.count ?? 0,
        sent: sent.count ?? 0,
      },
      version: VERSION,
      timestamp: new Date().toISOString(),
    },
    ctx,
  );
}

/** POST /process — Process batch from queue (service/cron auth) */
async function handleProcess(
  ctx: HandlerContext<z.infer<typeof processSchema>>,
): Promise<Response> {
  requireServiceAuth(ctx.request);

  const { batchSize, dryRun, provider } = ctx.body;
  const requestId = ctx.ctx.requestId;
  const startTime = performance.now();

  logger.info("Processing email queue", {
    requestId,
    batchSize,
    dryRun,
    provider,
  });

  const result = await processEmailQueue(requestId, batchSize, dryRun, provider);
  result.durationMs = Math.round(performance.now() - startTime);

  logger.info("Email queue processing complete", {
    requestId,
    ...result,
  });

  return ok({ ...result, requestId }, ctx);
}

/** POST /send — Send a single email (JWT auth) */
async function handleSend(
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
async function handleSendTemplate(
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

/** GET /providers — Provider health + quota status (service auth) */
async function handleProviders(ctx: HandlerContext): Promise<Response> {
  requireServiceAuth(ctx.request);

  const emailService = getEmailService();
  const status = await emailService.getStatus();

  return ok(status, ctx);
}

/** GET /health — Health check (no auth) */
function handleHealth(ctx: HandlerContext): Promise<Response> {
  return Promise.resolve(
    ok({ status: "healthy", version: VERSION, timestamp: new Date().toISOString() }, ctx),
  );
}

// =============================================================================
// Invitation Email (consolidated from send-invitation/)
// =============================================================================

function buildInvitationEmail(senderName: string, message?: string): { subject: string; html: string } {
  const personalMessage = message
    ? `<p style="color: #555; font-style: italic; border-left: 3px solid #2ECC71; padding-left: 12px; margin: 20px 0;">"${escapeHtml(message)}"</p>`
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
        <p style="color: #666; font-size: 16px; margin: 0;">${escapeHtml(senderName)} wants you to join FoodShare</p>
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

/** POST /send/invitation — Send invitation to non-user (JWT auth) */
async function handleSendInvitation(
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
  }).then(undefined, () => { /* analytics failure is non-critical */ });

  return ok(
    {
      messageId: result.messageId,
      provider: result.provider,
      latencyMs: result.latencyMs,
    },
    ctx,
  );
}

// =============================================================================
// Route Dispatch
// =============================================================================

function handleGet(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  if (path.endsWith("/health")) {
    return handleHealth(ctx);
  }

  if (path.endsWith("/providers")) {
    return handleProviders(ctx);
  }

  // GET / — queue stats
  return handleGetStats(ctx);
}

function handlePost(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  if (path.endsWith("/process/automation")) {
    const body = automationProcessSchema.parse(ctx.body || {});
    return handleProcessAutomation({ ...ctx, body } as HandlerContext<z.infer<typeof automationProcessSchema>>);
  }

  if (path.endsWith("/process")) {
    const body = processSchema.parse(ctx.body);
    return handleProcess({ ...ctx, body } as HandlerContext<z.infer<typeof processSchema>>);
  }

  if (path.endsWith("/send/invitation")) {
    const body = sendInvitationSchema.parse(ctx.body);
    return handleSendInvitation({ ...ctx, body } as HandlerContext<z.infer<typeof sendInvitationSchema>>);
  }

  if (path.endsWith("/send/template")) {
    const body = sendTemplateSchema.parse(ctx.body);
    return handleSendTemplate({ ...ctx, body } as HandlerContext<z.infer<typeof sendTemplateSchema>>);
  }

  if (path.endsWith("/send")) {
    const body = sendSchema.parse(ctx.body);
    return handleSend({ ...ctx, body } as HandlerContext<z.infer<typeof sendSchema>>);
  }

  throw new AppError("Unknown route. Available: /process, /send, /send/template, /send/invitation", "NOT_FOUND", 404);
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-email",
  version: VERSION,
  requireAuth: false, // Auth handled per-route (service/cron for queue ops, JWT for send)
  csrf: false, // Service-to-service + cron + mobile clients
  rateLimit: {
    limit: 30,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGet,
    },
    POST: {
      handler: handlePost,
    },
  },
}));
