/**
 * WhatsApp Bot Rate Limiter
 *
 * Thin wrapper around shared bot rate limiter factory.
 * Uses phone_number (string) as the identifier.
 */

import {
  type BotRateLimitResult,
  createBotRateLimiter,
} from "../../_shared/bot/rate-limiter.ts";

const rateLimiter = createBotRateLimiter({
  tableName: "whatsapp_rate_limits",
  idColumn: "phone_number",
});

export type RateLimitResult = BotRateLimitResult;

export function checkRateLimitDistributed(
  phoneNumber: string,
  maxRequests?: number,
  windowMs?: number,
): Promise<RateLimitResult> {
  return rateLimiter.checkDistributed(phoneNumber, maxRequests, windowMs);
}

export function checkRateLimit(
  phoneNumber: string,
  maxRequests?: number,
  windowMs?: number,
): boolean {
  return rateLimiter.checkSync(phoneNumber, maxRequests, windowMs);
}

export function getRemainingRequests(phoneNumber: string, maxRequests?: number): number {
  return rateLimiter.getRemaining(phoneNumber, maxRequests);
}

export function cleanupOldRateLimits(): Promise<number> {
  return rateLimiter.cleanup();
}
