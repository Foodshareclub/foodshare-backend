/**
 * Email Verification Handlers
 *
 * Core logic extracted from telegram-bot-foodshare/handlers/auth.ts.
 * Platform-agnostic — used by web, iOS, Android.
 *
 * Flow:
 * 1. POST /verify/send   — generate 6-digit code, store on profile, send email
 * 2. POST /verify/confirm — validate code, mark email_verified = true
 * 3. POST /verify/resend  — rate-limited resend (3/hr per email)
 *
 * DB columns used (on `profiles` table):
 * - verification_code
 * - verification_code_expires_at
 * - verification_attempts
 * - verification_locked_until
 */

import { logger } from "../../_shared/logger.ts";
import { getEmailService } from "../../_shared/email/index.ts";
import type { AuthContext } from "./types.ts";
import type { VerifySendBody, VerifyConfirmBody, VerifyResendBody } from "./schemas.ts";

// =============================================================================
// Constants
// =============================================================================

const MAX_VERIFICATION_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const CODE_EXPIRY_MINUTES = 15;

// Resend rate limit: 3 per hour per email (in-memory)
const RESEND_RATE_LIMIT_MAX = 3;
const RESEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const resendRateLimitMap = new Map<string, { count: number; resetAt: number }>();

// =============================================================================
// Helpers
// =============================================================================

