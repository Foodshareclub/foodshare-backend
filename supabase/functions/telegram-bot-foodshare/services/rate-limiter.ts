/**
 * Telegram Bot Rate Limiter
 *
 * Thin wrapper around shared bot rate limiter factory.
 * Uses user_id (number) as the identifier.
 */

import { type BotRateLimitResult, createBotRateLimiter } from "../../_shared/bot/rate-limiter.ts";

const rateLimiter = createBotRateLimiter({
  tableName: "telegram_rate_limits",
  idColumn: "user_id",
});

export type RateLimitResult = BotRateLimitResult;

export function checkRateLimitDistributed(
  userId: number,
  maxRequests?: number,
  windowMs?: number,
): Promise<RateLimitResult> {
  return rateLimiter.checkDistributed(userId, maxRequests, windowMs);
}

export function checkRateLimit(
  userId: number,
  maxRequests?: number,
  windowMs?: number,
): boolean {
  return rateLimiter.checkSync(userId, maxRequests, windowMs);
}

export function getRemainingRequests(userId: number, maxRequests?: number): number {
  return rateLimiter.getRemaining(userId, maxRequests);
}

export function cleanupOldRateLimits(): Promise<number> {
  return rateLimiter.cleanup();
}
