/**
 * Custom error classes and error handling utilities
 */

import { logger } from "../../_shared/logger.ts";

export class BotError extends Error {
  constructor(
    message: string,
    public userMessage: string,
    public code: string,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "BotError";
  }
}

export class ValidationError extends BotError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage, "VALIDATION_ERROR", false);
    this.name = "ValidationError";
  }
}

export class NetworkError extends BotError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage, "NETWORK_ERROR", true);
    this.name = "NetworkError";
  }
}

export class TimeoutError extends BotError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage, "TIMEOUT_ERROR", true);
    this.name = "TimeoutError";
  }
}

export class DatabaseError extends BotError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage, "DATABASE_ERROR", true);
    this.name = "DatabaseError";
  }
}

export class ExternalServiceError extends BotError {
  constructor(
    message: string,
    userMessage: string,
    public service: string,
  ) {
    super(message, userMessage, "EXTERNAL_SERVICE_ERROR", true);
    this.name = "ExternalServiceError";
  }
}

/**
 * Safe error logging that doesn't expose sensitive data
 */
export function logError(error: unknown, context: Record<string, unknown> = {}) {
  const sanitizedContext = { ...context };

  // Remove sensitive fields
  delete sanitizedContext.token;
  delete sanitizedContext.password;
  delete sanitizedContext.api_key;
  delete sanitizedContext.verification_code;

  logger.error(error instanceof Error ? error.message : String(error), {
    errorType: error instanceof Error ? error.name : "Unknown",
    stack: error instanceof Error ? error.stack : undefined,
    context: sanitizedContext,
  });
}

/**
 * Wrap async operations with comprehensive error handling
 */
export async function safeExecute<T>(
  operation: () => Promise<T>,
  context: string,
  fallback?: T,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    logError(error, { context });
    return fallback ?? null;
  }
}

/**
 * Retry configuration
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Default retry condition - only retry on retryable errors
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof BotError) {
    return error.retryable;
  }
  // Retry on network-like errors
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("econnreset") ||
      message.includes("socket") ||
      message.includes("fetch failed")
    );
  }
  return false;
}

/**
 * Wrap async operations with retry logic and exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = isRetryableError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or error is not retryable
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + Math.random() * 100, maxDelayMs);

      logger.warn("Retry attempt", {
        attempt: attempt + 1,
        maxRetries,
        error: error instanceof Error ? error.message : String(error),
        delayMs: Math.round(delay),
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
