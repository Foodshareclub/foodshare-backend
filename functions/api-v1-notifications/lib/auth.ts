/**
 * Multi-Mode Authentication
 *
 * Handles different authentication modes for the unified notification API:
 * - none: Public endpoints (health, stats)
 * - jwt: Standard user authentication
 * - service: Internal service-to-service (cron, other functions)
 * - webhook: External webhook verification (signature-based)
 * - admin: Admin operations (JWT + admin role check)
 *
 * @module api-v1-notifications/auth
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AuthMode, AuthResult } from "./types.ts";
import { logger } from "../../_shared/logger.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Webhook secrets
const WEBHOOK_SECRETS: Record<string, string> = {
  resend: Deno.env.get("RESEND_WEBHOOK_SECRET") || "",
  brevo: Deno.env.get("BREVO_WEBHOOK_SECRET") || "",
  ses: Deno.env.get("AWS_SES_WEBHOOK_SECRET") || "",
  mailersend: Deno.env.get("MAILERSEND_WEBHOOK_SECRET") || "",
  fcm: Deno.env.get("FCM_WEBHOOK_SECRET") || "",
  apns: Deno.env.get("APNS_WEBHOOK_SECRET") || "",
};

let serviceRoleClient: SupabaseClient | null = null;

/**
 * Get or create service role Supabase client (singleton)
 */
export function getServiceClient(): SupabaseClient {
  if (!serviceRoleClient) {
    serviceRoleClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceRoleClient;
}

/**
 * Authenticate request based on mode
 */
export async function authenticate(
  req: Request,
  mode: AuthMode,
  provider?: string,
  rawBody?: string
): Promise<AuthResult> {
  switch (mode) {
    case "none":
      return { authenticated: true };

    case "jwt":
      return await authenticateJWT(req);

    case "service":
      return authenticateService(req);

    case "webhook":
      return authenticateWebhook(req, provider, rawBody);

    case "admin":
      return await authenticateAdmin(req);

    default:
      return { authenticated: false, error: "Invalid auth mode" };
  }
}

/**
 * JWT authentication (standard user auth)
 */
async function authenticateJWT(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { authenticated: false, error: "Missing or invalid Authorization header" };
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      logger.warn("JWT authentication failed", { error: error?.message });
      return { authenticated: false, error: "Invalid or expired token" };
    }

    return {
      authenticated: true,
      userId: user.id,
    };
  } catch (error) {
    logger.error("JWT authentication error", error as Error);
    return { authenticated: false, error: "Authentication failed" };
  }
}

/**
 * Service authentication (internal service-to-service)
 * Validates service role key or internal secret
 */
