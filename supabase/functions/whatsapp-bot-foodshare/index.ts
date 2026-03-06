/**
 * WhatsApp Bot FoodShare - Main Entry Point
 *
 * Enterprise-ready with:
 * - Unified createAPIHandler framework
 * - Webhook verification (GET with hub.challenge)
 * - Distributed rate limiting
 * - Request correlation IDs (from framework)
 * - Structured JSON logging
 * - Health checks
 */

import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { isDevelopment } from "../_shared/utils.ts";
import { WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN } from "./config/index.ts";
import { verifyMetaWebhook } from "../_shared/webhook-security.ts";
import { checkRateLimitDistributed } from "./services/rate-limiter.ts";
import { cleanupExpiredStates } from "./services/user-state.ts";
import { getWhatsAppApiStatus, markAsRead } from "./services/whatsapp-api.ts";
import {
  handleLocationMessage,
  handlePhotoMessage,
  handleTextMessage,
} from "./handlers/messages.ts";
import { handleButtonReply, handleListReply } from "./handlers/interactive.ts";
import type { WhatsAppMessage, WhatsAppWebhookPayload } from "./types/index.ts";

const VERSION = "1.1.0";
const SERVICE = "whatsapp-bot-foodshare";

// ============================================================================
// Initialization Check
// ============================================================================

let isInitialized = false;
let initError: Error | null = null;

try {
  const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!accessToken) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN environment variable");
  }
  if (!phoneNumberId) {
    throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID environment variable");
  }
  if (!verifyToken) {
    throw new Error("Missing WHATSAPP_VERIFY_TOKEN environment variable");
  }
  if (!supabaseUrl) {
    throw new Error("Missing SUPABASE_URL environment variable");
  }
  if (!supabaseKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");
  }

  isInitialized = true;
  logger.info("WhatsApp bot initialized successfully", { version: VERSION });
} catch (error) {
  initError = error instanceof Error ? error : new Error(String(error));
  logger.error("Initialization failed", initError);
}

// ============================================================================
// Security: Webhook Signature Verification
// ============================================================================

async function verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean> {
  if (!WHATSAPP_APP_SECRET) {
    if (isDevelopment()) {
      logger.warn(
        "WHATSAPP_APP_SECRET not configured - skipping signature verification (dev mode)",
      );
      return true;
    }
    logger.error("WHATSAPP_APP_SECRET not configured - rejecting request in production");
    return false;
  }

  const result = await verifyMetaWebhook(payload, headers, WHATSAPP_APP_SECRET);
  if (!result.valid) {
    logger.warn("Webhook signature verification failed", { error: result.error });
  }
  return result.valid;
}

// ============================================================================
// JSON Response helper (always return 200 to WhatsApp)
// ============================================================================

function jsonOk(body: unknown, ctx: HandlerContext, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

// ============================================================================
// Route Handlers
// ============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  if (!isInitialized) {
    return jsonOk(
      { error: "Service temporarily unavailable", details: initError?.message },
      ctx,
      503,
    );
  }

  const url = new URL(ctx.request.url);

  // Webhook verification request from Meta
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && challenge) {
    if (token === WHATSAPP_VERIFY_TOKEN) {
      logger.info("Webhook verified successfully");
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    } else {
      logger.warn("Webhook verification failed - invalid token");
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Health check (default GET)
  let cleanedStates = 0;
  try {
    cleanedStates = await cleanupExpiredStates();
  } catch {
    // Ignore cleanup errors in health check
  }

  const whatsappStatus = getWhatsAppApiStatus();
  const overallStatus = whatsappStatus.status === "OPEN" ? "degraded" : "healthy";

  return jsonOk(
    {
      status: overallStatus,
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
      dependencies: {
        whatsapp: {
          status: whatsappStatus.status,
          failures: whatsappStatus.failures,
        },
      },
      maintenance: {
        expiredStatesCleaned: cleanedStates,
      },
    },
    ctx,
    overallStatus === "healthy" ? 200 : 503,
  );
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const startTime = Date.now();
  const requestId = ctx.ctx.requestId;

  if (!isInitialized) {
    return jsonOk(
      { error: "Service temporarily unavailable", details: initError?.message },
      ctx,
      503,
    );
  }

  let payload: WhatsAppWebhookPayload | undefined;

  try {
    // Read raw body for signature verification
    const rawBody = await ctx.request.text();

    // Verify webhook signature
    const isValidSignature = await verifyWebhookSignature(rawBody, ctx.request.headers);

    if (!isValidSignature) {
      logger.warn("Invalid webhook signature", { requestId });
      return jsonOk({ error: "Invalid signature", requestId }, ctx, 401);
    }

    payload = JSON.parse(rawBody);

    // Validate payload structure
    if (payload?.object !== "whatsapp_business_account") {
      return jsonOk({ ok: true, requestId }, ctx);
    }

    // Process each entry
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;

        if (!value.messages || value.messages.length === 0) {
          continue;
        }

        for (const message of value.messages) {
          const phoneNumber = message.from;

          // Rate limiting
          const rateLimit = await checkRateLimitDistributed(phoneNumber);

          if (!rateLimit.allowed) {
            logger.warn("Rate limit exceeded", {
              requestId,
              phoneNumber: phoneNumber.substring(0, 4) + "***",
              retryAfter: rateLimit.retryAfterSeconds,
            });
            continue;
          }

          // Mark message as read
          await markAsRead(message.id);

          // Route message to appropriate handler
          await routeMessage(message, requestId, startTime);
        }
      }
    }

    return jsonOk({ ok: true, requestId }, ctx);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error("Error processing webhook", {
      requestId,
      error: errorMessage,
      stack: errorStack,
      durationMs: Date.now() - startTime,
    });

    // Always return 200 to WhatsApp to prevent retries
    return jsonOk({ ok: false, error: errorMessage, requestId }, ctx);
  }
}

// ============================================================================
// Message Router
// ============================================================================

async function routeMessage(
  message: WhatsAppMessage,
  requestId: string,
  startTime: number,
): Promise<void> {
  const phoneNumber = message.from;

  try {
    switch (message.type) {
      case "text":
        await handleTextMessage(message);
        logger.info("Text message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "image":
        await handlePhotoMessage(message);
        logger.info("Image message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "location":
        await handleLocationMessage(message);
        logger.info("Location message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "interactive":
        if (message.interactive?.type === "button_reply" && message.interactive.button_reply) {
          await handleButtonReply(phoneNumber, message.interactive.button_reply.id);
          logger.info("Button reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            buttonId: message.interactive.button_reply.id,
            durationMs: Date.now() - startTime,
          });
        } else if (message.interactive?.type === "list_reply" && message.interactive.list_reply) {
          await handleListReply(phoneNumber, message.interactive.list_reply.id);
          logger.info("List reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            listId: message.interactive.list_reply.id,
            durationMs: Date.now() - startTime,
          });
        }
        break;

      case "button":
        if (message.button?.payload) {
          await handleButtonReply(phoneNumber, message.button.payload);
          logger.info("Quick reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            payload: message.button.payload,
            durationMs: Date.now() - startTime,
          });
        }
        break;

      default:
        logger.info("Unhandled message type", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          type: message.type,
        });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Error handling message", {
      requestId,
      phoneNumber: phoneNumber.substring(0, 4) + "***",
      type: message.type,
      error: errorMessage,
      durationMs: Date.now() - startTime,
    });
  }
}

// ============================================================================
// API Handler
// ============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
