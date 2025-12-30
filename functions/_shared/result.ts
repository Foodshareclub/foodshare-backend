/**
 * Type-Safe Result Pattern
 *
 * Implements Railway-Oriented Programming for error handling.
 * Replaces try/catch with compile-time error checking.
 *
 * @module
 */

// =============================================================================
// Core Types
// =============================================================================

/** Success result */
export interface Ok<T> {
  readonly _tag: "Ok";
  readonly value: T;
}

/** Error result */
export interface Err<E> {
  readonly _tag: "Err";
  readonly error: E;
}

/** Discriminated union of Ok or Err */
export type Result<T, E = Error> = Ok<T> | Err<E>;

// =============================================================================
// Constructors
// =============================================================================

/** Create a success result */
export const ok = <T>(value: T): Ok<T> => ({ _tag: "Ok", value });

/** Create an error result */
export const err = <E>(error: E): Err<E> => ({ _tag: "Err", error });

// =============================================================================
// Type Guards
// =============================================================================

/** Check if result is Ok */
export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> =>
  result._tag === "Ok";

/** Check if result is Err */
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> =>
  result._tag === "Err";

// =============================================================================
// Transformations
// =============================================================================

/** Transform the success value */
export const map = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> => (isOk(result) ? ok(fn(result.value)) : result);

/** Transform the error value */
export const mapErr = <T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> => (isErr(result) ? err(fn(result.error)) : result);

/** Chain results (flatMap) */
export const flatMap = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> => (isOk(result) ? fn(result.value) : result);

/** Alias for flatMap */
export const andThen = flatMap;

// =============================================================================
// Extraction
// =============================================================================

/** Get value or throw error */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (isOk(result)) return result.value;
  throw result.error;
};

/** Get value or return default */
export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T =>
  isOk(result) ? result.value : defaultValue;

/** Get value or compute default */
export const unwrapOrElse = <T, E>(
  result: Result<T, E>,
  fn: (error: E) => T
): T => (isOk(result) ? result.value : fn(result.error));

/** Match on result */
export const match = <T, E, U>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => U; err: (error: E) => U }
): U => (isOk(result) ? handlers.ok(result.value) : handlers.err(result.error));

// =============================================================================
// Async Support
// =============================================================================

/** Async result type */
export type AsyncResult<T, E = Error> = Promise<Result<T, E>>;

/** Wrap a promise into a Result */
export const fromPromise = async <T, E = Error>(
  promise: Promise<T>,
  mapError: (e: unknown) => E = (e) => e as E
): AsyncResult<T, E> => {
  try {
    return ok(await promise);
  } catch (e) {
    return err(mapError(e));
  }
};

/** Wrap a throwing function into a Result */
export const tryCatch = <T, E = Error>(
  fn: () => T,
  mapError: (e: unknown) => E = (e) => e as E
): Result<T, E> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(mapError(e));
  }
};

/** Async tryCatch */
export const tryCatchAsync = async <T, E = Error>(
  fn: () => Promise<T>,
  mapError: (e: unknown) => E = (e) => e as E
): AsyncResult<T, E> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(mapError(e));
  }
};

// =============================================================================
// Combining Results
// =============================================================================

/** Combine multiple results into one */
export const all = <T extends readonly Result<unknown, unknown>[]>(
  results: T
): Result<
  { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
  T[number] extends Result<unknown, infer E> ? E : never
> => {
  const values: unknown[] = [];

  for (const result of results) {
    if (isErr(result)) return result as Err<never>;
    values.push(result.value);
  }

  return ok(values as never);
};

/** Return first Ok result, or last Err */
export const any = <T, E>(results: Result<T, E>[]): Result<T, E> => {
  let lastErr: Err<E> | null = null;

  for (const result of results) {
    if (isOk(result)) return result;
    lastErr = result;
  }

  return lastErr ?? err(new Error("No results") as E);
};

// =============================================================================
// Domain Error Types
// =============================================================================

/** Base error with code and context */
export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly cause?: Error;
}

/** Create a domain error */
export const domainError = (
  code: string,
  message: string,
  context?: Record<string, unknown>,
  cause?: Error
): DomainError => ({ code, message, context, cause });

// Common error factories
export const validationError = (message: string, fields?: Record<string, string>) =>
  domainError("VALIDATION_ERROR", message, { fields });

export const notFoundError = (resource: string, id?: string) =>
  domainError("NOT_FOUND", `${resource} not found`, { resource, id });

export const authError = (message = "Authentication required") =>
  domainError("AUTH_ERROR", message);

export const forbiddenError = (message = "Access denied") =>
  domainError("FORBIDDEN", message);

export const rateLimitError = (retryAfterMs: number) =>
  domainError("RATE_LIMITED", "Rate limit exceeded", { retryAfterMs });

export const serverError = (message: string, cause?: Error) =>
  domainError("SERVER_ERROR", message, undefined, cause);
