/**
 * WhatsApp Bot FoodShare - Main Entry Point
 *
 * Enterprise-ready with:
 * - Webhook verification (GET with hub.challenge)
 * - Distributed rate limiting
 * - Request correlation IDs
 * - Structured JSON logging
 * - Health checks
 */

import { WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET } from "./config/index.ts";
import { verifyMetaWebhook, handleMetaWebhookChallenge } from "../_shared/webhook-security.ts";
import { checkRateLimitDistributed } from "./services/rate-limiter.ts";
import { cleanupExpiredStates } from "./services/user-state.ts";
import { getWhatsAppApiStatus, markAsRead } from "./services/whatsapp-api.ts";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleLocationMessage,
} from "./handlers/messages.ts";
import { handleButtonReply, handleListReply } from "./handlers/interactive.ts";
import type { WhatsAppWebhookPayload, WhatsAppMessage } from "./types/index.ts";

const VERSION = "1.0.0";

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
  console.log(
    JSON.stringify({
      level: "info",
      message: "WhatsApp bot initialized successfully",
      version: VERSION,
      timestamp: new Date().toISOString(),
    })
  );
} catch (error) {
  initError = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      level: "error",
      message: "Initialization failed",
      error: initError.message,
      timestamp: new Date().toISOString(),
    })
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateRequestId(): string {
  return crypto.randomUUID();
}

function log(level: string, message: string, context: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level,
      message,
      ...context,
      timestamp: new Date().toISOString(),
    })
  );
}

/**
 * Check if we're running in development/local environment
 */
function isDevelopment(): boolean {
  const env = Deno.env.get("DENO_ENV") || Deno.env.get("ENVIRONMENT") || "";
  return env === "development" || env === "local" || env === "test";
}

/**
 * Verify WhatsApp webhook signature using shared webhook-security module
 * SECURITY: Rejects requests in production if secret is not configured
 */
async function verifyWebhookSignature(payload: string, headers: Headers): Promise<boolean> {
  // If no app secret configured, behavior depends on environment
  if (!WHATSAPP_APP_SECRET) {
    if (isDevelopment()) {
      log("warn", "WHATSAPP_APP_SECRET not configured - skipping signature verification (dev mode)");
      return true;
    }
    // SECURITY: In production, reject requests if secret is not configured
    log("error", "WHATSAPP_APP_SECRET not configured - rejecting request in production");
    return false;
  }

  const result = await verifyMetaWebhook(payload, headers, WHATSAPP_APP_SECRET);
  if (!result.valid) {
    log("warn", "Webhook signature verification failed", { error: result.error });
  }
  return result.valid;
}

// ============================================================================
// Main Request Handler
// ============================================================================

