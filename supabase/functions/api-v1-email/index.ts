/**
 * Unified Email API v1 (api-v1-email)
 *
 * Full email API exposing queue processing, direct sending, template sending,
 * and provider health/quota monitoring.
 *
 * Routes:
 * - GET  /          - Queue stats (pending, failed, sent counts) [service/cron auth]
 * - POST /process   - Process batch from queue (existing cron logic) [service/cron auth]
 * - POST /process/automation - Process automation drip queue [service/cron auth]
 * - POST /send      - Send a single email (for apps) [JWT auth]
 * - POST /send/template - Send using a named template slug [JWT auth]
 * - POST /send/invitation - Send invitation to non-user [JWT auth]
 * - GET  /providers - Provider health + quota status [service auth]
 * - GET  /health    - Health check [no auth]
 *
 * @module api-v1-email
 */

import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { AppError } from "../_shared/errors.ts";
import { VERSION } from "./lib/utils.ts";

// Schemas (used for route-level validation)
import {
  processSchema,
  sendSchema,
  sendTemplateSchema,
  sendInvitationSchema,
  automationProcessSchema,
} from "./lib/schemas.ts";

// Handlers
import { handleSend, handleSendTemplate, handleSendInvitation, handleProviders, handleHealth } from "./lib/send.ts";
import { handleGetStats, handleProcess, handleProcessAutomation } from "./lib/queue.ts";

// =============================================================================
// Route Dispatch
// =============================================================================

function handleGet(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  if (path.endsWith("/health")) {
    return handleHealth(ctx);
  }

  if (path.endsWith("/providers")) {
    return handleProviders(ctx);
  }

  // GET / — queue stats
  return handleGetStats(ctx);
}

function handlePost(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  if (path.endsWith("/process/automation")) {
    const body = automationProcessSchema.parse(ctx.body || {});
    return handleProcessAutomation({ ...ctx, body } as HandlerContext<typeof body>);
  }

  if (path.endsWith("/process")) {
    const body = processSchema.parse(ctx.body);
    return handleProcess({ ...ctx, body } as HandlerContext<typeof body>);
  }

  if (path.endsWith("/send/invitation")) {
    const body = sendInvitationSchema.parse(ctx.body);
    return handleSendInvitation({ ...ctx, body } as HandlerContext<typeof body>);
  }

  if (path.endsWith("/send/template")) {
    const body = sendTemplateSchema.parse(ctx.body);
    return handleSendTemplate({ ...ctx, body } as HandlerContext<typeof body>);
  }

  if (path.endsWith("/send")) {
    const body = sendSchema.parse(ctx.body);
    return handleSend({ ...ctx, body } as HandlerContext<typeof body>);
  }

  throw new AppError("Unknown route. Available: /process, /send, /send/template, /send/invitation", "NOT_FOUND", 404);
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-email",
  version: VERSION,
  requireAuth: false, // Auth handled per-route (service/cron for queue ops, JWT for send)
  csrf: false, // Service-to-service + cron + mobile clients
  rateLimit: {
    limit: 30,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGet,
    },
    POST: {
      handler: handlePost,
    },
  },
}));
