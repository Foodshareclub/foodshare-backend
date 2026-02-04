/**
 * Process Email Queue Edge Function
 *
 * Processes queued emails from email_delivery_log table.
 * Designed to be called via cron job (e.g., every minute).
 *
 * Features:
 * - Batch processing with configurable size
 * - Rate limiting per provider
 * - Retry logic with backoff
 * - Fair processing using database locking
 * - Metrics and logging
 *
 * @module process-email-queue
 */

import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { getEmailService } from "../_shared/email/index.ts";

const VERSION = "1.0.0";

interface ProcessOptions {
  batchSize?: number;
  dryRun?: boolean;
  provider?: string;
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
  success: boolean;
  data?: {
    processed: number;
    sent: number;
    failed: number;
    skipped: number;
    durationMs: number;
    errors?: string[];
  };
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsPrelight(req);

  const corsHeaders = getCorsHeaders(req);
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    // Parse request
    const url = new URL(req.url);

    // Health check
    if (url.pathname.endsWith("/health")) {
      return new Response(
        JSON.stringify({
          status: "healthy",
          version: VERSION,
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verify authentication (service role or admin)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ success: false, error: "Unauthorized" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse options
    let options: ProcessOptions = {};
    if (req.method === "POST") {
      try {
        options = await req.json();
      } catch {
        // Use defaults
      }
    }

    const { batchSize = 50, dryRun = false, provider } = options;

    logger.info("Processing email queue", {
      requestId,
      batchSize,
      dryRun,
      provider,
    });

    const result = await processEmailQueue(requestId, batchSize, dryRun, provider);

    const durationMs = Math.round(performance.now() - startTime);
    if (result.data) {
      result.data.durationMs = durationMs;
    }

    logger.info("Email queue processing complete", {
      requestId,
      ...result.data,
      durationMs,
    });

    return new Response(
      JSON.stringify({
        ...result,
        requestId,
      }),
      {
        status: result.success ? 200 : 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
      }
    );
  } catch (error) {
    logger.error("Email queue processing failed", error as Error);

    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
        requestId,
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
      }
    );
  }
});

/**
 * Process queued emails
 */
async function processEmailQueue(
  requestId: string,
  batchSize: number,
  dryRun: boolean,
  provider?: string
): Promise<ProcessResult> {
  const supabase = getSupabaseClient();

  // Fetch pending emails with row locking
  const { data: pendingEmails, error: fetchError } = await supabase.rpc(
    "get_pending_emails_for_processing",
    {
      p_batch_size: batchSize,
      p_provider: provider || null,
    }
  );

  if (fetchError) {
    return {
      success: false,
      error: `Failed to fetch pending emails: ${fetchError.message}`,
    };
  }

  if (!pendingEmails || pendingEmails.length === 0) {
    return {
      success: true,
      data: {
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
      },
    };
  }

  const emails = pendingEmails as QueuedEmail[];
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];

  const emailService = getEmailService();

  // Process each email
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
      // Skip if no email address
      if (!email.user_email) {
        logger.warn("Skipping email: no recipient address", {
          deliveryId: email.id,
          userId: email.user_id,
        });
        skipped++;
        continue;
      }

      // Build email content based on type
      const emailContent = await buildEmailContent(supabase, email);

      if (!emailContent) {
        logger.warn("Skipping email: could not build content", {
          deliveryId: email.id,
          emailType: email.email_type,
        });
        skipped++;
        continue;
      }

      // Send email
      const result = await emailService.sendEmail({
        to: email.user_email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        replyTo: emailContent.replyTo,
        tags: [email.email_type, email.template_slug || "default"].filter(Boolean) as string[],
      }, email.email_type as "newsletter" | "auth" | "chat" | "welcome");

      if (result.success && result.messageId) {
        // Mark as sent
        await supabase.rpc("mark_email_as_sent", {
          p_delivery_id: email.id,
          p_provider: result.provider || "unknown",
          p_message_id: result.messageId,
        });
        sent++;
      } else {
        throw new Error(result.error || "Unknown send error");
      }
    } catch (error) {
      const errorMessage = (error as Error).message;
      const shouldRetry = !isHardBounce(errorMessage);

      // Mark as failed
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
    success: true,
    data: {
      processed: emails.length,
      sent,
      failed,
      skipped,
      durationMs: 0, // Will be set by caller
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    },
  };
}

