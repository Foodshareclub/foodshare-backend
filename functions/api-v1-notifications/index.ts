/**
 * Unified Notification API v1
 *
 * Enterprise-grade notification system consolidating ALL notification channels:
 * - Email (Resend, Brevo, AWS SES, MailerSend)
 * - Push (FCM, APNs, WebPush)
 * - SMS (Twilio - future)
 * - In-App (Supabase Realtime)
 *
 * Features:
 * - Smart routing based on user preferences
 * - Quiet hours and Do Not Disturb mode
 * - Digest batching (hourly, daily, weekly)
 * - Multi-channel delivery with fallbacks
 * - Priority bypasses for critical notifications
 * - Comprehensive tracking and metrics
 * - Webhook delivery events
 * - Admin operations
 *
 * Authentication Modes:
 * - Public: /health, /stats
 * - JWT: Most user-facing routes
 * - Service: /digest/process (cron), internal calls
 * - Webhook: /webhook/:provider (signature verification)
 * - Admin: /admin/* routes (JWT + admin role)
 *
 * @module api-v1-notifications
 * @version 1.0.0
 */

import { getCorsHeaders, handleCorsPrelight, getPermissiveCorsHeaders } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { authenticate, getServiceClient } from "./lib/auth.ts";
import {
  handleSend,
  handleSendBatch,
  handleSendTemplate,
  handleHealth,
  handleStats,
  handleGetPreferences,
  handleUpdatePreferences,
  handleEnableDnd,
  handleDisableDnd,
  handleWebhook,
  handleDigestProcess,
  handleDashboard,
} from "./lib/handlers/index.ts";
import type { AuthMode, NotificationContext } from "./lib/types.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-notifications";

// =============================================================================
// Route Parser
// =============================================================================

interface ParsedRoute {
  path: string;
  segments: string[];
  params: Record<string, string>;
}

function parseRoute(url: URL): ParsedRoute {
  const path = url.pathname
    .replace(/^\/api-v1-notifications\/?/, "")
    .replace(/^\/+/, "");

  const segments = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  return { path, segments, params };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400
): Response {
  return jsonResponse({ success: false, error }, corsHeaders, status);
}

