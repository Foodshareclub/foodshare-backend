/**
 * Rate Limiting Handlers
 *
 * Migrated from api-v1-login-rate/index.ts.
 * Checks lockout status before login and records attempts after.
 *
 * Thresholds (configured in DB RPCs):
 * - 5 failed attempts  → 5 minute lockout
 * - 10 failed attempts → 30 minute lockout
 * - 20 failed attempts → 24 hour lockout + email alert
 * - 100 attempts/hour per IP → 1 hour IP block
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { logger } from "../../_shared/logger.ts";
import type { AuthContext } from "./types.ts";
import type { RateCheckBody, RateRecordBody } from "./schemas.ts";

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
  supabase: SupabaseClient,
  email: string,
  ipAddress: string | null,
  failedCount: number,
  requestId: string,
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
      request_id: requestId,
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
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

// =============================================================================
// Handlers
// =============================================================================

export async function handleRateCheck(
  body: RateCheckBody,
  ctx: AuthContext,
): Promise<Response> {
  const { supabase, corsHeaders, clientIp } = ctx;
  const email = body.email.toLowerCase().trim();
  const ip = body.ipAddress || clientIp;

  const { data, error } = await supabase.rpc("check_lockout_status", {
    p_email: email,
    p_ip_address: ip,
  });

  if (error) {
    logger.error("Error checking lockout status", new Error(error.message));
    return new Response(
      JSON.stringify({ allowed: true, warning: "Could not verify lockout status" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const status = (data as LockoutStatus[])?.[0];

  if (!status) {
    return new Response(
      JSON.stringify({ allowed: true, isLocked: false, ipBlocked: false }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
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
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

export async function handleRateRecord(
  body: RateRecordBody,
  request: Request,
  ctx: AuthContext,
): Promise<Response> {
  const { supabase, corsHeaders, clientIp, requestId } = ctx;
  const email = body.email.toLowerCase().trim();
  const ip = body.ipAddress || clientIp;

  const { data, error } = await supabase.rpc("record_login_attempt", {
    p_email: email,
    p_ip_address: ip,
    p_user_agent: body.userAgent || request.headers.get("user-agent"),
    p_app_platform: body.appPlatform || null,
    p_app_version: body.appVersion || null,
    p_success: body.success,
    p_failure_reason: body.failureReason || null,
    p_metadata: body.metadata || {},
  });

  if (error) {
    logger.error("Error recording login attempt", new Error(error.message));
    return new Response(
      JSON.stringify({ recorded: false, warning: "Could not record login attempt" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const result = (data as RecordResult[])?.[0];

  // If this failure triggered a 24hr lockout, send alert
  if (!body.success && result?.is_locked && result.failed_count >= 20) {
    await sendLockoutAlert(supabase, email, ip, result.failed_count, requestId);
  }

  return new Response(
    JSON.stringify({
      recorded: true,
      isLocked: result?.is_locked || false,
      lockedUntil: result?.locked_until || null,
      failedCount: result?.failed_count || 0,
      ipBlocked: result?.ip_blocked || false,
      message: result?.is_locked
        ? `Account locked due to too many failed attempts. Try again ${formatTimeRemaining(result.locked_until)}.`
        : null,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
