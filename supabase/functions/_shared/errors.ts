/**
 * Unified Error Handling
 *
 * Provides typed error classes and standardized error responses for:
 * - Consistent error format across all functions
 * - Error classification for observability
 * - Retryable error flagging for clients
 * - Proper HTTP status code mapping
 *
 * Error classes (AppError, ValidationError, etc.) are the canonical source.
 * Response building is handled by response-adapter.ts via the api-handler ok()/created() helpers.
 */

// =============================================================================
// Standardized Error Codes
// =============================================================================

/**
 * Canonical error code constants used across all Edge Functions.
 * Prefer these over string literals to prevent typos and enable refactoring.
 */
export const ERROR_CODES = {
  VALIDATION: "VALIDATION_ERROR",
  AUTH: "AUTHENTICATION_ERROR",
  AUTHORIZATION: "AUTHORIZATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMIT: "RATE_LIMIT_EXCEEDED",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
  EXTERNAL_SERVICE: "EXTERNAL_SERVICE_ERROR",
  TIMEOUT: "TIMEOUT",
  DATABASE: "DATABASE_ERROR",
  CONFIGURATION: "CONFIGURATION_ERROR",
  FORBIDDEN: "FORBIDDEN",
  SERVER: "SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  BAD_GATEWAY: "BAD_GATEWAY",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNPROCESSABLE: "UNPROCESSABLE_ENTITY",
  INTERNAL: "INTERNAL_ERROR",
  UNKNOWN: "UNKNOWN_ERROR",
} as const;

/**
 * Base application error with standard properties
 */
export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details?: unknown;
  public readonly timestamp: string;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    options?: {
      retryable?: boolean;
      details?: unknown;
      cause?: Error;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      retryable: this.retryable,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

/**
 * Validation error for invalid input
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_ERROR", 400, { details });
  }
}

/**
 * Authentication error - user not logged in
 */
export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, "AUTHENTICATION_ERROR", 401);
  }
}

/**
 * Authorization error - user lacks permission
 */
export class AuthorizationError extends AppError {
  constructor(message: string = "Access denied") {
    super(message, "AUTHORIZATION_ERROR", 403);
  }
}

/**
 * Resource not found error
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    super(message, "NOT_FOUND", 404, { details: { resource, id } });
  }
}

/**
 * Conflict error - resource already exists or state conflict
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "CONFLICT", 409, { details });
  }
}

/**
 * Rate limit exceeded error
 */
export class RateLimitError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(message: string = "Rate limit exceeded", retryAfterMs?: number) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, {
      retryable: true,
      details: { retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Circuit breaker open error
 */
export class CircuitOpenError extends AppError {
  constructor(service: string, retryAfterMs?: number) {
    super(
      `Service ${service} temporarily unavailable`,
      "CIRCUIT_OPEN",
      503,
      { retryable: true, details: { service, retryAfterMs } }
    );
  }
}

/**
 * External service error
 */
export class ExternalServiceError extends AppError {
  constructor(service: string, message: string, retryable: boolean = true) {
    super(
      `External service error (${service}): ${message}`,
      "EXTERNAL_SERVICE_ERROR",
      502,
      { retryable, details: { service } }
    );
  }
}

/**
 * Timeout error
 */
export class TimeoutError extends AppError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      504,
      { retryable: true, details: { operation, timeoutMs } }
    );
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "DATABASE_ERROR", 500, { retryable: true, details });
  }
}

/**
 * Configuration error - missing or invalid config
 */
export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR", 500);
  }
}

/**
 * Forbidden error - request understood but refused (alias for AuthorizationError)
 */
export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden", details?: unknown) {
    super(message, "FORBIDDEN", 403, { details });
  }
}

/**
 * Internal server error - generic 500 error
 */
export class ServerError extends AppError {
  constructor(message: string = "Internal server error", details?: unknown) {
    super(message, "SERVER_ERROR", 500, { details });
  }
}

/**
 * Service unavailable error - temporary unavailability
 */
export class ServiceUnavailableError extends AppError {
  public readonly retryAfterMs?: number;

  constructor(message: string = "Service temporarily unavailable", retryAfterMs?: number) {
    super(message, "SERVICE_UNAVAILABLE", 503, {
      retryable: true,
      details: { retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Bad gateway error - upstream service failure
 */
export class BadGatewayError extends AppError {
  constructor(message: string = "Bad gateway", upstream?: string) {
    super(message, "BAD_GATEWAY", 502, {
      retryable: true,
      details: { upstream },
    });
  }
}

/**
 * Payload too large error
 */
export class PayloadTooLargeError extends AppError {
  constructor(message: string = "Payload too large", maxSize?: number) {
    super(message, "PAYLOAD_TOO_LARGE", 413, {
      details: { maxSize },
    });
  }
}

/**
 * Unprocessable entity error - validation passed but business logic failed
 */
export class UnprocessableEntityError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "UNPROCESSABLE_ENTITY", 422, { details });
  }
}

/**
 * Assert a condition and throw ValidationError if false
 */
export function assertValid(
  condition: unknown,
  message: string,
  details?: unknown
): asserts condition {
  if (!condition) {
    throw new ValidationError(message, details);
  }
}

/**
 * Assert a value exists and throw NotFoundError if null/undefined
 */
export function assertFound<T>(
  value: T | null | undefined,
  resource: string,
  id?: string
): asserts value is T {
  if (value === null || value === undefined) {
    throw new NotFoundError(resource, id);
  }
}

/**
 * Assert user is authenticated
 */
export function assertAuthenticated(userId?: string | null): asserts userId is string {
  if (!userId) {
    throw new AuthenticationError();
  }
}

/**
 * Wrap an external service call with error transformation
 */
export async function withExternalService<T>(
  serviceName: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new ExternalServiceError(
      serviceName,
      error instanceof Error ? error.message : String(error)
    );
  }
}