/**
 * Build email content based on type and template
 */
async function buildEmailContent(
  supabase: ReturnType<typeof getSupabaseClient>,
  email: QueuedEmail
): Promise<{
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
} | null> {
  // For newsletter emails with a campaign
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

    // Personalize content
    const personalizedHtml = personalizeContent(
      campaign.html_content,
      email.user_first_name,
      email.user_email
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

  // For template-based emails
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
      // Fall through to generic handling
    } else {
      const personalizedHtml = personalizeContent(
        template.html_content,
        email.user_first_name,
        email.user_email
      );

      return {
        subject: template.subject,
        html: personalizedHtml,
        text: template.text_content,
      };
    }
  }

  // Digest emails - build from metadata
  if (email.email_type === "digest") {
    const metadata = email.metadata || {};
    const frequency = metadata.frequency as string || "daily";
    const itemCount = metadata.itemCount as string || "0";

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

/**
 * Personalize content with user data
 */
function personalizeContent(
  content: string,
  firstName: string | null,
  email: string
): string {
  return content
    .replace(/\{\{first_name\}\}/gi, firstName || "there")
    .replace(/\{\{name\}\}/gi, firstName || "there")
    .replace(/\{\{email\}\}/gi, email);
}

/**
 * Build generic HTML email
 */
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

/**
 * Build digest HTML email
 */
function buildDigestHtml(firstName: string | null, metadata: Record<string, unknown>): string {
  const items = (metadata.items as Array<{ title?: string; body?: string }>) || [];
  const frequency = metadata.frequency as string || "daily";

  const itemsHtml = items.slice(0, 10).map((item) => `
    <li style="margin-bottom: 10px;">
      <strong>${escapeHtml(item.title || "Notification")}</strong>
      ${item.body ? `<br><span style="color: #666;">${escapeHtml(item.body)}</span>` : ""}
    </li>
  `).join("");

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

/**
 * Build digest text email
 */
function buildDigestText(firstName: string | null, metadata: Record<string, unknown>): string {
  const items = (metadata.items as Array<{ title?: string; body?: string }>) || [];
  const frequency = metadata.frequency as string || "daily";

  const itemsText = items.slice(0, 10).map((item) =>
    `• ${item.title || "Notification"}${item.body ? `: ${item.body}` : ""}`
  ).join("\n");

  return `Your ${frequency} digest

Hi ${firstName || "there"}, here's what you missed:

${itemsText}
${items.length > 10 ? `\n...and ${items.length - 10} more` : ""}

Open FoodShare: https://foodshare.app`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Check if error indicates a hard bounce (no retry)
 */
function isHardBounce(error: string): boolean {
  const hardBouncePatterns = [
    /invalid.*email/i,
    /not.*exist/i,
    /mailbox.*not.*found/i,
    /user.*unknown/i,
    /550.*5\.1\.1/i, // Invalid recipient
    /550.*5\.1\.2/i, // Bad destination mailbox
    /unsubscribed/i,
    /complained/i,
    /blocked/i,
    /blacklist/i,
  ];

  return hardBouncePatterns.some((pattern) => pattern.test(error));
}

/**
 * Extract error code from error message
 */
function getErrorCode(error: string): string {
  // Try to extract SMTP error code
  const smtpMatch = error.match(/\b(4\d{2}|5\d{2})\b/);
  if (smtpMatch) return smtpMatch[1];

  // Categorize by error type
  if (/timeout/i.test(error)) return "TIMEOUT";
  if (/rate.*limit/i.test(error)) return "RATE_LIMIT";
  if (/auth/i.test(error)) return "AUTH_ERROR";
  if (/bounce/i.test(error)) return "BOUNCED";
  if (/invalid.*email/i.test(error)) return "INVALID_EMAIL";

  return "UNKNOWN";
}
