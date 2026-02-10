/**
 * Timeout Utilities
 *
 * Provides timeout wrappers for operations with:
 * - Configurable timeouts per operation type
 * - Proper cleanup via AbortController
 * - Integration with error handling
 */

import { TimeoutError } from "./errors.ts";

/**
 * Default timeouts for different operation types (in milliseconds)
 */
export const TIMEOUT_DEFAULTS = {
  /** Database queries */
  database: 10000,
  /** External API calls */
  externalApi: 30000,
  /** Storage operations (file uploads/downloads) */
  storage: 60000,
  /** Push notification sending */
  push: 15000,
  /** Email sending */
  email: 20000,
  /** Geocoding/location services */
  geocoding: 10000,
  /** Authentication/verification */
  auth: 5000,
  /** Health checks */
  health: 5000,
  /** Quick operations */
  quick: 3000,
} as const;

export type TimeoutType = keyof typeof TIMEOUT_DEFAULTS;

/**
 * Execute a promise with a timeout
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   TIMEOUT_DEFAULTS.externalApi,
 *   "API request"
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string = "Operation"
): Promise<T> {
  let timeoutId: number | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Execute a promise with a timeout using abort signal
 * Use this when the operation supports AbortController
 *
 * @example
 * ```typescript
 * const result = await withAbortableTimeout(
 *   (signal) => fetch(url, { signal }),
 *   TIMEOUT_DEFAULTS.externalApi,
 *   "API request"
 * );
 * ```
 */
export async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationName: string = "Operation"
): Promise<T> {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await operation(controller.signal);
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TimeoutError(operationName, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch with built-in timeout support
 *
 * @example
 * ```typescript
 * const response = await fetchWithTimeout(
 *   "https://api.example.com/data",
 *   { method: "GET" },
 *   TIMEOUT_DEFAULTS.externalApi
 * );
 * ```
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs: number = TIMEOUT_DEFAULTS.externalApi
): Promise<Response> {
  return withAbortableTimeout(
    (signal) => fetch(url, { ...options, signal }),
    timeoutMs,
    `fetch ${url}`
  );
}

/**
 * Create a fetch function with a fixed timeout
 *
 * @example
 * ```typescript
 * const quickFetch = createTimedFetch(TIMEOUT_DEFAULTS.quick);
 * const response = await quickFetch("https://api.example.com");
 * ```
 */
export function createTimedFetch(
  timeoutMs: number
): (url: string | URL, options?: RequestInit) => Promise<Response> {
  return (url: string | URL, options?: RequestInit) =>
    fetchWithTimeout(url, options, timeoutMs);
}

/**
 * Sleep for a specified duration
 * Can be aborted with AbortController
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Sleep aborted"));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      reject(new Error("Sleep aborted"));
    });
  });
}

/**
 * Deadline-based timeout
 * Useful when you have a fixed deadline rather than duration
 *
 * @example
 * ```typescript
 * const deadline = Date.now() + 30000; // 30 seconds from now
 * const result = await withDeadline(operation(), deadline, "operation");
 * ```
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  operationName: string = "Operation"
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();

  if (remainingMs <= 0) {
    throw new TimeoutError(operationName, 0);
  }

  return withTimeout(promise, remainingMs, operationName);
}

/**
 * Execute multiple operations with a shared deadline
 *
 * @example
 * ```typescript
 * const totalTimeout = 30000;
 * const deadline = createDeadline(totalTimeout);
 *
 * const result1 = await deadline.run(operation1(), "step 1");
 * const result2 = await deadline.run(operation2(), "step 2");
 * ```
 */
export function createDeadline(totalTimeoutMs: number) {
  const deadlineMs = Date.now() + totalTimeoutMs;

  return {
    deadlineMs,

    remaining(): number {
      return Math.max(0, deadlineMs - Date.now());
    },

    isExpired(): boolean {
      return Date.now() >= deadlineMs;
    },

    run<T>(promise: Promise<T>, operationName?: string): Promise<T> {
      return withDeadline(promise, deadlineMs, operationName);
    },
  };
}

/**
 * Wrapper that adds timeout to any async function
 *
 * @example
 * ```typescript
 * const timedQuery = withTimeoutWrapper(
 *   (id: string) => database.query(id),
 *   TIMEOUT_DEFAULTS.database,
 *   "database query"
 * );
 *
 * const result = await timedQuery("123");
 * ```
 */
export function withTimeoutWrapper<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  timeoutMs: number,
  operationName?: string
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => {
    const name = operationName || fn.name || "Operation";
    return withTimeout(fn(...args), timeoutMs, name);
  };
}

/**
 * Execute a promise with a named operation timeout from TIMEOUT_DEFAULTS
 */
export function withOperationTimeout<T>(
  promise: Promise<T>,
  operation: keyof typeof TIMEOUT_DEFAULTS
): Promise<T> {
  return withTimeout(promise, TIMEOUT_DEFAULTS[operation], operation);
}
