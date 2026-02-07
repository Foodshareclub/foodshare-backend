/**
 * Unified Auth API v1
 *
 * Consolidates brute force protection and email verification
 * into a single path-routed function.
 *
 * Routes:
 * - GET  /            Health check
 * - GET  /health      Health check
 * - POST /rate/check  Check lockout before login
 * - POST /rate/record Record login attempt
 * - POST /verify/send      Generate code + send email
 * - POST /verify/confirm   Validate code, mark verified
 * - POST /verify/resend    Rate-limited resend (3/hr)
 *
 * @module api-v1-auth
 * @version 1.0.0
 */

import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError, AppError } from "../_shared/errors.ts";
import { parseRoute } from "../_shared/routing.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  rateCheckSchema,
  rateRecordSchema,
  verifySendSchema,
  verifyConfirmSchema,
  verifyResendSchema,
} from "./lib/schemas.ts";
import { handleRateCheck, handleRateRecord } from "./lib/rate.ts";
import { handleVerifySend, handleVerifyConfirm, handleVerifyResend } from "./lib/verify.ts";
import type { AuthContext } from "./lib/types.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-auth";

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const route = parseRoute(url, ctx.request.method, SERVICE);

  // Extract client IP
  const clientIp =
    ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ctx.request.headers.get("x-real-ip") ||
    null;

  // Parse body
  const body = ctx.body;
  if (!body) {
    throw new ValidationError("Invalid JSON body");
  }

  // Build context (service role — all routes are pre-auth)
  const supabase = getSupabaseClient();
  const requestId = ctx.ctx.requestId;
  const authCtx: AuthContext = { supabase, requestId, corsHeaders: ctx.corsHeaders, clientIp };

  logger.info("Auth request", {
    requestId,
    path: url.pathname,
    resource: route.resource,
    action: route.subPath || null,
  });

  try {
    // Route: /rate/*
    if (route.resource === "rate") {
      if (route.subPath === "check") {
        const parsed = rateCheckSchema.parse(body);
        return await handleRateCheck(parsed, authCtx);
      }

      if (route.subPath === "record") {
        const parsed = rateRecordSchema.parse(body);
        return await handleRateRecord(parsed, ctx.request, authCtx);
      }

      throw new AppError("Not found", "NOT_FOUND", 404, {
        details: { availableActions: ["check", "record"] },
      });
    }

    // Route: /verify/*
    if (route.resource === "verify") {
      if (route.subPath === "send") {
        const parsed = verifySendSchema.parse(body);
        return await handleVerifySend(parsed, authCtx);
      }

      if (route.subPath === "confirm") {
        const parsed = verifyConfirmSchema.parse(body);
        return await handleVerifyConfirm(parsed, authCtx);
      }

      if (route.subPath === "resend") {
        const parsed = verifyResendSchema.parse(body);
        return await handleVerifyResend(parsed, authCtx);
      }

      throw new AppError("Not found", "NOT_FOUND", 404, {
        details: { availableActions: ["send", "confirm", "resend"] },
      });
    }

    throw new AppError("Not found", "NOT_FOUND", 404, {
      details: { availableResources: ["rate", "verify", "health"] },
    });
  } catch (error) {
    // Zod validation errors → ValidationError
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Validation failed",
        error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }))
      );
    }
    throw error;
  }
}

// =============================================================================
// API Handler
// =============================================================================

export default createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 100,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
});
