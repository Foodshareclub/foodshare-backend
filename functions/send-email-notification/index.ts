/**
 * Send Email Notification
 *
 * Sends email notifications with enterprise preference checking.
 * Supports both instant and digest email delivery.
 *
 * Endpoints:
 * - POST / - Send email notification to user
 * - POST /digest - Send digest email to user
 * - GET /health - Health check
 *
 * Features:
 * - Enterprise preference checking (category/channel enabled)
 * - Quiet hours and DND respect
 * - Frequency control (instant/daily/weekly)
 * - Unsubscribe links
 * - Multi-provider failover via email service
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { getEmailService, EmailType } from "../_shared/email/index.ts";
import {
  shouldSendNotification,
  mapTypeToCategory,
  shouldBypassPreferences,
  type NotificationCategory,
} from "../_shared/notification-preferences.ts";

const VERSION = "1.0.0";
const SERVICE = "send-email-notification";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") || "https://foodshare.club";

interface EmailNotificationRequest {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  templateName?: string;
  templateData?: Record<string, unknown>;
  bypassPreferences?: boolean;
}

interface DigestEmailRequest {
  userId: string;
  frequency: "hourly" | "daily" | "weekly";
  items: Array<{
    type: string;
    category: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
    created_at: string;
  }>;
}

interface EmailResult {
  success: boolean;
  sent: boolean;
  reason?: string;
  provider?: string;
  messageId?: string;
  error?: string;
}

function getServiceRoleClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Get user email from database
 */
async function getUserEmail(
  supabase: SupabaseClient,
  userId: string
): Promise<{ email: string; name: string } | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("email, nickname, first_name")
    .eq("id", userId)
    .single();

  if (error || !data?.email) {
    return null;
  }

  return {
    email: data.email,
    name: data.first_name || data.nickname || data.email.split("@")[0],
  };
}

/**
 * Generate unsubscribe URL with token
 */
function generateUnsubscribeUrl(userId: string, category: string): string {
  // In production, this should use a signed token
  const token = btoa(`${userId}:${category}:${Date.now()}`);
  return `${APP_URL}/unsubscribe?token=${token}`;
}

/**
 * Create notification email HTML
 */
function createNotificationEmailHtml(
  title: string,
  body: string,
  category: string,
  unsubscribeUrl: string
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 100%); padding: 30px; text-align: center;">
              <img src="${APP_URL}/logo-512.png" alt="FoodShare" style="width: 60px; height: 60px; border-radius: 50%; background: white; padding: 4px;">
              <h1 style="margin: 15px 0 0; color: #ffffff; font-size: 22px; font-weight: 700;">${title}</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <p style="margin: 0; font-size: 16px; line-height: 1.6; color: #333333;">
                ${body.replace(/\n/g, "<br>")}
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 30px;">
                <tr>
                  <td align="center">
                    <a href="${APP_URL}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                      Open FoodShare
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 25px 30px; background-color: #f9f9f9; border-top: 1px solid #eeeeee;">
              <p style="margin: 0 0 10px; font-size: 13px; color: #666666; text-align: center;">
                You received this email because you have ${category} notifications enabled.
              </p>
              <p style="margin: 0; font-size: 13px; color: #666666; text-align: center;">
                <a href="${unsubscribeUrl}" style="color: #ff2d55; text-decoration: none;">Unsubscribe</a> |
                <a href="${APP_URL}/settings/notifications" style="color: #ff2d55; text-decoration: none;">Manage Preferences</a>
              </p>
              <p style="margin: 15px 0 0; font-size: 12px; color: #999999; text-align: center;">
                FoodShare LLC &bull; Sacramento, CA 95841
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Create digest email HTML
 */
