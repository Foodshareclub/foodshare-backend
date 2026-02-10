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
 * - Unified createAPIHandler framework
 *
 * See README.md for architecture documentation.
 */

import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { isDevelopment } from "../_shared/utils.ts";
import { AppError } from "../_shared/errors.ts";
import { setWebhook, getTelegramApiStatus } from "./services/telegram-api.ts";
import { verifyTelegramWebhook as verifyTelegramSignature } from "../_shared/webhook-security.ts";
import { handleCallbackQuery } from "./handlers/callbacks.ts";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleLocationMessage,
  handleNewChatMembers,
} from "./handlers/messages.ts";
import { handleResendCode } from "./handlers/auth.ts";
import { BOT_USERNAME } from "./config/index.ts";
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

const VERSION = "3.5.0";
const SERVICE = "telegram-bot-foodshare";

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
  command?: string,
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

function verifyWebhookSignature(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    if (isDevelopment()) {
      logger.warn("TELEGRAM_WEBHOOK_SECRET not configured - skipping verification (dev mode)");
      return true;
    }
    logger.error("TELEGRAM_WEBHOOK_SECRET not configured - rejecting request in production");
    return false;
  }

  const result = verifyTelegramSignature(req.headers, WEBHOOK_SECRET);
  if (!result.valid) {
    logger.warn("Webhook signature verification failed", { error: result.error });
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

  if (!botToken) throw new Error("Missing BOT_TOKEN or TELEGRAM_BOT_TOKEN environment variable");
  if (!supabaseUrl) throw new Error("Missing SUPABASE_URL environment variable");
  if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable");

  isInitialized = true;
  logger.info("Telegram bot initialized successfully", { version: VERSION });
} catch (error) {
  initError = error instanceof Error ? error : new Error(String(error));
  logger.error("Initialization failed", { error: initError.message });
}

