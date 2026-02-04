/**
 * Send Invitation Edge Function
 *
 * Handles invitations to external users who don't have Foodshare accounts yet.
 * Uses the unified email service infrastructure without requiring a user ID.
 *
 * This is separate from api-v1-notifications because:
 * - api-v1-notifications requires userId (UUID) for registered users
 * - Invitations go to external email addresses (non-users)
 *
 * Endpoint: POST /functions/v1/send-invitation
 *
 * @version 1.0.0
 */

import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { getEmailService } from "../_shared/email/email-service.ts";
import { logger } from "../_shared/logger.ts";

const VERSION = "1.0.0";

// ============================================================================
// Types
// ============================================================================

interface InvitationRequest {
  recipientEmail: string;
  senderName: string;
  senderEmail?: string;
  message?: string;
}

interface InvitationResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  requestId: string;
}

// ============================================================================
// Validation
// ============================================================================

function isValidEmail(email: string): boolean {
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$/;
  return emailRegex.test(email);
}

function validateRequest(body: unknown): { valid: true; data: InvitationRequest } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body is required" };
  }

  const { recipientEmail, senderName, senderEmail, message } = body as Record<string, unknown>;

  if (!recipientEmail || typeof recipientEmail !== "string") {
    return { valid: false, error: "recipientEmail is required and must be a string" };
  }

  if (!isValidEmail(recipientEmail)) {
    return { valid: false, error: "Invalid recipient email format" };
  }

  if (!senderName || typeof senderName !== "string") {
    return { valid: false, error: "senderName is required and must be a string" };
  }

  if (senderName.length > 100) {
    return { valid: false, error: "senderName must be 100 characters or less" };
  }

  if (senderEmail && typeof senderEmail === "string" && !isValidEmail(senderEmail)) {
    return { valid: false, error: "Invalid sender email format" };
  }

  if (message && typeof message === "string" && message.length > 500) {
    return { valid: false, error: "message must be 500 characters or less" };
  }

  return {
    valid: true,
    data: {
      recipientEmail: recipientEmail.toLowerCase().trim(),
      senderName: senderName.trim(),
      senderEmail: senderEmail ? String(senderEmail).toLowerCase().trim() : undefined,
      message: message ? String(message).trim() : undefined,
    },
  };
}

// ============================================================================
// Email Template
// ============================================================================