// =============================================================================
// Main Router
// =============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const startTime = performance.now();
  const requestId = crypto.randomUUID();

  const url = new URL(req.url);
  const { segments } = parseRoute(url);
  const method = req.method;

  // Determine auth mode and CORS based on route
  let authMode: AuthMode = "jwt";
  let usePermissiveCors = false;
  let provider: string | undefined;
  let rawBody: string | undefined;

  // Route classification
  const isHealth = segments.length === 0 || segments[0] === "health";
  const isStats = segments[0] === "stats";
  const isWebhook = segments[0] === "webhook";
  const isDigestProcess = segments[0] === "digest" && segments[1] === "process";
  const isAdmin = segments[0] === "admin";

  // Set auth mode
  if (isHealth || isStats) {
    authMode = "none";
    usePermissiveCors = true;
  } else if (isWebhook) {
    authMode = "webhook";
    provider = segments[1];
    usePermissiveCors = true;
    rawBody = await req.text();
  } else if (isDigestProcess) {
    authMode = "service";
  } else if (isAdmin) {
    authMode = "admin";
  }

  const corsHeaders = usePermissiveCors
    ? getPermissiveCorsHeaders()
    : getCorsHeaders(req);

  try {
    // Authenticate
    const auth = await authenticate(req, authMode, provider, rawBody);
    if (!auth.authenticated) {
      logger.warn("Authentication failed", {
        requestId,
        path: url.pathname,
        method,
        authMode,
        error: auth.error,
      });
      return errorResponse(auth.error || "Authentication failed", corsHeaders, 401);
    }

    // Create context
    const context: NotificationContext = {
      supabase: getServiceClient(),
      requestId,
      userId: auth.userId,
      isAdmin: auth.isAdmin,
    };

    logger.info("Request received", {
      requestId,
      path: url.pathname,
      method,
      userId: auth.userId,
      authMode,
    });

    // =========================================================================
    // Public Routes
    // =========================================================================

    // GET / or GET /health
    if (isHealth && method === "GET") {
      const result = await handleHealth(context);
      return jsonResponse(result, corsHeaders);
    }

    // GET /stats
    if (isStats && method === "GET") {
      const result = await handleStats(context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 500);
    }

    // =========================================================================
    // Webhook Routes
    // =========================================================================

    // POST /webhook/:provider
    if (isWebhook && method === "POST" && provider) {
      const body = JSON.parse(rawBody!);
      const result = await handleWebhook(provider, body, context);
      return jsonResponse(result, corsHeaders);
    }

    // =========================================================================
    // Service Routes
    // =========================================================================

    // POST /digest/process
    if (isDigestProcess && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const result = await handleDigestProcess(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 500);
    }

    // =========================================================================
    // Send Routes (JWT)
    // =========================================================================

    // POST /send
    if (segments[0] === "send" && segments.length === 1 && method === "POST") {
      const body = await req.json();
      const result = await handleSend(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // POST /send/batch
    if (segments[0] === "send" && segments[1] === "batch" && method === "POST") {
      const body = await req.json();
      const result = await handleSendBatch(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // POST /send/template
    if (segments[0] === "send" && segments[1] === "template" && method === "POST") {
      const body = await req.json();
      const result = await handleSendTemplate(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // =========================================================================
    // Preference Routes (JWT)
    // =========================================================================

    // GET /preferences
    if (segments[0] === "preferences" && segments.length === 1 && method === "GET") {
      const result = await handleGetPreferences(context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // PUT /preferences
    if (segments[0] === "preferences" && segments.length === 1 && method === "PUT") {
      const body = await req.json();
      const result = await handleUpdatePreferences(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // POST /preferences/dnd
    if (
      segments[0] === "preferences" &&
      segments[1] === "dnd" &&
      method === "POST"
    ) {
      const body = await req.json().catch(() => ({}));
      const result = await handleEnableDnd(body, context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // DELETE /preferences/dnd
    if (
      segments[0] === "preferences" &&
      segments[1] === "dnd" &&
      method === "DELETE"
    ) {
      const result = await handleDisableDnd(context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 400);
    }

    // =========================================================================
    // Dashboard Routes (JWT)
    // =========================================================================

    // GET /dashboard
    if (segments[0] === "dashboard" && segments.length === 1 && method === "GET") {
      const result = await handleDashboard(context);
      return jsonResponse(result, corsHeaders, result.success ? 200 : 500);
    }

    // =========================================================================
    // Admin Routes
    // =========================================================================

    if (isAdmin) {
      // TODO: Implement admin routes
      return jsonResponse(
        { success: false, error: "Admin routes not yet implemented" },
        corsHeaders,
        501
      );
    }

    // =========================================================================
    // 404 Not Found
    // =========================================================================

    return jsonResponse(
      {
        success: false,
        error: "Not found",
        path: url.pathname,
        method,
        service: SERVICE,
        version: VERSION,
        availableRoutes: [
          "GET  /health",
          "GET  /stats",
          "GET  /dashboard",
          "POST /send",
          "POST /send/batch",
          "POST /send/template",
          "GET  /preferences",
          "PUT  /preferences",
          "POST /preferences/dnd",
          "DELETE /preferences/dnd",
          "POST /digest/process",
          "POST /webhook/:provider",
        ],
      },
      corsHeaders,
      404
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Request failed", err, {
      requestId,
      path: url.pathname,
      method,
    });

    return jsonResponse(
      {
        success: false,
        error: err.message,
        service: SERVICE,
        version: VERSION,
        requestId,
      },
      corsHeaders,
      500
    );
  } finally {
    const duration = performance.now() - startTime;
    if (duration > 5000) {
      logger.warn("Slow request", {
        requestId,
        path: url.pathname,
        method,
        durationMs: Math.round(duration),
      });
    }
  }
});
