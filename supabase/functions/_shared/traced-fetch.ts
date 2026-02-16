/**
 * Traced Fetch Wrapper
 *
 * Wraps the global `fetch()` with automatic span tracing and
 * context header propagation (X-Correlation-Id, X-Request-Id).
 */

import { startSpan } from "./performance.ts";
import { getContextHeaders } from "./context.ts";

/**
 * Fetch with automatic span tracing and context header injection.
 *
 * @param url - The URL to fetch
 * @param init - Standard fetch RequestInit options
 * @param operationName - Optional span operation name (defaults to "fetch.<hostname>")
 */
export async function tracedFetch(
  url: string | URL,
  init?: RequestInit,
  operationName?: string,
): Promise<Response> {
  const urlObj = typeof url === "string" ? new URL(url) : url;
  const operation = operationName || `fetch.${urlObj.hostname}`;
  const span = startSpan(operation);

  // Inject context headers
  const contextHeaders = getContextHeaders();
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(contextHeaders)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  try {
    const response = await fetch(urlObj, {
      ...init,
      headers,
    });

    span.end({
      status: response.status,
      url: urlObj.origin + urlObj.pathname,
    });

    return response;
  } catch (error) {
    span.end({
      error: error instanceof Error ? error.message : String(error),
      url: urlObj.origin + urlObj.pathname,
    });
    throw error;
  }
}
