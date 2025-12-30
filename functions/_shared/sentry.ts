/**
 * Sentry APM Integration
 *
 * Provides error tracking and performance monitoring for Edge Functions.
 * Sentry is recommended for:
 * - Free tier: 5K errors/month
 * - Deno SDK available
 * - Performance monitoring included
 *
 * Setup:
 * 1. Create a Sentry project at https://sentry.io
 * 2. Add SENTRY_DSN to Supabase Edge Function secrets
 * 3. Import and call initSentry() at function start
 */

import { getContext } from "./context.ts";

// Sentry configuration
interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate: number;
  debug: boolean;
}

let config: SentryConfig | null = null;
let initialized = false;

/**
 * Initialize Sentry
 * Call this at the start of your edge function
 *
 * @example
 * ```typescript
 * import { initSentry } from "../_shared/sentry.ts";
 *
 * initSentry({ release: "1.0.0" });
 *
 * Deno.serve(async (req) => {
 *   // Your handler
 * });
 * ```
 */
export function initSentry(options?: Partial<Omit<SentryConfig, "dsn">>): boolean {
  const dsn = Deno.env.get("SENTRY_DSN");

  if (!dsn) {
    console.warn("SENTRY_DSN not configured - Sentry disabled");
    return false;
  }

  config = {
    dsn,
    environment: Deno.env.get("ENVIRONMENT") || "production",
    release: options?.release || Deno.env.get("FUNCTION_VERSION"),
    tracesSampleRate: options?.tracesSampleRate ?? 0.1, // 10% of transactions
    debug: options?.debug ?? false,
  };

  initialized = true;

  if (config.debug) {
    console.log("Sentry initialized:", {
      environment: config.environment,
      release: config.release,
      tracesSampleRate: config.tracesSampleRate,
    });
  }

  return true;
}

/**
 * Check if Sentry is initialized
 */
export function isSentryInitialized(): boolean {
  return initialized && config !== null;
}

/**
 * Capture an exception and send to Sentry
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   captureException(error, { userId: user.id, operation: "riskyOperation" });
 *   throw error; // Re-throw if needed
 * }
 * ```
 */
export async function captureException(
  error: Error | unknown,
  context?: Record<string, unknown>
): Promise<string | null> {
  if (!initialized || !config) {
    console.error("Sentry not initialized:", error);
    return null;
  }

  const ctx = getContext();
  const eventId = crypto.randomUUID();

  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "error",
    environment: config.environment,
    release: config.release,
    transaction: ctx?.service,
    exception: {
      values: [
        {
          type: error instanceof Error ? error.name : "Error",
          value: error instanceof Error ? error.message : String(error),
          stacktrace: error instanceof Error ? parseStackTrace(error.stack) : undefined,
        },
      ],
    },
    tags: {
      requestId: ctx?.requestId,
      correlationId: ctx?.correlationId,
      platform: ctx?.platform,
      service: ctx?.service,
    },
    extra: {
      ...context,
      ...ctx?.metadata,
    },
    user: ctx?.userId
      ? {
          id: ctx.userId,
        }
      : undefined,
  };

  try {
    await sendToSentry(event);
    return eventId;
  } catch (sendError) {
    console.error("Failed to send to Sentry:", sendError);
    return null;
  }
}

/**
 * Capture a message (non-error) and send to Sentry
 */
export async function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: Record<string, unknown>
): Promise<string | null> {
  if (!initialized || !config) {
    console.log(`[${level}] ${message}`);
    return null;
  }

  const ctx = getContext();
  const eventId = crypto.randomUUID();

  const event = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level,
    environment: config.environment,
    release: config.release,
    transaction: ctx?.service,
    message: {
      formatted: message,
    },
    tags: {
      requestId: ctx?.requestId,
      correlationId: ctx?.correlationId,
      platform: ctx?.platform,
      service: ctx?.service,
    },
    extra: {
      ...context,
      ...ctx?.metadata,
    },
    user: ctx?.userId
      ? {
          id: ctx.userId,
        }
      : undefined,
  };

  try {
    await sendToSentry(event);
    return eventId;
  } catch (sendError) {
    console.error("Failed to send to Sentry:", sendError);
    return null;
  }
}

/**
 * Start a performance transaction
 *
 * @example
 * ```typescript
 * const transaction = startTransaction("process-order", "task");
 * try {
 *   await processOrder();
 *   transaction.finish("ok");
 * } catch (error) {
 *   transaction.finish("error");
 *   throw error;
 * }
 * ```
 */
