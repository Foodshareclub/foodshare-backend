/**
 * Telegram API service with circuit breaker protection
 */

import { logger } from "../../_shared/logger.ts";
import { TELEGRAM_API } from "../config/index.ts";
import {
  withCircuitBreaker,
  CircuitBreakerError,
  getCircuitStatus,
} from "../../_shared/circuit-breaker.ts";

const CIRCUIT_CONFIG = {
  failureThreshold: 5,
  resetTimeoutMs: 60000, // 1 minute
};

const FETCH_TIMEOUT = 10000; // 10 seconds

// When true, all sent messages are auto-scheduled for deletion after 5 min.
// Set via enableGroupAutoDelete / disableGroupAutoDelete around group message handling.
let _groupAutoDelete = false;
let _groupAutoDeleteChatId: number | null = null;

export function enableGroupAutoDelete(chatId: number): void {
  _groupAutoDelete = true;
  _groupAutoDeleteChatId = chatId;
}

export function disableGroupAutoDelete(): void {
  _groupAutoDelete = false;
  _groupAutoDeleteChatId = null;
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get Telegram API health status
 */
export function getTelegramApiStatus(): { status: string; failures: number } {
  const status = getCircuitStatus("telegram-api");
  return {
    status: status?.state || "CLOSED",
    failures: status?.failures || 0,
  };
}

export async function sendMessage(
  chatId: number,
  text: string,
  options: Record<string, unknown> = {}
): Promise<number | null> {
  try {
    return await withCircuitBreaker(
      "telegram-api",
      async () => {
        const response = await fetchWithTimeout(`${TELEGRAM_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: options.parse_mode || "HTML",
            ...options,
          }),
        });

        const result = await response.json();

        if (!result.ok) {
          logger.error("Telegram API error", { result });
          // Throw for circuit breaker to count failure
          if (response.status >= 500) {
            throw new Error(`Telegram API error: ${result.description}`);
          }
          return null;
        }

        const messageId = result.result?.message_id ?? null;

        // Auto-delete in group chats
        if (messageId && _groupAutoDelete) {
          scheduleGroupMessageDeletion(chatId, messageId);
        }

        return messageId;
      },
      CIRCUIT_CONFIG
    );
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Telegram API circuit breaker open, message not sent");
      return null;
    }
    logger.error("Send message error", { error: String(error) });
    return null;
  }
}

export async function sendPhoto(
  chatId: number,
  photo: string,
  caption?: string,
  options: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    return await withCircuitBreaker(
      "telegram-api",
      async () => {
        const response = await fetchWithTimeout(`${TELEGRAM_API}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            photo,
            caption,
            parse_mode: "HTML",
            ...options,
          }),
        });

        const result = await response.json();

        if (!result.ok && response.status >= 500) {
          throw new Error(`Telegram API error: ${result.description}`);
        }

        return result.ok;
      },
      CIRCUIT_CONFIG
    );
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Telegram API circuit breaker open, photo not sent");
      return false;
    }
    logger.error("Send photo error", { error: String(error) });
    return false;
  }
}

export async function sendLocation(
  chatId: number,
  latitude: number,
  longitude: number
): Promise<boolean> {
  try {
    return await withCircuitBreaker(
      "telegram-api",
      async () => {
        const response = await fetchWithTimeout(`${TELEGRAM_API}/sendLocation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            latitude,
            longitude,
          }),
        });

        const result = await response.json();

        if (!result.ok && response.status >= 500) {
          throw new Error(`Telegram API error: ${result.description}`);
        }

        return result.ok;
      },
      CIRCUIT_CONFIG
    );
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Telegram API circuit breaker open, location not sent");
      return false;
    }
    logger.error("Send location error", { error: String(error) });
    return false;
  }
}

export async function setWebhook(url: string): Promise<boolean> {
  try {
    // Include secret_token for webhook signature verification
    const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

    const webhookConfig: Record<string, unknown> = {
      url,
      allowed_updates: ["message", "callback_query"],
    };

    // Add secret_token if configured
    if (webhookSecret) {
      webhookConfig.secret_token = webhookSecret;
    }

    const response = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookConfig),
    });

    const result = await response.json();

    if (result.ok) {
      logger.info("Webhook configured successfully", { hasSecretToken: !!webhookSecret });
    }

    return result.ok;
  } catch (error) {
    logger.error("Set webhook error", { error: String(error) });
    return false;
  }
}

export async function deleteMessage(chatId: number, messageId: number): Promise<boolean> {
  try {
    return await withCircuitBreaker(
      "telegram-api",
      async () => {
        const response = await fetchWithTimeout(`${TELEGRAM_API}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
          }),
        });

        const result = await response.json();

        if (!result.ok && response.status >= 500) {
          throw new Error(`Telegram API error: ${result.description}`);
        }

        return result.ok;
      },
      CIRCUIT_CONFIG
    );
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Telegram API circuit breaker open, message not deleted");
      return false;
    }
    logger.error("Delete message error", { error: String(error), chatId, messageId });
    return false;
  }
}

const AUTO_DELETE_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Schedule a bot message for auto-deletion in group chats after 5 minutes.
 * Fire-and-forget — failures are logged but don't propagate.
 */
export function scheduleGroupMessageDeletion(chatId: number, messageId: number): void {
  setTimeout(async () => {
    const ok = await deleteMessage(chatId, messageId);
    if (ok) {
      logger.info("Auto-deleted group message", { chatId, messageId });
    }
  }, AUTO_DELETE_DELAY_MS);
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<boolean> {
  try {
    return await withCircuitBreaker(
      "telegram-api",
      async () => {
        const response = await fetchWithTimeout(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text,
          }),
        });

        const result = await response.json();

        if (!result.ok && response.status >= 500) {
          throw new Error(`Telegram API error: ${result.description}`);
        }

        return result.ok;
      },
      CIRCUIT_CONFIG
    );
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Telegram API circuit breaker open, callback not answered");
      return false;
    }
    logger.error("Answer callback query error", { error: String(error) });
    return false;
  }
}