function buildInvitationEmail(params: InvitationRequest): { subject: string; html: string } {
  const { senderName, message } = params;

  const personalMessage = message
    ? `<p style="color: #555; font-style: italic; border-left: 3px solid #2ECC71; padding-left: 12px; margin: 20px 0;">"${escapeHtml(message)}"</p>`
    : "";

  const subject = `${senderName} invited you to join FoodShare!`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Join FoodShare</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: white; border-radius: 16px; padding: 40px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
      <!-- Header -->
      <div style="text-align: center; margin-bottom: 30px;">
        <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #2ECC71, #27AE60); border-radius: 20px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 40px;">🍎</span>
        </div>
        <h1 style="color: #2ECC71; font-size: 28px; margin: 0 0 10px;">You're Invited!</h1>
        <p style="color: #666; font-size: 16px; margin: 0;">${escapeHtml(senderName)} wants you to join FoodShare</p>
      </div>

      ${personalMessage}

      <!-- Description -->
      <div style="background: #f8faf8; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <h2 style="color: #333; font-size: 18px; margin: 0 0 12px;">What is FoodShare?</h2>
        <p style="color: #555; font-size: 14px; line-height: 1.6; margin: 0;">
          FoodShare connects people in your community to share surplus food instead of throwing it away.
          Whether you have extra groceries, leftover party food, or garden produce, someone nearby could use it!
        </p>
      </div>

      <!-- Benefits -->
      <div style="margin: 24px 0;">
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 20px; margin-right: 12px;">🌱</span>
          <span style="color: #555; font-size: 14px;"><strong>Reduce food waste</strong> — Help save 40% of food that gets thrown away</span>
        </div>
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 20px; margin-right: 12px;">🤝</span>
          <span style="color: #555; font-size: 14px;"><strong>Build community</strong> — Meet neighbors and make connections</span>
        </div>
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="font-size: 20px; margin-right: 12px;">💚</span>
          <span style="color: #555; font-size: 14px;"><strong>Help others</strong> — Support those who need it most</span>
        </div>
      </div>

      <!-- CTA Button -->
      <div style="text-align: center; margin: 32px 0;">
        <a href="https://foodshare.club/invite"
           style="display: inline-block; background: linear-gradient(135deg, #2ECC71, #27AE60); color: white; padding: 16px 40px; border-radius: 30px; text-decoration: none; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(46, 204, 113, 0.4);">
          Join FoodShare
        </a>
      </div>

      <!-- Footer -->
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
</html>
  `.trim();

  return { subject, html };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================================
// Rate Limiting
// ============================================================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const corsHeaders = getCorsHeaders(req);
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    // Only accept POST
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Method not allowed",
          requestId,
        } satisfies InvitationResponse),
        {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Authenticate user
    const supabase = getSupabaseClient();
    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Authentication required",
          requestId,
        } satisfies InvitationResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const token = authHeader.substring(7);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      logger.warn("Authentication failed", { error: authError?.message, requestId });
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid or expired token",
          requestId,
        } satisfies InvitationResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Rate limit check
    if (!checkRateLimit(user.id)) {
      logger.warn("Rate limit exceeded for invitations", { userId: user.id, requestId });
      return new Response(
        JSON.stringify({
          success: false,
          error: "Too many invitations sent. Please try again later.",
          requestId,
        } satisfies InvitationResponse),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const validation = validateRequest(body);

    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: validation.error,
          requestId,
        } satisfies InvitationResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { recipientEmail, senderName, senderEmail, message } = validation.data;

    // Build and send email
    const emailService = getEmailService();
    const { subject, html } = buildInvitationEmail({ recipientEmail, senderName, senderEmail, message });

    logger.info("Sending invitation email", {
      recipientEmail: recipientEmail.substring(0, 3) + "***",
      senderName,
      userId: user.id,
      requestId,
    });

    const result = await emailService.sendEmail(
      {
        to: recipientEmail,
        subject,
        html,
        tags: ["invitation", "referral"],
        metadata: {
          type: "invitation",
          sender_id: user.id,
          sender_name: senderName,
        },
      },
      "notification"
    );

    const durationMs = Math.round(performance.now() - startTime);

    if (!result.success) {
      logger.error("Failed to send invitation email", {
        error: result.error,
        provider: result.provider,
        recipientEmail: recipientEmail.substring(0, 3) + "***",
        requestId,
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || "Failed to send invitation",
          requestId,
        } satisfies InvitationResponse),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Log analytics (non-blocking)
    logInvitationAnalytics(supabase, user.id, recipientEmail).catch((error) => {
      logger.warn("Failed to log invitation analytics", { error: String(error) });
    });

    logger.info("Invitation email sent successfully", {
      messageId: result.messageId,
      provider: result.provider,
      durationMs,
      requestId,
    });

    return new Response(
      JSON.stringify({
        success: true,
        messageId: result.messageId,
        requestId,
      } satisfies InvitationResponse),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        },
      }
    );
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    logger.error("Invitation handler error", error instanceof Error ? error : new Error(String(error)));

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        requestId,
      } satisfies InvitationResponse),
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

// ============================================================================
// Analytics
// ============================================================================

async function logInvitationAnalytics(
  supabase: ReturnType<typeof getSupabaseClient>,
  senderId: string,
  recipientEmail: string
): Promise<void> {
  try {
    await supabase.from("post_activity_logs").insert({
      actor_id: senderId,
      activity_type: "shared",
      notes: `invitation:email=${recipientEmail.substring(0, 3)}***:platform=ios`,
    });
  } catch {
    // Silently fail - analytics shouldn't break invitations
  }
}
