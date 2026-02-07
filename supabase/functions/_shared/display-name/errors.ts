/**
 * Display Name Service Errors
 *
 * Typed error classes for display name operations.
 */

import { AppError } from "../errors.ts";

/**
 * Error when user is not found
 */
export class UserNotFoundError extends AppError {
  constructor(userId: string) {
    super(`User not found: ${userId}`, "USER_NOT_FOUND", 404, {
      details: { userId },
    });
  }
}

/**
 * Error when batch size exceeds limit
 */
export class BatchSizeExceededError extends AppError {
  constructor(requested: number, max: number) {
    super(
      `Batch size ${requested} exceeds maximum of ${max}`,
      "BATCH_SIZE_EXCEEDED",
      400,
      { details: { requested, max } }
    );
  }
}

/**
 * Error when override already exists
 */
export class OverrideExistsError extends AppError {
  constructor(userId: string) {
    super(
      `Display name override already exists for user: ${userId}`,
      "OVERRIDE_EXISTS",
      409,
      { details: { userId } }
    );
  }
}

/**
 * Error when override is not found
 */
export class OverrideNotFoundError extends AppError {
  constructor(userId: string) {
    super(
      `No display name override found for user: ${userId}`,
      "OVERRIDE_NOT_FOUND",
      404,
      { details: { userId } }
    );
  }
}

/**
 * Error when display name is invalid
 */
export class InvalidDisplayNameError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "INVALID_DISPLAY_NAME", 400, { details });
  }
}

/**
 * Error when service is unavailable
 */
export class DisplayNameServiceUnavailableError extends AppError {
  constructor(reason: string) {
    super(
      `Display name service unavailable: ${reason}`,
      "SERVICE_UNAVAILABLE",
      503,
      { retryable: true }
    );
  }
}
