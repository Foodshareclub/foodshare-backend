/**
 * check-login-rate Edge Function
 *
 * Provides brute force protection for authentication flows.
 * Checks lockout status before login and records attempts after.
 *
 * Thresholds:
 * - 5 failed attempts → 5 minute lockout
 * - 10 failed attempts → 30 minute lockout
 * - 20 failed attempts → 24 hour lockout + email alert
 * - 100 attempts/hour per IP → 1 hour IP block
 *
 * Endpoints:
 * POST /check-login-rate { action: "check", email: "..." }
 * POST /check-login-rate { action: "record", email: "...", success: true/false }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Schemas
// =============================================================================

const checkSchema = z.object({
  action: z.literal("check"),
  email: z.string().email(),
  ipAddress: z.string().ip().optional(),
});

const recordSchema = z.object({
  action: z.literal("record"),
  email: z.string().email(),
  ipAddress: z.string().ip().optional(),
  userAgent: z.string().optional(),
  appPlatform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().optional(),
  success: z.boolean(),
  failureReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const loginRateSchema = z.union([checkSchema, recordSchema]);

type LoginRateRequest = z.infer<typeof loginRateSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface LockoutStatus {
  is_locked: boolean;
  locked_until: string | null;
  lockout_level: number;
  failed_attempts: number;
  ip_blocked: boolean;
  ip_blocked_until: string | null;
}

interface RecordResult {
  is_locked: boolean;
  locked_until: string | null;
  failed_count: number;
  ip_blocked: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function formatTimeRemaining(isoDate: string | null): string {
  if (!isoDate) return "later";

  const until = new Date(isoDate);
  const now = new Date();
  const diffMs = until.getTime() - now.getTime();

  if (diffMs <= 0) return "now";

  const diffMinutes = Math.ceil(diffMs / 60000);

  if (diffMinutes < 60) {
    return `in ${diffMinutes} minute${diffMinutes === 1 ? "" : "s"}`;
  }

  const diffHours = Math.ceil(diffMinutes / 60);
  if (diffHours < 24) {
    return `in ${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  }

  const diffDays = Math.ceil(diffHours / 24);
  return `in ${diffDays} day${diffDays === 1 ? "" : "s"}`;
}

async function sendLockoutAlert(
  supabase: ReturnType<typeof createClient>,
  email: string,
  ipAddress: string | null,
  failedCount: number
): Promise<void> {
  try {
    logger.warn("SECURITY ALERT: Account locked for 24 hours", {
      email: email.substring(0, 3) + "***",
      failedAttempts: failedCount,
      ipAddress: ipAddress?.substring(0, 7) + "***",
    });

    await supabase.from("audit.vault_access_log").insert({
      user_id: null,
      secret_name: "SECURITY_ALERT",
      access_result: "lockout_alert",
      ip_address: ipAddress,
      user_agent: null,
      request_id: crypto.randomUUID(),
      additional_info: {
        type: "account_lockout_24hr",
        email: email,
        failed_attempts: failedCount,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error(
      "Failed to send lockout alert",
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

// =============================================================================
// Handlers
// =============================================================================

async function handleCheckLogin(
  ctx: HandlerContext<LoginRateRequest>
): Promise<Response> {
  const { supabase, body, request } = ctx;

  const email = body.email.toLowerCase().trim();

  // Extract IP from headers if not provided
  const clientIp =
    ("ipAddress" in body && body.ipAddress) ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;

  if (body.action === "check") {
    // Check lockout status before login attempt
    const { data, error } = await supabase.rpc("check_lockout_status", {
      p_email: email,
      p_ip_address: clientIp,
    });

    if (error) {
      logger.error("Error checking lockout status", new Error(error.message));
      // Fail open - allow login attempt if check fails
      return ok({
        allowed: true,
        warning: "Could not verify lockout status",
      }, ctx);
    }

    const status = (data as LockoutStatus[])?.[0];

    if (!status) {
      return ok({
        allowed: true,
        isLocked: false,
        ipBlocked: false,
      }, ctx);
    }

    return ok({
      allowed: !status.is_locked && !status.ip_blocked,
      isLocked: status.is_locked,
      lockedUntil: status.locked_until,
      lockoutLevel: status.lockout_level,
      failedAttempts: status.failed_attempts,
      ipBlocked: status.ip_blocked,
      ipBlockedUntil: status.ip_blocked_until,
      message: status.is_locked
        ? `Account temporarily locked. Try again ${formatTimeRemaining(status.locked_until)}.`
        : status.ip_blocked
          ? `Too many attempts from this IP. Try again ${formatTimeRemaining(status.ip_blocked_until)}.`
          : null,
    }, ctx);
  } else if (body.action === "record") {
    // Record login attempt
    const { data, error } = await supabase.rpc("record_login_attempt", {
      p_email: email,
      p_ip_address: clientIp,
      p_user_agent: body.userAgent || request.headers.get("user-agent"),
      p_app_platform: body.appPlatform || null,
      p_app_version: body.appVersion || null,
      p_success: body.success,
      p_failure_reason: body.failureReason || null,
      p_metadata: body.metadata || {},
    });

    if (error) {
      logger.error("Error recording login attempt", new Error(error.message));
      return ok({
        recorded: false,
        warning: "Could not record login attempt",
      }, ctx);
    }

    const result = (data as RecordResult[])?.[0];

    // If this failure triggered a lockout, send alert email for level 3 (24hr)
    if (!body.success && result?.is_locked && result.failed_count >= 20) {
      await sendLockoutAlert(supabase, email, clientIp, result.failed_count);
    }

    return ok({
      recorded: true,
      isLocked: result?.is_locked || false,
      lockedUntil: result?.locked_until || null,
      failedCount: result?.failed_count || 0,
      ipBlocked: result?.ip_blocked || false,
      message: result?.is_locked
        ? `Account locked due to too many failed attempts. Try again ${formatTimeRemaining(result.locked_until)}.`
        : null,
    }, ctx);
  }

  throw new ValidationError('Invalid action. Use "check" or "record".');
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "check-login-rate",
  version: "2.0.0",
  requireAuth: false, // Pre-auth endpoint
  rateLimit: {
    limit: 100,
    windowMs: 60000, // 100 requests per minute per IP
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: loginRateSchema,
      handler: handleCheckLogin,
    },
  },
});
