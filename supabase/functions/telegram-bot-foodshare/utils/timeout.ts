/**
 * Timeout utility for preventing long-running operations
 *
 * Note: withRetry is re-exported from errors.ts to avoid duplication.
 * Use the consolidated version for all retry logic.
 */

import { type RetryOptions, TimeoutError, withRetry as withRetryBase } from "./errors.ts";

// Re-export the consolidated retry function
export { type RetryOptions, withRetryBase as withRetry };

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = "Operation timed out",
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new TimeoutError(errorMessage, errorMessage)), timeoutMs)
  );
  return Promise.race([promise, timeout]);
}

/**
 * Execute multiple promises with a timeout for the entire batch
 */
export async function withBatchTimeout<T>(
  promises: Promise<T>[],
  timeoutMs: number,
  errorMessage: string = "Batch operation timed out",
): Promise<PromiseSettledResult<T>[]> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new TimeoutError(errorMessage, errorMessage)), timeoutMs)
  );

  return Promise.race([Promise.allSettled(promises), timeout]) as Promise<
    PromiseSettledResult<T>[]
  >;
}