// ============================================================================
// JSON Response helper (always return 200 to Telegram)
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
    return jsonOk({ error: "Service temporarily unavailable", details: initError?.message }, ctx, 503);
  }

  const url = new URL(ctx.request.url);
  const pathname = url.pathname;

  // Webhook setup endpoint
  if (pathname.endsWith("/setup-webhook")) {
    const webhookUrl = url.searchParams.get("url");
    if (!webhookUrl) {
      return jsonOk({ error: "Missing webhook URL parameter" }, ctx, 400);
    }

    const success = await setWebhook(webhookUrl);
    logger.info("Webhook setup", { success, webhookUrl });
    return jsonOk({
      success,
      message: success ? "Webhook set successfully" : "Failed to set webhook",
    }, ctx, success ? 200 : 500);
  }

  // Metrics endpoint
  if (pathname.endsWith("/metrics")) {
    return jsonOk({
      ...getMetrics(),
      cache: getCacheStats(),
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  // Chat ID lookup endpoint
  if (pathname.endsWith("/chat-id")) {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || Deno.env.get("BOT_TOKEN");
    if (!botToken) {
      return jsonOk({ error: "Bot token not configured" }, ctx, 500);
    }

    try {
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?limit=10`,
      );
      const tgResult = await tgResponse.json();

      if (!tgResult.ok) {
        return jsonOk({ error: `Telegram API error: ${tgResult.description}` }, ctx, 502);
      }

      const chatIds = new Set<number>();
      const messages: { chat_id: number; chat_type: string; from: string; username: string; text: string; date: string }[] = [];

      for (const update of tgResult.result) {
        if (update.message) {
          const msg = update.message;
          chatIds.add(msg.chat.id);
          messages.push({
            chat_id: msg.chat.id,
            chat_type: msg.chat.type,
            from: msg.from.first_name + (msg.from.last_name ? " " + msg.from.last_name : ""),
            username: msg.from.username || "N/A",
            text: msg.text || "[media]",
            date: new Date(msg.date * 1000).toISOString(),
          });
        }
      }

      return jsonOk({
        success: true,
        instructions: "Send any message to your bot, then call this endpoint again to see your chat_id",
        unique_chat_ids: Array.from(chatIds),
        recent_messages: messages,
      }, ctx);
    } catch (error) {
      return jsonOk({ error: error instanceof Error ? error.message : String(error) }, ctx, 500);
    }
  }

  // Health check (default GET)
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

  return jsonOk({
    status: overallStatus,
    service: SERVICE,
    version: VERSION,
    timestamp: new Date().toISOString(),
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
  }, ctx, overallStatus === "healthy" ? 200 : 503);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const startTime = Date.now();

  if (!isInitialized) {
    return jsonOk({ error: "Service temporarily unavailable", details: initError?.message }, ctx, 503);
  }

  // Verify webhook signature for security
  if (!verifyWebhookSignature(ctx.request)) {
    logger.warn("Invalid webhook signature");
    // CRITICAL: Return 200 to Telegram to prevent retry storms
    return jsonOk({ ok: false, error: "Unauthorized" }, ctx);
  }

  let update: TelegramUpdate | undefined;

  try {
    update = ctx.body as TelegramUpdate;
    const userId = update!.message?.from?.id || update!.callback_query?.from?.id;

    // Distributed rate limiting
    if (userId) {
      const rateLimit = await checkRateLimitDistributed(userId);

      if (!rateLimit.allowed) {
        const latency = Date.now() - startTime;
        recordMetric("ratelimit", latency);
        logger.warn("Rate limit exceeded", { userId, retryAfter: rateLimit.retryAfterSeconds });
        // Return 200 to Telegram but include rate limit info
        return jsonOk({ ok: false, error: "Rate limit exceeded", retryAfter: rateLimit.retryAfterSeconds }, ctx);
      }
    }

    // Handle callback queries (inline button clicks)
    if (update!.callback_query) {
      await handleCallbackQuery(update!.callback_query);
      logger.info("Callback query handled", {
        userId,
        action: update!.callback_query.data,
        durationMs: Date.now() - startTime,
      });
      const latency = Date.now() - startTime;
      recordMetric("success", latency);
      return jsonOk({ ok: true }, ctx);
    }

    // Handle messages
    if (update!.message) {
      const message = update!.message;
      const chatId = message.chat.id;
      const msgUserId = message.from?.id;
      const text = message.text?.trim();
      const chatType = message.chat.type; // "private", "group", "supergroup", "channel"
      const isPrivateChat = chatType === "private";

      // In group chats, only respond to:
      // 1. New members joining (greeting)
      // 2. Bot being @mentioned
      // 3. Bot commands
      if (!isPrivateChat) {
        // Handle new members joining the group
        if (message.new_chat_members && message.new_chat_members.length > 0) {
          await handleNewChatMembers(chatId, message.new_chat_members);
          const latency = Date.now() - startTime;
          recordMetric("success", latency, "new_members");
          return jsonOk({ ok: true }, ctx);
        }

        // Check if bot is @mentioned in the message
        const isBotMentioned = text?.toLowerCase().includes(`@${BOT_USERNAME}`) ||
          message.entities?.some(
            (e) => e.type === "mention" && text?.substring(e.offset, e.offset + e.length).toLowerCase() === `@${BOT_USERNAME}`
          );

        // Skip if not a command and not a bot mention
        if (!text?.startsWith("/") && !isBotMentioned) {
          const latency = Date.now() - startTime;
          recordMetric("success", latency);
          return jsonOk({ ok: true }, ctx);
        }
      }

      // Handle commands
      if (text?.startsWith("/")) {
        const [command, ...args] = text.split(" ");
        const commandArg = args.join(" ");

        switch (command) {
          case "/start":
            if (msgUserId && message.from) {
              await handleStartCommand(chatId, msgUserId, message.from, message.from.language_code);
            }
            break;
          case "/help":
            await handleHelpCommand(chatId, message.from?.language_code);
            break;
          case "/share":
            if (msgUserId && message.from) {
              await handleShareCommand(chatId, msgUserId, message.from, message.from.language_code);
            }
            break;
          case "/find":
            await handleFindCommand(chatId, commandArg, message.from?.language_code);
            break;
          case "/nearby":
            if (msgUserId) await handleNearbyCommand(chatId, msgUserId);
            break;
          case "/profile":
            if (msgUserId) await handleProfileCommand(chatId, msgUserId);
            break;
          case "/impact":
            if (msgUserId) await handleImpactCommand(chatId, msgUserId);
            break;
          case "/stats":
            if (msgUserId) await handleStatsCommand(chatId, msgUserId, message.from?.language_code);
            break;
          case "/leaderboard":
            await handleLeaderboardCommand(chatId, message.from?.language_code);
            break;
          case "/language":
          case "/lang":
            if (msgUserId) await handleLanguageCommand(chatId, msgUserId);
            break;
          case "/resend":
            if (message.from) await handleResendCode(message.from, chatId);
            break;
          case "/cancel":
            await handleTextMessage(message);
            break;
          default:
            break;
        }

        logger.info("Command handled", {
          userId: msgUserId,
          command,
          durationMs: Date.now() - startTime,
        });
      } else if (message.location) {
        await handleLocationMessage(message);
      } else if (message.photo) {
        await handlePhotoMessage(message);
      } else if (text) {
        await handleTextMessage(message);
      }
    }

    const latency = Date.now() - startTime;
    recordMetric("success", latency);
    return jsonOk({ ok: true }, ctx);
  } catch (error) {
    const latency = Date.now() - startTime;
    recordMetric("error", latency);
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error("Error processing update", {
      error: errorMessage,
      updatePreview: update ? JSON.stringify(update).substring(0, 300) : "parse_failed",
      durationMs: latency,
    });

    // CRITICAL: Always return 200 to Telegram to prevent retry storms
    return jsonOk({ ok: false, error: errorMessage }, ctx);
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
    GET: { handler: handleGet, requireAuth: false },
    POST: { handler: handlePost, requireAuth: false },
  },
}));