function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function json(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function checkResendRateLimit(email: string): { allowed: boolean; remainingMinutes?: number } {
  const key = email.toLowerCase().trim();
  const now = Date.now();
  const limit = resendRateLimitMap.get(key);

  // Clean up expired entry
  if (limit && limit.resetAt < now) {
    resendRateLimitMap.delete(key);
  }

  const current = resendRateLimitMap.get(key);

  if (!current) {
    resendRateLimitMap.set(key, { count: 1, resetAt: now + RESEND_RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (current.count >= RESEND_RATE_LIMIT_MAX) {
    const remainingMs = current.resetAt - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { allowed: false, remainingMinutes };
  }

  current.count++;
  return { allowed: true };
}

async function sendVerificationEmail(email: string, code: string): Promise<boolean> {
  try {
    const emailService = getEmailService();
    const result = await emailService.sendEmail({
      to: email,
      subject: "FoodShare - Verify Your Email",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #22c55e;">FoodShare Email Verification</h2>
          <p>Your verification code is:</p>
          <div style="background: #f3f4f6; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #22c55e;">${code}</span>
          </div>
          <p>Enter this code in the app to verify your email.</p>
          <p style="color: #6b7280; font-size: 14px;">This code expires in ${CODE_EXPIRY_MINUTES} minutes.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
          <p style="color: #9ca3af; font-size: 12px;">If you didn't request this, please ignore this email.</p>
        </div>
      `,
      tags: ["verification"],
    }, "auth");

    return result.success;
  } catch (error) {
    logger.error(
      "Failed to send verification email",
      error instanceof Error ? error : new Error(String(error)),
    );
    return false;
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /verify/send
 * Generate a 6-digit code, store it on the profile, and send via email.
 */
export async function handleVerifySend(
  body: VerifySendBody,
  ctx: AuthContext,
): Promise<Response> {
  const { supabase, corsHeaders } = ctx;
  const email = body.email.toLowerCase().trim();

  // Look up profile by email
  const { data: profile, error: lookupError } = await supabase
    .from("profiles")
    .select("id, email_verified, verification_locked_until, verification_attempts")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    logger.error("Error looking up profile", new Error(lookupError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  if (!profile) {
    return json({ success: false, error: "No account found for this email" }, corsHeaders, 404);
  }

  if (profile.email_verified) {
    return json({ success: false, error: "Email is already verified" }, corsHeaders, 409);
  }

  // Check lockout
  if (profile.verification_locked_until) {
    const lockedUntil = new Date(profile.verification_locked_until);
    if (lockedUntil > new Date()) {
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      return json({
        success: false,
        error: "Account temporarily locked due to too many failed attempts",
        lockedUntil: profile.verification_locked_until,
        remainingMinutes,
      }, corsHeaders, 429);
    }
  }

  // Generate code and store
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      verification_code: code,
      verification_code_expires_at: expiresAt.toISOString(),
      verification_attempts: 0,
      verification_locked_until: null,
    })
    .eq("id", profile.id);

  if (updateError) {
    logger.error("Error storing verification code", new Error(updateError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  // Send email
  const sent = await sendVerificationEmail(email, code);
  if (!sent) {
    return json({ success: false, error: "Failed to send verification email" }, corsHeaders, 502);
  }

  logger.info("Verification code sent", { email: email.substring(0, 3) + "***", requestId: ctx.requestId });

  return json({
    success: true,
    message: "Verification code sent",
    expiresAt: expiresAt.toISOString(),
  }, corsHeaders);
}

/**
 * POST /verify/confirm
 * Validate the code against the profile. On success, mark email_verified = true.
 */
export async function handleVerifyConfirm(
  body: VerifyConfirmBody,
  ctx: AuthContext,
): Promise<Response> {
  const { supabase, corsHeaders } = ctx;
  const email = body.email.toLowerCase().trim();

  // Look up profile
  const { data: profile, error: lookupError } = await supabase
    .from("profiles")
    .select("id, verification_code, verification_code_expires_at, verification_attempts, verification_locked_until")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    logger.error("Error looking up profile", new Error(lookupError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  if (!profile) {
    return json({ success: false, error: "No account found for this email" }, corsHeaders, 404);
  }

  // Check lockout
  if (profile.verification_locked_until) {
    const lockedUntil = new Date(profile.verification_locked_until);
    if (lockedUntil > new Date()) {
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      return json({
        success: false,
        error: "Account temporarily locked due to too many failed attempts",
        lockedUntil: profile.verification_locked_until,
        remainingMinutes,
      }, corsHeaders, 429);
    }
  }

  // Check code expiry
  if (
    !profile.verification_code_expires_at ||
    new Date(profile.verification_code_expires_at) < new Date()
  ) {
    return json({ success: false, error: "Verification code has expired. Request a new one." }, corsHeaders, 410);
  }

  // Check code match
  if (profile.verification_code !== body.code) {
    const newAttempts = (profile.verification_attempts || 0) + 1;
    const attemptsLeft = MAX_VERIFICATION_ATTEMPTS - newAttempts;

    if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      // Lock the account
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
      await supabase
        .from("profiles")
        .update({
          verification_attempts: newAttempts,
          verification_locked_until: lockedUntil.toISOString(),
        })
        .eq("id", profile.id);

      logger.warn("Account locked due to failed verification attempts", {
        profileId: profile.id,
        attempts: newAttempts,
        requestId: ctx.requestId,
      });

      return json({
        success: false,
        error: "Too many failed attempts. Account temporarily locked.",
        lockedUntil: lockedUntil.toISOString(),
        remainingMinutes: LOCKOUT_DURATION_MINUTES,
      }, corsHeaders, 429);
    }

    await supabase
      .from("profiles")
      .update({ verification_attempts: newAttempts })
      .eq("id", profile.id);

    return json({
      success: false,
      error: "Incorrect verification code",
      attemptsRemaining: attemptsLeft,
    }, corsHeaders, 400);
  }

  // Code is correct — mark verified and clear verification state
  const { error: verifyError } = await supabase
    .from("profiles")
    .update({
      email_verified: true,
      verification_code: null,
      verification_code_expires_at: null,
      verification_attempts: 0,
      verification_locked_until: null,
    })
    .eq("id", profile.id);

  if (verifyError) {
    logger.error("Error marking email verified", new Error(verifyError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  logger.info("Email verified successfully", { profileId: profile.id, requestId: ctx.requestId });

  return json({ success: true, message: "Email verified successfully" }, corsHeaders);
}

/**
 * POST /verify/resend
 * Rate-limited resend (3/hr per email). Generates a new code.
 */
export async function handleVerifyResend(
  body: VerifyResendBody,
  ctx: AuthContext,
): Promise<Response> {
  const { supabase, corsHeaders } = ctx;
  const email = body.email.toLowerCase().trim();

  // Check resend rate limit
  const rateLimit = checkResendRateLimit(email);
  if (!rateLimit.allowed) {
    return json({
      success: false,
      error: "Too many resend requests. Please wait before trying again.",
      remainingMinutes: rateLimit.remainingMinutes,
    }, corsHeaders, 429);
  }

  // Look up profile
  const { data: profile, error: lookupError } = await supabase
    .from("profiles")
    .select("id, email_verified, verification_locked_until")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    logger.error("Error looking up profile", new Error(lookupError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  if (!profile) {
    return json({ success: false, error: "No account found for this email" }, corsHeaders, 404);
  }

  if (profile.email_verified) {
    return json({ success: false, error: "Email is already verified" }, corsHeaders, 409);
  }

  // Check lockout
  if (profile.verification_locked_until) {
    const lockedUntil = new Date(profile.verification_locked_until);
    if (lockedUntil > new Date()) {
      const remainingMs = lockedUntil.getTime() - Date.now();
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      return json({
        success: false,
        error: "Account temporarily locked",
        lockedUntil: profile.verification_locked_until,
        remainingMinutes,
      }, corsHeaders, 429);
    }
  }

  // Generate new code
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      verification_code: code,
      verification_code_expires_at: expiresAt.toISOString(),
    })
    .eq("id", profile.id);

  if (updateError) {
    logger.error("Error storing verification code", new Error(updateError.message));
    return json({ success: false, error: "Internal error" }, corsHeaders, 500);
  }

  // Send email
  const sent = await sendVerificationEmail(email, code);
  if (!sent) {
    return json({ success: false, error: "Failed to send verification email" }, corsHeaders, 502);
  }

  logger.info("Verification code resent", { email: email.substring(0, 3) + "***", requestId: ctx.requestId });

  return json({
    success: true,
    message: "New verification code sent",
    expiresAt: expiresAt.toISOString(),
  }, corsHeaders);
}