function authenticateService(req: Request): AuthResult {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader) {
    return { authenticated: false, error: "Missing Authorization header" };
  }

  // Check for service role key
  if (authHeader === `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
    return { authenticated: true };
  }

  // Check for internal service secret
  const internalSecret = Deno.env.get("INTERNAL_SERVICE_SECRET");
  if (internalSecret && authHeader === `Bearer ${internalSecret}`) {
    return { authenticated: true };
  }

  return { authenticated: false, error: "Invalid service credentials" };
}

/**
 * Webhook authentication (signature verification)
 */
function authenticateWebhook(
  req: Request,
  provider?: string,
  rawBody?: string
): AuthResult {
  if (!provider) {
    return { authenticated: false, error: "Provider not specified" };
  }

  const secret = WEBHOOK_SECRETS[provider];

  if (!secret) {
    logger.warn("Webhook secret not configured", { provider });
    // For development, allow webhooks without secrets
    if (Deno.env.get("ENVIRONMENT") === "development") {
      return { authenticated: true };
    }
    return { authenticated: false, error: "Webhook secret not configured" };
  }

  try {
    // Provider-specific signature verification
    switch (provider) {
      case "resend":
        return verifyResendSignature(req, secret, rawBody);
      case "brevo":
        return verifyBrevoSignature(req, secret);
      case "ses":
        return verifySESSignature(req, secret, rawBody);
      case "mailersend":
        return verifyMailerSendSignature(req, secret, rawBody);
      case "fcm":
      case "apns":
        // FCM and APNs don't have webhook verification, check secret header
        return verifySecretHeader(req, secret);
      default:
        return { authenticated: false, error: "Unknown provider" };
    }
  } catch (error) {
    logger.error("Webhook verification error", error as Error, { provider });
    return { authenticated: false, error: "Webhook verification failed" };
  }
}

/**
 * Admin authentication (JWT + admin role check OR service role key)
 * Service role key is accepted for cron jobs and internal service calls
 */
async function authenticateAdmin(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");

  // Extract token from Bearer header
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  // Check if this is a service role key (for cron jobs)
  if (token && token === SUPABASE_SERVICE_ROLE_KEY) {
    logger.info("Admin auth via service role key (cron/internal)");
    return { authenticated: true, isAdmin: true };
  }

  // Also check for internal service secret
  const internalSecret = Deno.env.get("INTERNAL_SERVICE_SECRET");
  if (token && internalSecret && token === internalSecret) {
    logger.info("Admin auth via internal service secret");
    return { authenticated: true, isAdmin: true };
  }

  // Otherwise verify JWT
  const jwtResult = await authenticateJWT(req);

  if (!jwtResult.authenticated || !jwtResult.userId) {
    return jwtResult;
  }

  // Check admin role
  try {
    const supabase = getServiceClient();

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", jwtResult.userId)
      .single();

    if (error || !profile) {
      logger.warn("Admin check failed - profile not found", {
        userId: jwtResult.userId,
      });
      return { authenticated: false, error: "Profile not found" };
    }

    if (profile.role !== "admin" && profile.role !== "superadmin") {
      logger.warn("Admin check failed - insufficient permissions", {
        userId: jwtResult.userId,
        role: profile.role,
      });
      return { authenticated: false, error: "Admin access required" };
    }

    return {
      authenticated: true,
      userId: jwtResult.userId,
      isAdmin: true,
    };
  } catch (error) {
    logger.error("Admin authentication error", error as Error);
    return { authenticated: false, error: "Admin check failed" };
  }
}

// =============================================================================
// Provider-Specific Signature Verification
// =============================================================================

function verifyResendSignature(
  req: Request,
  secret: string,
  rawBody?: string
): AuthResult {
  const signature = req.headers.get("resend-signature");

  if (!signature || !rawBody) {
    return { authenticated: false, error: "Missing signature or body" };
  }

  // Resend uses HMAC-SHA256
  // Format: "t=timestamp,v1=signature"
  const parts = signature.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.split("=")[1];
  const sig = parts.find((p) => p.startsWith("v1="))?.split("=")[1];

  if (!timestamp || !sig) {
    return { authenticated: false, error: "Invalid signature format" };
  }

  // Verify timestamp (max 5 minutes old)
  const now = Math.floor(Date.now() / 1000);
  if (now - parseInt(timestamp) > 300) {
    return { authenticated: false, error: "Signature expired" };
  }

  const payload = `${timestamp}.${rawBody}`;
  const expectedSig = computeHmacSha256(payload, secret);

  if (constantTimeCompare(sig, expectedSig)) {
    return { authenticated: true };
  }

  return { authenticated: false, error: "Invalid signature" };
}

function verifyBrevoSignature(req: Request, secret: string): AuthResult {
  const signature = req.headers.get("x-brevo-signature");

  if (!signature) {
    return { authenticated: false, error: "Missing signature" };
  }

  // Brevo uses simple secret comparison
  if (constantTimeCompare(signature, secret)) {
    return { authenticated: true };
  }

  return { authenticated: false, error: "Invalid signature" };
}

function verifySESSignature(
  req: Request,
  secret: string,
  rawBody?: string
): AuthResult {
  // AWS SES uses SNS, which has its own signature verification
  // For now, use secret header comparison
  return verifySecretHeader(req, secret);
}

function verifyMailerSendSignature(
  req: Request,
  secret: string,
  rawBody?: string
): AuthResult {
  const signature = req.headers.get("mailersend-signature");

  if (!signature || !rawBody) {
    return { authenticated: false, error: "Missing signature or body" };
  }

  const expectedSig = computeHmacSha256(rawBody, secret);

  if (constantTimeCompare(signature, expectedSig)) {
    return { authenticated: true };
  }

  return { authenticated: false, error: "Invalid signature" };
}

function verifySecretHeader(req: Request, secret: string): AuthResult {
  const providedSecret =
    req.headers.get("x-webhook-secret") || req.headers.get("x-secret");

  if (!providedSecret) {
    return { authenticated: false, error: "Missing secret header" };
  }

  if (constantTimeCompare(providedSecret, secret)) {
    return { authenticated: true };
  }

  return { authenticated: false, error: "Invalid secret" };
}

// =============================================================================
// Crypto Utilities
// =============================================================================

function computeHmacSha256(data: string, key: string): string {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const dataBuffer = encoder.encode(data);

  return crypto.subtle
    .importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, dataBuffer))
    .then((signature) => {
      const hashArray = Array.from(new Uint8Array(signature));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    })
    .then((hash) => hash);
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
