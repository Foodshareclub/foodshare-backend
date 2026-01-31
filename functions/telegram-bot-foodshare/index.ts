/**
 * Telegram Bot FoodShare - Main Entry Point
 *
 * Enterprise-ready with:
 * - Webhook signature verification for security
 * - Distributed rate limiting with proper 429 responses
 * - Request correlation IDs for debugging
 * - Structured JSON logging with metrics
 * - Enhanced health checks
 * - Automatic state cleanup
 *
 * See README.md for architecture documentation.
 */

import { setWebhook, getTelegramApiStatus } from "./services/telegram-api.ts";
import { verifyTelegramWebhook as verifyTelegramSignature } from "../_shared/webhook-security.ts";
import { handleCallbackQuery } from "./handlers/callbacks.ts";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleLocationMessage,
} from "./handlers/messages.ts";
import { handleResendCode } from "./handlers/auth.ts";
import {
  handleStartCommand,
  handleHelpCommand,
  handleShareCommand,
  handleFindCommand,
  handleNearbyCommand,
  handleProfileCommand,
  handleImpactCommand,
  handleStatsCommand,
  handleLeaderboardCommand,
  handleLanguageCommand,
} from "./handlers/commands.ts";
import { checkRateLimitDistributed } from "./services/rate-limiter.ts";
import { cleanupExpiredStates } from "./services/user-state.ts";
import { cleanupExpiredCache, getCacheStats } from "./services/cache.ts";
import type { TelegramUpdate } from "./types/index.ts";

const VERSION = "3.4.0";

// Webhook secret for verifying requests from Telegram
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

// ============================================================================
// Metrics Collection
// ============================================================================

interface Metrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsError: number;
  requests429: number;
  latencySum: number;
  latencyCount: number;
  commandCounts: Record<string, number>;
  lastReset: Date;
}

const metrics: Metrics = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsError: 0,
  requests429: 0,
  latencySum: 0,
  latencyCount: 0,
  commandCounts: {},
  lastReset: new Date(),
};

function recordMetric(
  type: "success" | "error" | "ratelimit",
  latencyMs: number,
  command?: string
): void {
  metrics.requestsTotal++;
  metrics.latencySum += latencyMs;
  metrics.latencyCount++;

  if (type === "success") metrics.requestsSuccess++;
  else if (type === "error") metrics.requestsError++;
  else if (type === "ratelimit") metrics.requests429++;

  if (command) {
    metrics.commandCounts[command] = (metrics.commandCounts[command] || 0) + 1;
  }
}

function getMetrics(): Record<string, unknown> {
  const avgLatency = metrics.latencyCount > 0 ? metrics.latencySum / metrics.latencyCount : 0;
  return {
    requestsTotal: metrics.requestsTotal,
    requestsSuccess: metrics.requestsSuccess,
    requestsError: metrics.requestsError,
    requests429: metrics.requests429,
    avgLatencyMs: Math.round(avgLatency * 100) / 100,
    commandCounts: metrics.commandCounts,
    uptime: Date.now() - metrics.lastReset.getTime(),
  };
}

// ============================================================================
// Security: Webhook Signature Verification
// ============================================================================

/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }

  return result === 0;
}

/**
 * Check if we're running in development/local environment
 */
function isDevelopment(): boolean {
  const env = Deno.env.get("DENO_ENV") || Deno.env.get("ENVIRONMENT") || "";
  return env === "development" || env === "local" || env === "test";
}

/**
 * Verify Telegram webhook signature using shared webhook-security module
 * SECURITY: Rejects requests in production if secret is not configured
 */
function verifyWebhookSignature(req: Request): boolean {
  // If no secret configured, behavior depends on environment
  if (!WEBHOOK_SECRET) {
    if (isDevelopment()) {
      log("warn", "TELEGRAM_WEBHOOK_SECRET not configured - skipping verification (dev mode)");
      return true;
    }
    // SECURITY: In production, reject requests if secret is not configured
    log("error", "TELEGRAM_WEBHOOK_SECRET not configured - rejecting request in production");
    return false;
  }

  // Use shared webhook-security module for verification
  const result = verifyTelegramSignature(req.headers, WEBHOOK_SECRET);
  if (!result.valid) {
    log("warn", "Webhook signature verification failed", { error: result.error });
  }
  return result.valid;
}