function createDigestEmailHtml(
  items: DigestEmailRequest["items"],
  frequency: string,
  unsubscribeUrl: string
): string {
  const frequencyLabel = frequency === "hourly" ? "Hourly" : frequency === "daily" ? "Daily" : "Weekly";
  const title = `Your ${frequencyLabel} FoodShare Digest`;

  // Group items by category
  const grouped: Record<string, typeof items> = {};
  for (const item of items) {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  }

  const categoryNames: Record<string, string> = {
    posts: "New Listings",
    forum: "Forum Activity",
    challenges: "Challenges",
    comments: "Comments",
    chats: "Messages",
    social: "Social Activity",
    system: "System Updates",
    marketing: "News & Updates",
  };

  // Build items HTML
  let itemsHtml = "";
  for (const [category, categoryItems] of Object.entries(grouped)) {
    const categoryName = categoryNames[category] || category;
    itemsHtml += `
      <tr>
        <td style="padding: 20px 0 10px;">
          <h3 style="margin: 0; font-size: 16px; color: #ff2d55; font-weight: 600; border-bottom: 2px solid #ff2d55; padding-bottom: 8px; display: inline-block;">
            ${categoryName} (${categoryItems.length})
          </h3>
        </td>
      </tr>`;

    for (const item of categoryItems.slice(0, 5)) {
      itemsHtml += `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
          <p style="margin: 0 0 4px; font-size: 15px; font-weight: 600; color: #333333;">${item.title}</p>
          <p style="margin: 0; font-size: 14px; color: #666666; line-height: 1.4;">${item.body}</p>
        </td>
      </tr>`;
    }

    if (categoryItems.length > 5) {
      itemsHtml += `
      <tr>
        <td style="padding: 8px 0;">
          <p style="margin: 0; font-size: 13px; color: #999999;">...and ${categoryItems.length - 5} more</p>
        </td>
      </tr>`;
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 100%); padding: 30px; text-align: center;">
              <img src="${APP_URL}/logo-512.png" alt="FoodShare" style="width: 60px; height: 60px; border-radius: 50%; background: white; padding: 4px;">
              <h1 style="margin: 15px 0 0; color: #ffffff; font-size: 22px; font-weight: 700;">${title}</h1>
              <p style="margin: 8px 0 0; color: rgba(255, 255, 255, 0.9); font-size: 15px;">
                ${items.length} new notification${items.length !== 1 ? "s" : ""}
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 30px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                ${itemsHtml}
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 30px;">
                <tr>
                  <td align="center">
                    <a href="${APP_URL}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
                      Open FoodShare
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 25px 30px; background-color: #f9f9f9; border-top: 1px solid #eeeeee;">
              <p style="margin: 0 0 10px; font-size: 13px; color: #666666; text-align: center;">
                This is your ${frequency} digest of FoodShare notifications.
              </p>
              <p style="margin: 0; font-size: 13px; color: #666666; text-align: center;">
                <a href="${unsubscribeUrl}" style="color: #ff2d55; text-decoration: none;">Unsubscribe</a> |
                <a href="${APP_URL}/settings/notifications" style="color: #ff2d55; text-decoration: none;">Manage Preferences</a>
              </p>
              <p style="margin: 15px 0 0; font-size: 12px; color: #999999; text-align: center;">
                FoodShare LLC &bull; Sacramento, CA 95841
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send single notification email
 */
async function handleSendNotification(
  req: Request,
  supabase: SupabaseClient
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const startTime = performance.now();

  try {
    const body: EmailNotificationRequest = await req.json();

    // Validate required fields
    if (!body.userId || !body.type || !body.title || !body.body) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing required fields: userId, type, title, body",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get user email
    const user = await getUserEmail(supabase, body.userId);
    if (!user) {
      return new Response(
        JSON.stringify({
          success: false,
          sent: false,
          reason: "user_not_found",
          error: "User not found or no email address",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check notification preferences
    const category = mapTypeToCategory(body.type) as NotificationCategory;
    const bypassPrefs = body.bypassPreferences || shouldBypassPreferences(body.type);

    const prefResult = await shouldSendNotification(supabase, body.userId, {
      category,
      channel: "email",
      bypassPreferences: bypassPrefs,
    });

    if (!prefResult.send) {
      logger.info("Email notification blocked by preferences", {
        userId: body.userId,
        type: body.type,
        category,
        reason: prefResult.reason,
      });

      return new Response(
        JSON.stringify({
          success: true,
          sent: false,
          reason: prefResult.reason,
          frequency: prefResult.frequency,
          scheduleFor: prefResult.scheduleFor,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Generate unsubscribe URL
    const unsubscribeUrl = generateUnsubscribeUrl(body.userId, category);

    // Create email HTML
    const html = createNotificationEmailHtml(
      body.title,
      body.body,
      category,
      unsubscribeUrl
    );

    // Send email
    const emailService = getEmailService();
    const emailType: EmailType = category === "marketing" ? "newsletter" : "notification";

    const result = await emailService.sendEmail(
      {
        to: user.email,
        subject: body.title,
        html,
        text: body.body,
      },
      emailType
    );

    const response: EmailResult = {
      success: result.success,
      sent: result.success,
      provider: result.provider,
      messageId: result.messageId,
      error: result.error,
    };

    logger.info("Email notification sent", {
      userId: body.userId,
      type: body.type,
      category,
      success: result.success,
      provider: result.provider,
      durationMs: Math.round(performance.now() - startTime),
    });

    return new Response(JSON.stringify(response), {
      status: result.success ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Email notification failed", err);

    return new Response(
      JSON.stringify({
        success: false,
        sent: false,
        error: err.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Send digest email
 */
async function handleSendDigest(
  req: Request,
  supabase: SupabaseClient
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const startTime = performance.now();

  try {
    const body: DigestEmailRequest = await req.json();

    // Validate required fields
    if (!body.userId || !body.frequency || !body.items?.length) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing required fields: userId, frequency, items",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get user email
    const user = await getUserEmail(supabase, body.userId);
    if (!user) {
      return new Response(
        JSON.stringify({
          success: false,
          sent: false,
          reason: "user_not_found",
          error: "User not found or no email address",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check if email is enabled globally
    const prefResult = await shouldSendNotification(supabase, body.userId, {
      category: "system", // Use system for digest preference check
      channel: "email",
      bypassPreferences: false,
    });

    if (!prefResult.send && prefResult.reason !== "digest_frequency") {
      return new Response(
        JSON.stringify({
          success: true,
          sent: false,
          reason: prefResult.reason,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Generate unsubscribe URL
    const unsubscribeUrl = generateUnsubscribeUrl(body.userId, "digest");

    // Create digest email HTML
    const frequencyLabel = body.frequency === "hourly" ? "Hourly" : body.frequency === "daily" ? "Daily" : "Weekly";
    const subject = `Your ${frequencyLabel} FoodShare Digest - ${body.items.length} notification${body.items.length !== 1 ? "s" : ""}`;

    const html = createDigestEmailHtml(body.items, body.frequency, unsubscribeUrl);

    // Send email
    const emailService = getEmailService();
    const result = await emailService.sendEmail(
      {
        to: user.email,
        subject,
        html,
        text: `Your ${frequencyLabel} FoodShare digest with ${body.items.length} notifications. View them at ${APP_URL}`,
      },
      "notification"
    );

    const response: EmailResult = {
      success: result.success,
      sent: result.success,
      provider: result.provider,
      messageId: result.messageId,
      error: result.error,
    };

    logger.info("Digest email sent", {
      userId: body.userId,
      frequency: body.frequency,
      itemCount: body.items.length,
      success: result.success,
      provider: result.provider,
      durationMs: Math.round(performance.now() - startTime),
    });

    return new Response(JSON.stringify(response), {
      status: result.success ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Digest email failed", err);

    return new Response(
      JSON.stringify({
        success: false,
        sent: false,
        error: err.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Handle health check
 */
function handleHealth(req: Request): Response {
  const corsHeaders = getCorsHeaders(req);

  return new Response(
    JSON.stringify({
      status: "healthy",
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

/**
 * Main handler
 */
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace("/send-email-notification", "");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  // Health check
  if (req.method === "GET" && path.endsWith("/health")) {
    return handleHealth(req);
  }

  const supabase = getServiceRoleClient();

  // Route handling
  if (req.method === "POST") {
    if (path === "/digest" || path.endsWith("/digest")) {
      return handleSendDigest(req, supabase);
    }
    return handleSendNotification(req, supabase);
  }

  const corsHeaders = getCorsHeaders(req);
  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
