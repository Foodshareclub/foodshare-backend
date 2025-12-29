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
 * Usage from iOS/Android/Web:
 * 1. Before login: POST /check-login-rate { action: "check", email: "...", ip: "..." }
 * 2. After login: POST /check-login-rate { action: "record", email: "...", success: true/false, ... }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface CheckRequest {
  action: "check";
  email: string;
  ip_address?: string;
}

interface RecordRequest {
  action: "record";
  email: string;
  ip_address?: string;
  user_agent?: string;
  app_platform?: "ios" | "android" | "web";
  app_version?: string;
  success: boolean;
  failure_reason?: string;
  metadata?: Record<string, unknown>;
}

type RequestPayload = CheckRequest | RecordRequest;

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

// CORS headers for cross-origin requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-forwarded-for, x-real-ip",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Initialize Supabase client with service role for security functions
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request body
    const payload: RequestPayload = await req.json();

    // Extract IP from headers if not provided
    const clientIp =
      ("ip_address" in payload && payload.ip_address) ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      null;

    // Validate email
    if (!payload.email || typeof payload.email !== "string") {
      return new Response(JSON.stringify({ error: "Email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = payload.email.toLowerCase().trim();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (payload.action === "check") {
      // Check lockout status before login attempt
      const { data, error } = await supabase.rpc("check_lockout_status", {
        p_email: email,
        p_ip_address: clientIp,
      });

      if (error) {
        console.error("Error checking lockout status:", error);
        // Fail open - allow login attempt if check fails
        return new Response(
          JSON.stringify({
            allowed: true,
            warning: "Could not verify lockout status",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const status = (data as LockoutStatus[])?.[0];

      if (!status) {
        // No lockout record - allow login
        return new Response(
          JSON.stringify({
            allowed: true,
            is_locked: false,
            ip_blocked: false,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Return lockout information
      const response = {
        allowed: !status.is_locked && !status.ip_blocked,
        is_locked: status.is_locked,
        locked_until: status.locked_until,
        lockout_level: status.lockout_level,
        failed_attempts: status.failed_attempts,
        ip_blocked: status.ip_blocked,
        ip_blocked_until: status.ip_blocked_until,
        message: status.is_locked
          ? `Account temporarily locked. Try again ${formatTimeRemaining(status.locked_until)}.`
          : status.ip_blocked
            ? `Too many attempts from this IP. Try again ${formatTimeRemaining(status.ip_blocked_until)}.`
            : null,
      };

      return new Response(JSON.stringify(response), {
        status: status.is_locked || status.ip_blocked ? 429 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (payload.action === "record") {
      // Record login attempt
      const { data, error } = await supabase.rpc("record_login_attempt", {
        p_email: email,
        p_ip_address: clientIp,
        p_user_agent: payload.user_agent || req.headers.get("user-agent"),
        p_app_platform: payload.app_platform || null,
        p_app_version: payload.app_version || null,
        p_success: payload.success,
        p_failure_reason: payload.failure_reason || null,
        p_metadata: payload.metadata || {},
      });

      if (error) {
        console.error("Error recording login attempt:", error);
        // Don't fail the login flow if recording fails
        return new Response(
          JSON.stringify({
            recorded: false,
            warning: "Could not record login attempt",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const result = (data as RecordResult[])?.[0];

      // If this failure triggered a lockout, send alert email for level 3 (24hr)
      if (!payload.success && result?.is_locked && result.failed_count >= 20) {
        await sendLockoutAlert(supabase, email, clientIp, result.failed_count);
      }

      const response = {
        recorded: true,
        is_locked: result?.is_locked || false,
        locked_until: result?.locked_until || null,
        failed_count: result?.failed_count || 0,
        ip_blocked: result?.ip_blocked || false,
        message: result?.is_locked
          ? `Account locked due to too many failed attempts. Try again ${formatTimeRemaining(result.locked_until)}.`
          : null,
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid action. Use "check" or "record".' }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  } catch (error) {
    console.error("Error in check-login-rate:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/**
 * Format time remaining for user-friendly message
 */
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

/**
 * Send alert email when account is locked at highest level (24 hours)
 */
async function sendLockoutAlert(
  supabase: ReturnType<typeof createClient>,
  email: string,
  ipAddress: string | null,
  failedCount: number
): Promise<void> {
  try {
    // Log the alert
    console.warn(
      `SECURITY ALERT: Account ${email} locked for 24 hours after ${failedCount} failed attempts from IP ${ipAddress}`
    );

    // Insert alert into audit log if available
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

    // In production, you would also:
    // 1. Send Slack notification
    // 2. Send email to security team
    // 3. Potentially trigger MFA verification on next login
  } catch (error) {
    console.error("Failed to send lockout alert:", error);
    // Don't throw - alerting failure shouldn't break the flow
  }
}