// ============================================================================
// Initialization Check
// ============================================================================

let isInitialized = false;
let initError: Error | null = null;

try {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || Deno.env.get("BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!botToken) {
    throw new Error("Missing BOT_TOKEN or TELEGRAM_BOT_TOKEN environment variable");
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
      message: "Telegram bot initialized successfully",
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

// ============================================================================
// Main Request Handler
// ============================================================================

Deno.serve(async (req) => {
  const requestId = generateRequestId();
  const startTime = Date.now();

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

  const url = new URL(req.url);
  const pathname = url.pathname;

  // Webhook setup endpoint
  if (pathname.endsWith("/setup-webhook")) {
    const webhookUrl = url.searchParams.get("url");
    if (!webhookUrl) {
      return new Response(JSON.stringify({ error: "Missing webhook URL parameter", requestId }), {
        status: 400,
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      });
    }

    const success = await setWebhook(webhookUrl);
    log(success ? "info" : "error", "Webhook setup", { requestId, success, webhookUrl });

    return new Response(
      JSON.stringify({
        success,
        message: success ? "Webhook set successfully" : "Failed to set webhook",
        requestId,
      }),
      {
        status: success ? 200 : 500,
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      }
    );
  }

  // Metrics endpoint
  if (pathname === "/metrics" || pathname.endsWith("/metrics")) {
    return new Response(
      JSON.stringify({
        ...getMetrics(),
        cache: getCacheStats(),
        timestamp: new Date().toISOString(),
        requestId,
      }),
      {
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      }
    );
  }

  // Enhanced health check endpoint
  if (pathname === "/health" || pathname.endsWith("/health") || req.method === "GET") {
    // Cleanup expired states and cache on health check
    let cleanedStates = 0;
    let cleanedCache = 0;
    try {
      cleanedStates = await cleanupExpiredStates();
      cleanedCache = cleanupExpiredCache();
    } catch {
      // Ignore cleanup errors in health check
    }

    const telegramStatus = getTelegramApiStatus();
    const overallStatus = telegramStatus.status === "OPEN" ? "degraded" : "healthy";

    return new Response(
      JSON.stringify({
        status: overallStatus,
        service: "telegram-bot-foodshare",
        version: VERSION,
        timestamp: new Date().toISOString(),
        requestId,
        dependencies: {
          telegram: {
            status: telegramStatus.status,
            failures: telegramStatus.failures,
          },
        },
        maintenance: {
          expiredStatesCleaned: cleanedStates,
          expiredCacheCleaned: cleanedCache,
        },
        metrics: getMetrics(),
      }),
      {
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        status: overallStatus === "healthy" ? 200 : 503,
      }
    );
  }

  // Handle Telegram webhook updates
  if (req.method === "POST") {
    // Verify webhook signature for security
    if (!verifyWebhookSignature(req)) {
      log("warn", "Invalid webhook signature", { requestId });
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized", requestId }), {
        status: 401,
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      });
    }

    let update: TelegramUpdate | undefined;

    try {
      update = await req.json();
      const userId = update.message?.from?.id || update.callback_query?.from?.id;

      // Distributed rate limiting with proper 429 response
      if (userId) {
        const rateLimit = await checkRateLimitDistributed(userId);

        if (!rateLimit.allowed) {
          const latency = Date.now() - startTime;
          recordMetric("ratelimit", latency);
          log("warn", "Rate limit exceeded", {
            requestId,
            userId,
            retryAfter: rateLimit.retryAfterSeconds,
          });

          return new Response(
            JSON.stringify({
              ok: false,
              error: "Rate limit exceeded",
              retryAfter: rateLimit.retryAfterSeconds,
              requestId,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "X-Request-ID": requestId,
                "Retry-After": String(rateLimit.retryAfterSeconds || 60),
                "X-RateLimit-Remaining": String(rateLimit.remaining),
                "X-RateLimit-Reset": rateLimit.resetAt.toISOString(),
              },
            }
          );
        }
      }

      // Handle callback queries (inline button clicks)
      if (update.callback_query) {
        await handleCallbackQuery(update.callback_query);
        log("info", "Callback query handled", {
          requestId,
          userId,
          action: update.callback_query.data,
          durationMs: Date.now() - startTime,
        });
        return new Response(JSON.stringify({ ok: true, requestId }), {
          headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
        });
      }

      // Handle messages
      if (update.message) {
        const message = update.message;
        const chatId = message.chat.id;
        const msgUserId = message.from?.id;
        const text = message.text?.trim();

        // Handle commands
        if (text?.startsWith("/")) {
          const [command, ...args] = text.split(" ");
          const commandArg = args.join(" ");

          switch (command) {
            case "/start":
              if (msgUserId && message.from) {
                await handleStartCommand(
                  chatId,
                  msgUserId,
                  message.from,
                  message.from.language_code
                );
              }
              break;

            case "/help":
              await handleHelpCommand(chatId, message.from?.language_code);
              break;

            case "/share":
              if (msgUserId && message.from) {
                await handleShareCommand(
                  chatId,
                  msgUserId,
                  message.from,
                  message.from.language_code
                );
              }
              break;

            case "/find":
              await handleFindCommand(chatId, commandArg, message.from?.language_code);
              break;

            case "/nearby":
              if (msgUserId) {
                await handleNearbyCommand(chatId, msgUserId);
              }
              break;

            case "/profile":
              if (msgUserId) {
                await handleProfileCommand(chatId, msgUserId);
              }
              break;

            case "/impact":
              if (msgUserId) {
                await handleImpactCommand(chatId, msgUserId);
              }
              break;

            case "/stats":
              if (msgUserId) {
                await handleStatsCommand(chatId, msgUserId, message.from?.language_code);
              }
              break;

            case "/leaderboard":
              await handleLeaderboardCommand(chatId, message.from?.language_code);
              break;

            case "/language":
            case "/lang":
              if (msgUserId) {
                await handleLanguageCommand(chatId, msgUserId);
              }
              break;

            case "/resend":
              if (message.from) {
                await handleResendCode(message.from, chatId);
              }
              break;

            case "/cancel":
              await handleTextMessage(message);
              break;

            default:
              // Unknown command - ignore
              break;
          }

          log("info", "Command handled", {
            requestId,
            userId: msgUserId,
            command,
            durationMs: Date.now() - startTime,
          });
        }
        // Handle location messages
        else if (message.location) {
          await handleLocationMessage(message);
          log("info", "Location message handled", {
            requestId,
            userId: msgUserId,
            durationMs: Date.now() - startTime,
          });
        }
        // Handle photo messages
        else if (message.photo) {
          await handlePhotoMessage(message);
          log("info", "Photo message handled", {
            requestId,
            userId: msgUserId,
            durationMs: Date.now() - startTime,
          });
        }
        // Handle text messages
        else if (text) {
          await handleTextMessage(message);
          log("info", "Text message handled", {
            requestId,
            userId: msgUserId,
            durationMs: Date.now() - startTime,
          });
        }
      }

      const latency = Date.now() - startTime;
      recordMetric("success", latency);
      return new Response(JSON.stringify({ ok: true, requestId }), {
        headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
      });
    } catch (error) {
      const latency = Date.now() - startTime;
      recordMetric("error", latency);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log("error", "Error processing update", {
        requestId,
        error: errorMessage,
        stack: errorStack,
        updatePreview: update ? JSON.stringify(update).substring(0, 300) : "parse_failed",
        durationMs: latency,
      });

      return new Response(
        JSON.stringify({
          ok: false,
          error: errorMessage,
          requestId,
        }),
        {
          status: 500,
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