Deno.serve(async (req) => {
  const requestId = generateRequestId();
  const startTime = Date.now();
  const url = new URL(req.url);

  // Check initialization status
  if (!isInitialized) {
    log("error", "Function not initialized", { requestId, error: initError?.message });
    return new Response(
      JSON.stringify({
        error: "Service temporarily unavailable",
        details: initError?.message,
        requestId,
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      }
    );
  }

  // ============================================================================
  // Webhook Verification (GET request from Meta)
  // ============================================================================
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    // Webhook verification request
    if (mode === "subscribe" && token && challenge) {
      if (token === WHATSAPP_VERIFY_TOKEN) {
        log("info", "Webhook verified successfully", { requestId });
        return new Response(challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain", "X-Request-ID": requestId },
        });
      } else {
        log("warn", "Webhook verification failed - invalid token", { requestId });
        return new Response("Forbidden", {
          status: 403,
          headers: { "X-Request-ID": requestId },
        });
      }
    }

    // Health check endpoint
    let cleanedStates = 0;
    try {
      cleanedStates = await cleanupExpiredStates();
    } catch {
      // Ignore cleanup errors in health check
    }

    const whatsappStatus = getWhatsAppApiStatus();
    const overallStatus = whatsappStatus.status === "OPEN" ? "degraded" : "healthy";

    return new Response(
      JSON.stringify({
        status: overallStatus,
        service: "whatsapp-bot-foodshare",
        version: VERSION,
        timestamp: new Date().toISOString(),
        requestId,
        dependencies: {
          whatsapp: {
            status: whatsappStatus.status,
            failures: whatsappStatus.failures,
          },
        },
        maintenance: {
          expiredStatesCleaned: cleanedStates,
        },
      }),
      {
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        status: overallStatus === "healthy" ? 200 : 503,
      }
    );
  }

  // ============================================================================
  // Webhook Message Handler (POST request)
  // ============================================================================
  if (req.method === "POST") {
    let payload: WhatsAppWebhookPayload | undefined;

    try {
      // Read raw body for signature verification
      const rawBody = await req.text();

      // Verify webhook signature using shared webhook-security module
      const isValidSignature = await verifyWebhookSignature(rawBody, req.headers);

      if (!isValidSignature) {
        log("warn", "Invalid webhook signature", { requestId });
        return new Response(JSON.stringify({ error: "Invalid signature", requestId }), {
          status: 401,
          headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        });
      }

      payload = JSON.parse(rawBody);

      // Validate payload structure
      if (payload?.object !== "whatsapp_business_account") {
        return new Response(JSON.stringify({ ok: true, requestId }), {
          headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        });
      }

      // Process each entry
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          // Skip if no messages
          if (!value.messages || value.messages.length === 0) {
            continue;
          }

          for (const message of value.messages) {
            const phoneNumber = message.from;

            // Rate limiting
            const rateLimit = await checkRateLimitDistributed(phoneNumber);

            if (!rateLimit.allowed) {
              log("warn", "Rate limit exceeded", {
                requestId,
                phoneNumber: phoneNumber.substring(0, 4) + "***",
                retryAfter: rateLimit.retryAfterSeconds,
              });
              continue; // Skip this message but don't fail the webhook
            }

            // Mark message as read
            await markAsRead(message.id);

            // Route message to appropriate handler
            await routeMessage(message, requestId, startTime);
          }
        }
      }

      return new Response(JSON.stringify({ ok: true, requestId }), {
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log("error", "Error processing webhook", {
        requestId,
        error: errorMessage,
        stack: errorStack,
        durationMs: Date.now() - startTime,
      });

      // Always return 200 to WhatsApp to prevent retries
      return new Response(
        JSON.stringify({
          ok: false,
          error: errorMessage,
          requestId,
        }),
        {
          status: 200, // WhatsApp expects 200 even on errors
          headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        }
      );
    }
  }

  // Method not allowed
  return new Response(JSON.stringify({ error: "Method not allowed", requestId }), {
    status: 405,
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
  });
});

// ============================================================================
// Message Router
// ============================================================================

async function routeMessage(
  message: WhatsAppMessage,
  requestId: string,
  startTime: number
): Promise<void> {
  const phoneNumber = message.from;

  try {
    switch (message.type) {
      case "text":
        await handleTextMessage(message);
        log("info", "Text message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "image":
        await handlePhotoMessage(message);
        log("info", "Image message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "location":
        await handleLocationMessage(message);
        log("info", "Location message handled", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          durationMs: Date.now() - startTime,
        });
        break;

      case "interactive":
        if (message.interactive?.type === "button_reply" && message.interactive.button_reply) {
          await handleButtonReply(phoneNumber, message.interactive.button_reply.id);
          log("info", "Button reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            buttonId: message.interactive.button_reply.id,
            durationMs: Date.now() - startTime,
          });
        } else if (message.interactive?.type === "list_reply" && message.interactive.list_reply) {
          await handleListReply(phoneNumber, message.interactive.list_reply.id);
          log("info", "List reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            listId: message.interactive.list_reply.id,
            durationMs: Date.now() - startTime,
          });
        }
        break;

      case "button":
        // Quick reply button (different from interactive)
        if (message.button?.payload) {
          await handleButtonReply(phoneNumber, message.button.payload);
          log("info", "Quick reply handled", {
            requestId,
            phoneNumber: phoneNumber.substring(0, 4) + "***",
            payload: message.button.payload,
            durationMs: Date.now() - startTime,
          });
        }
        break;

      default:
        log("info", "Unhandled message type", {
          requestId,
          phoneNumber: phoneNumber.substring(0, 4) + "***",
          type: message.type,
        });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("error", "Error handling message", {
      requestId,
      phoneNumber: phoneNumber.substring(0, 4) + "***",
      type: message.type,
      error: errorMessage,
      durationMs: Date.now() - startTime,
    });
  }
}
