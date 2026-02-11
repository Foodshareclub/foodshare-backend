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

import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { AppError } from "../_shared/errors.ts";
import { parseRoute } from "../_shared/routing.ts";
import { authenticate, getServiceClient } from "./lib/auth.ts";
import {
  handleAdminRoute,
  handleDashboard,
  handleDigestProcess,
  handleDisableDnd,
  handleEnableDnd,
  handleGetPreferences,
  handleHealth,
  handleSend,
  handleSendBatch,
  handleSendTemplate,
  handleStats,
  handleTrigger,
  handleUpdatePreferences,
  handleWebhook,
} from "./lib/handlers/index.ts";
import type { AuthMode, NotificationContext } from "./lib/types.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-notifications";

// =============================================================================
// Shared Router Logic
// =============================================================================

async function routeRequest(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const route = parseRoute(url, ctx.request.method, SERVICE);
  const { segments } = route;
  const method = ctx.request.method;

  // Determine auth mode and CORS based on route
  let authMode: AuthMode = "jwt";
  let usePermissiveCors = false;
  let provider: string | undefined;
  let rawBody: string | undefined;

  // Route classification
  const isHealth = segments.length === 0 || segments[0] === "health";
  const isStats = segments[0] === "stats";
  const isWebhook = segments[0] === "webhook";
  const isTrigger = segments[0] === "trigger";
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
    rawBody = await ctx.request.text();
  } else if (isTrigger) {
    const triggerType = segments[1];
    if (triggerType === "new-listing") {
      authMode = "jwt";
    } else {
      authMode = "none";
      usePermissiveCors = true;
    }
  } else if (isDigestProcess) {
    authMode = "service";
  } else if (isAdmin) {
    authMode = "admin";
  }

  const corsHeaders = usePermissiveCors ? getCorsHeaders(ctx.request) : ctx.corsHeaders;

  const requestId = ctx.ctx.requestId;

  // Authenticate
  const auth = await authenticate(ctx.request, authMode, provider, rawBody);
  if (!auth.authenticated) {
    logger.warn("Authentication failed", {
      requestId,
      path: url.pathname,
      method,
      authMode,
      error: auth.error,
    });
    return new Response(
      JSON.stringify({ success: false, error: auth.error || "Authentication failed" }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
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

  const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // =========================================================================
  // Public Routes
  // =========================================================================

  if (isHealth && method === "GET") {
    const result = await handleHealth(context);
    return jsonResponse(result);
  }

  if (isStats && method === "GET") {
    const result = await handleStats(context);
    return jsonResponse(result, result.success ? 200 : 500);
  }

  // =========================================================================
  // Webhook Routes
  // =========================================================================

  if (isWebhook && method === "POST" && provider) {
    const body = JSON.parse(rawBody!);
    const result = await handleWebhook(provider, body, context);
    return jsonResponse(result);
  }

  // =========================================================================
  // Service Routes
  // =========================================================================

  if (isDigestProcess && method === "POST") {
    const body = await ctx.request.json().catch(() => ({}));
    const result = await handleDigestProcess(body, context);
    return jsonResponse(result, result.success ? 200 : 500);
  }

  // =========================================================================
  // Send Routes (JWT)
  // =========================================================================

  if (segments[0] === "send" && segments.length === 1 && method === "POST") {
    const body = await ctx.request.json();
    const result = await handleSend(body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (segments[0] === "send" && segments[1] === "batch" && method === "POST") {
    const body = await ctx.request.json();
    const result = await handleSendBatch(body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (segments[0] === "send" && segments[1] === "template" && method === "POST") {
    const body = await ctx.request.json();
    const result = await handleSendTemplate(body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  // =========================================================================
  // Preference Routes (JWT)
  // =========================================================================

  if (segments[0] === "preferences" && segments.length === 1 && method === "GET") {
    const result = await handleGetPreferences(context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (segments[0] === "preferences" && segments.length === 1 && method === "PUT") {
    const body = await ctx.request.json();
    const result = await handleUpdatePreferences(body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (segments[0] === "preferences" && segments[1] === "dnd" && method === "POST") {
    const body = await ctx.request.json().catch(() => ({}));
    const result = await handleEnableDnd(body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (segments[0] === "preferences" && segments[1] === "dnd" && method === "DELETE") {
    const result = await handleDisableDnd(context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  // =========================================================================
  // Dashboard Routes (JWT)
  // =========================================================================

  if (segments[0] === "dashboard" && segments.length === 1 && method === "GET") {
    const result = await handleDashboard(context);
    return jsonResponse(result, result.success ? 200 : 500);
  }

  // =========================================================================
  // List Notifications (JWT)
  // =========================================================================

  if (segments.length === 0 && method === "GET") {
    const { handleListNotifications } = await import("./lib/handlers/index.ts");
    const result = await handleListNotifications(url, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  // =========================================================================
  // Trigger Routes (Database Webhooks)
  // =========================================================================

  if (isTrigger && method === "POST" && segments[1]) {
    const triggerType = segments[1];
    const body = await ctx.request.json().catch(() => ({}));
    const result = await handleTrigger(triggerType, body, context);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  // =========================================================================
  // Admin Routes
  // =========================================================================

  if (isAdmin) {
    const body = ["POST", "PUT", "PATCH"].includes(method)
      ? await ctx.request.json().catch(() => ({}))
      : {};
    const result = await handleAdminRoute(segments, method, body, context);
    return jsonResponse(result, result.status || (result.success ? 200 : 400));
  }

  // =========================================================================
  // 404 Not Found
  // =========================================================================

  throw new AppError("Not found", "NOT_FOUND", 404, {
    details: {
      path: url.pathname,
      method,
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
        "POST /trigger/:type",
        "GET  /admin/*",
      ],
    },
  });
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false, // Auth handled per-route
  csrf: false,
  rateLimit: {
    limit: 60,
    windowMs: 60_000,
    keyBy: "user",
  },
  routes: {
    GET: { handler: routeRequest },
    POST: { handler: routeRequest },
    PUT: { handler: routeRequest },
    DELETE: { handler: routeRequest },
  },
}));
