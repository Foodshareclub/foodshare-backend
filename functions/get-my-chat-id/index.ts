/**
 * Get My Chat ID Edge Function
 *
 * Telegram bot utility to retrieve chat IDs from recent messages.
 * Helps users find their chat_id for notification setup.
 *
 * Usage:
 * GET /get-my-chat-id
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError } from "../_shared/errors.ts";

// =============================================================================
// Response Types
// =============================================================================

interface ChatMessage {
  chat_id: number;
  chat_type: string;
  from: string;
  username: string;
  text: string;
  date: string;
}

interface ChatIdResponse {
  success: boolean;
  instructions: string;
  unique_chat_ids: number[];
  recent_messages: ChatMessage[];
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetChatId(ctx: HandlerContext): Promise<Response> {
  const { ctx: requestCtx } = ctx;

  const botToken = Deno.env.get("BOT_TOKEN");
  if (!botToken) {
    logger.error("Missing BOT_TOKEN");
    throw new ServerError("Bot token not configured");
  }

  logger.info("Fetching Telegram updates", {
    requestId: requestCtx?.requestId,
  });

  // Get recent updates from Telegram
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/getUpdates?limit=10`,
    { method: "GET" }
  );

  const result = await response.json();

  if (!result.ok) {
    logger.error("Telegram API error", { error: result.description });
    throw new ServerError(`Failed to get updates: ${result.description}`);
  }

  // Extract unique chat IDs and messages
  const chatIds = new Set<number>();
  const messages: ChatMessage[] = [];

  for (const update of result.result) {
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

  logger.info("Retrieved chat IDs", {
    count: chatIds.size,
    requestId: requestCtx?.requestId,
  });

  const responseData: ChatIdResponse = {
    success: true,
    instructions: "Send any message to your bot, then call this function again to see your chat_id",
    unique_chat_ids: Array.from(chatIds),
    recent_messages: messages,
  };

  return ok(responseData, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "get-my-chat-id",
  version: "2.0.0",
  requireAuth: false, // Utility endpoint
  routes: {
    GET: {
      handler: handleGetChatId,
    },
  },
});
