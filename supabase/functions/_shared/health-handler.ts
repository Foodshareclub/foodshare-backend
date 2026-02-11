/**
 * Shared Health Handler
 *
 * Creates a reusable health check handler for edge functions.
 * Uses ok() helper so health responses get proper unified format + CORS headers.
 *
 * @module health-handler
 */

import { type HandlerContext, ok } from "./api-handler.ts";

const startTime = Date.now();

/**
 * Create a health check handler for an edge function
 *
 * @param service - Service name (e.g., "api-v1-products")
 * @param version - Service version string
 * @param options.extra - Optional async function returning additional health data
 *
 * @example
 * ```typescript
 * const healthCheck = createHealthHandler("api-v1-products", "2.0.0");
 * // In route handler:
 * if (url.pathname.endsWith("/health")) return healthCheck(ctx);
 * ```
 *
 * @example With custom health data:
 * ```typescript
 * const healthCheck = createHealthHandler("api-v1-ai", "1.0.0", {
 *   extra: () => ({ providers: { groq: "configured" } }),
 * });
 * ```
 */
export function createHealthHandler(
  service: string,
  version: string,
  options?: {
    extra?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  },
) {
  return async (ctx: HandlerContext): Promise<Response> => {
    const healthData: Record<string, unknown> = {
      status: "healthy",
      service,
      version,
      timestamp: new Date().toISOString(),
      uptime: Math.round((Date.now() - startTime) / 1000),
    };

    if (options?.extra) {
      Object.assign(healthData, await options.extra());
    }

    return ok(healthData, ctx);
  };
}
