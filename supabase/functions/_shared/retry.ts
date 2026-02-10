/**
 * Unified Retry Logic with Exponential Backoff and Jitter
 *
 * Provides consistent retry behavior across all edge functions with:
 * - Configurable backoff strategies
 * - Jitter to prevent thundering herd
 * - Selective retry based on error type
 * - Retry callbacks for observability
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Jitter factor 0-1 (default: 0.3 = 30% jitter) */
  jitterFactor: number;
  /** Function to determine if error is retryable */
  shouldRetry?: (error: Error, attempt: number) => boolean;
  /** Callback on each retry attempt */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.3,
};

/**
 * Preset configurations for common use cases
 */
export const RETRY_PRESETS = {
  /** Fast retries for time-sensitive operations */
  quick: {
    maxRetries: 2,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    backoffMultiplier: 2,
    jitterFactor: 0.2,
  },

  /** Default balanced retry strategy */
  standard: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    jitterFactor: 0.3,
  },

  /** More aggressive retries for critical operations */
  aggressive: {
    maxRetries: 5,
    initialDelayMs: 500,
    maxDelayMs: 5000,
    backoffMultiplier: 1.5,
    jitterFactor: 0.25,
  },

  /** Patient retries for rate-limited APIs */
  patient: {
    maxRetries: 3,
    initialDelayMs: 2000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitterFactor: 0.3,
  },

  /** Very conservative for external APIs with strict rate limits */
  conservative: {
    maxRetries: 2,
    initialDelayMs: 5000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    jitterFactor: 0.4,
  },
} as const;

/**
 * Error classification helpers
 */
export const RETRYABLE_ERROR_PATTERNS = {
  network: ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "fetch failed"],
  timeout: ["timeout", "timed out", "deadline exceeded"],
  serverError: ["500", "502", "503", "504"],
  rateLimit: ["429", "rate limit", "too many requests"],
};

/**
 * Check if an error is retryable based on common patterns
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Check network errors
  for (const pattern of RETRYABLE_ERROR_PATTERNS.network) {
    if (message.includes(pattern.toLowerCase()) || name.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  // Check timeout errors
  for (const pattern of RETRYABLE_ERROR_PATTERNS.timeout) {
    if (message.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  // Check server errors (5xx)
  for (const pattern of RETRYABLE_ERROR_PATTERNS.serverError) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter: random value between -jitter and +jitter of the delay
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = Math.random() * jitterRange * 2 - jitterRange;

  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an operation with automatic retry on failure
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await withRetry(() => fetchData());
 *
 * // With preset
 * const result = await withRetry(() => fetchData(), RETRY_PRESETS.aggressive);
 *
 * // With custom config
 * const result = await withRetry(() => fetchData(), {
 *   maxRetries: 5,
 *   shouldRetry: (error) => error.message.includes('timeout'),
 *   onRetry: (error, attempt) => console.log(`Retry ${attempt}: ${error.message}`)
 * });
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<T> {
  const effectiveConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= effectiveConfig.maxRetries + 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we've exhausted retries
      if (attempt > effectiveConfig.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (effectiveConfig.shouldRetry) {
        if (!effectiveConfig.shouldRetry(lastError, attempt)) {
          break;
        }
      } else if (!isRetryableError(lastError)) {
        // Use default retryability check
        break;
      }

      // Calculate and wait for delay
      const delayMs = calculateDelay(attempt, effectiveConfig);

      // Notify about retry
      effectiveConfig.onRetry?.(lastError, attempt, delayMs);

      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Execute with retry, returning result or error (never throws)
 *
 * @example
 * ```typescript
 * const [result, error] = await tryWithRetry(() => fetchData());
 * if (error) {
 *   console.error('All retries failed:', error);
 * }
 * ```
 */
export async function tryWithRetry<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<[T | null, Error | null]> {
  try {
    const result = await withRetry(operation, config);
    return [result, null];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error))];
  }
}

/**
 * Create a retryable version of a function
 *
 * @example
 * ```typescript
 * const retryableFetch = createRetryable(
 *   (url: string) => fetch(url),
 *   RETRY_PRESETS.standard
 * );
 *
 * const response = await retryableFetch('https://api.example.com');
 * ```
 */
export function createRetryable<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  config?: Partial<RetryConfig>,
): T {
  return ((...args: Parameters<T>) => withRetry(() => fn(...args), config)) as T;
}

/**
 * Retry only on specific error codes/types
 *
 * @example
 * ```typescript
 * const result = await withRetryOn(
 *   () => callApi(),
 *   ['RATE_LIMIT', 'TIMEOUT'],
 *   { maxRetries: 5 }
 * );
 * ```
 */
export async function withRetryOn<T>(
  operation: () => Promise<T>,
  retryOnCodes: string[],
  config?: Partial<Omit<RetryConfig, "shouldRetry">>,
): Promise<T> {
  return withRetry(operation, {
    ...config,
    shouldRetry: (error) => {
      const message = error.message.toUpperCase();
      return retryOnCodes.some((code) => message.includes(code.toUpperCase()));
    },
  });
}

/**
 * Parse Retry-After header value (supports both seconds and date formats)
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  // Try parsing as number (seconds)
  const seconds = parseInt(value, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // Try parsing as HTTP date
  const date = Date.parse(value);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}