export function startTransaction(
  name: string,
  op: string
): {
  traceId: string;
  spanId: string;
  startTime: number;
  finish: (status?: "ok" | "error" | "cancelled") => Promise<void>;
} {
  const traceId = crypto.randomUUID().replace(/-/g, "");
  const spanId = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const startTime = performance.now();

  return {
    traceId,
    spanId,
    startTime,
    finish: async (status = "ok") => {
      if (!initialized || !config) return;

      // Only sample based on configured rate
      if (Math.random() > config.tracesSampleRate) return;

      const duration = performance.now() - startTime;
      const ctx = getContext();

      const transaction = {
        type: "transaction",
        transaction: name,
        timestamp: new Date().toISOString(),
        start_timestamp: new Date(Date.now() - duration).toISOString(),
        platform: "javascript",
        environment: config.environment,
        release: config.release,
        contexts: {
          trace: {
            trace_id: traceId,
            span_id: spanId,
            op,
            status,
          },
        },
        tags: {
          requestId: ctx?.requestId,
          platform: ctx?.platform,
          service: ctx?.service,
        },
        measurements: {
          duration: { value: duration, unit: "millisecond" },
        },
      };

      try {
        await sendToSentry(transaction);
      } catch (error) {
        if (config.debug) {
          console.error("Failed to send transaction:", error);
        }
      }
    },
  };
}

/**
 * Wrapper that automatically captures errors and performance
 *
 * @example
 * ```typescript
 * Deno.serve(withSentry("my-function", async (req) => {
 *   // Errors are automatically captured
 *   return new Response("OK");
 * }));
 * ```
 */
export function withSentry(
  name: string,
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const transaction = startTransaction(name, "http.server");

    try {
      const response = await handler(req);
      await transaction.finish(response.status >= 400 ? "error" : "ok");
      return response;
    } catch (error) {
      await captureException(error, { handler: name });
      await transaction.finish("error");
      throw error;
    }
  };
}

/**
 * Set user context for all subsequent events
 */
export function setUser(user: { id: string; email?: string; username?: string } | null): void {
  // User is set via context, this is a convenience method
  if (user) {
    const ctx = getContext();
    if (ctx) {
      ctx.metadata.sentryUser = user;
    }
  }
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  level?: "debug" | "info" | "warning" | "error";
  data?: Record<string, unknown>;
}): void {
  // In edge functions, breadcrumbs are logged rather than stored
  // since functions are short-lived
  if (config?.debug) {
    console.log("Breadcrumb:", breadcrumb);
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Parse a stack trace into Sentry format
 */
function parseStackTrace(stack?: string): { frames: Array<Record<string, unknown>> } | undefined {
  if (!stack) return undefined;

  const frames = stack
    .split("\n")
    .slice(1) // Skip "Error: message" line
    .map((line) => {
      const match = line.match(/at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):(\d+)\)?/);
      if (!match) return null;

      const [, func, filename, lineno, colno] = match;
      return {
        function: func || "<anonymous>",
        filename,
        lineno: parseInt(lineno, 10),
        colno: parseInt(colno, 10),
        in_app: !filename.includes("node_modules") && !filename.includes("deno"),
      };
    })
    .filter(Boolean)
    .reverse(); // Sentry expects frames in reverse order

  return { frames: frames as Array<Record<string, unknown>> };
}

/**
 * Send event to Sentry via HTTP API
 */
async function sendToSentry(event: Record<string, unknown>): Promise<void> {
  if (!config?.dsn) return;

  // Parse DSN: https://<key>@<org>.ingest.sentry.io/<project>
  const dsnMatch = config.dsn.match(
    /^https:\/\/([^@]+)@([^/]+)\/(\d+)$/
  );

  if (!dsnMatch) {
    console.error("Invalid Sentry DSN format");
    return;
  }

  const [, publicKey, host, projectId] = dsnMatch;
  const url = `https://${host}/api/${projectId}/envelope/`;

  // Create envelope format
  const header = JSON.stringify({
    event_id: event.event_id || crypto.randomUUID(),
    dsn: config.dsn,
    sdk: { name: "sentry.javascript.deno", version: "1.0.0" },
  });

  const itemHeader = JSON.stringify({
    type: event.type === "transaction" ? "transaction" : "event",
  });

  const envelope = `${header}\n${itemHeader}\n${JSON.stringify(event)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": `Sentry sentry_version=7,sentry_key=${publicKey},sentry_client=sentry.javascript.deno/1.0.0`,
    },
    body: envelope,
  });

  if (!response.ok && config.debug) {
    console.error("Sentry API error:", response.status, await response.text());
  }
}
