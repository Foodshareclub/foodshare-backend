/**
 * Streaming Response Utilities
 *
 * Implements streaming patterns for Edge Functions:
 * - NDJSON (Newline Delimited JSON) streaming
 * - Server-Sent Events (SSE)
 * - Chunked JSON arrays
 * - Progress streaming for large operations
 *
 * @module
 */

// =============================================================================
// Types
// =============================================================================

export interface StreamOptions {
  /** Content-Type header */
  contentType?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Buffer size before flushing */
  highWaterMark?: number;
}

export interface SSEMessage {
  /** Event type */
  event?: string;
  /** Event data (will be JSON stringified if object) */
  data: unknown;
  /** Event ID for reconnection */
  id?: string;
  /** Retry interval in ms */
  retry?: number;
}

export interface ProgressEvent {
  /** Current progress (0-100) */
  progress: number;
  /** Current item being processed */
  current?: number;
  /** Total items */
  total?: number;
  /** Status message */
  message?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// NDJSON Streaming
// =============================================================================

/**
 * Create an NDJSON (Newline Delimited JSON) streaming response
 *
 * @example
 * ```ts
 * return createNDJSONStream(async function* () {
 *   for await (const item of fetchItems()) {
 *     yield item;
 *   }
 * });
 * ```
 */
export function createNDJSONStream<T>(
  generator: () => AsyncGenerator<T, void, unknown>,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const item of generator()) {
          const line = JSON.stringify(item) + "\n";
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": options.contentType || "application/x-ndjson",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...options.headers,
  };

  return new Response(stream, { headers });
}

/**
 * Stream an array as NDJSON
 */
export function streamArray<T>(
  items: T[],
  options: StreamOptions = {}
): Response {
  return createNDJSONStream(async function* () {
    for (const item of items) {
      yield item;
    }
  }, options);
}

/**
 * Stream database cursor results as NDJSON
 */
export function streamCursor<T>(
  fetchPage: (cursor: string | null, limit: number) => Promise<{ data: T[]; nextCursor: string | null }>,
  options: { pageSize?: number } & StreamOptions = {}
): Response {
  const { pageSize = 100, ...streamOptions } = options;

  return createNDJSONStream(async function* () {
    let cursor: string | null = null;

    while (true) {
      const { data, nextCursor } = await fetchPage(cursor, pageSize);

      for (const item of data) {
        yield item;
      }

      if (!nextCursor || data.length < pageSize) break;
      cursor = nextCursor;
    }
  }, streamOptions);
}

// =============================================================================
// Server-Sent Events (SSE)
// =============================================================================

/**
 * Create a Server-Sent Events streaming response
 *
 * @example
 * ```ts
 * return createSSEStream(async function* () {
 *   yield { event: "status", data: { connected: true } };
 *   for await (const update of watchUpdates()) {
 *     yield { event: "update", data: update };
 *   }
 * });
 * ```
 */
export function createSSEStream(
  generator: () => AsyncGenerator<SSEMessage, void, unknown>,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const message of generator()) {
          let data = "";

          if (message.id) {
            data += `id: ${message.id}\n`;
          }

          if (message.event) {
            data += `event: ${message.event}\n`;
          }

          if (message.retry) {
            data += `retry: ${message.retry}\n`;
          }

          // Data can be multi-line
          const dataStr = typeof message.data === "string"
            ? message.data
            : JSON.stringify(message.data);

          for (const line of dataStr.split("\n")) {
            data += `data: ${line}\n`;
          }

          data += "\n"; // End of message

          controller.enqueue(encoder.encode(data));
        }
        controller.close();
      } catch (error) {
        // Send error event before closing
        const errorMessage = `event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`;
        controller.enqueue(encoder.encode(errorMessage));
        controller.close();
      }
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
    ...options.headers,
  };

  return new Response(stream, { headers });
}

/**
 * Create a heartbeat-enabled SSE stream
 */
export function createSSEStreamWithHeartbeat(
  generator: () => AsyncGenerator<SSEMessage, void, unknown>,
  heartbeatIntervalMs = 30000,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatTimer: number | undefined;

      const sendHeartbeat = () => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream closed
          clearInterval(heartbeatTimer);
        }
      };

      // Start heartbeat
      heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);

      try {
        for await (const message of generator()) {
          let data = "";

          if (message.id) data += `id: ${message.id}\n`;
          if (message.event) data += `event: ${message.event}\n`;
          if (message.retry) data += `retry: ${message.retry}\n`;

          const dataStr = typeof message.data === "string"
            ? message.data
            : JSON.stringify(message.data);

          for (const line of dataStr.split("\n")) {
            data += `data: ${line}\n`;
          }

          data += "\n";
          controller.enqueue(encoder.encode(data));
        }
      } finally {
        clearInterval(heartbeatTimer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...options.headers,
    },
  });
}

// =============================================================================
// Progress Streaming
// =============================================================================

/**
 * Create a progress streaming response for long operations
 */
export function createProgressStream(
  operation: (
    reportProgress: (event: ProgressEvent) => void
  ) => Promise<unknown>,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const reportProgress = (event: ProgressEvent) => {
          const message = JSON.stringify({
            type: "progress",
            ...event,
            timestamp: Date.now(),
          }) + "\n";
          controller.enqueue(encoder.encode(message));
        };

        const result = await operation(reportProgress);

        // Send completion
        const completion = JSON.stringify({
          type: "complete",
          result,
          timestamp: Date.now(),
        }) + "\n";
        controller.enqueue(encoder.encode(completion));

        controller.close();
      } catch (error) {
        const errorMessage = JSON.stringify({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        }) + "\n";
        controller.enqueue(encoder.encode(errorMessage));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
      ...options.headers,
    },
  });
}

// =============================================================================
// Chunked JSON Array
// =============================================================================

/**
 * Stream a JSON array with opening/closing brackets
 * Useful for clients that expect valid JSON but can process incrementally
 */
export function createChunkedJSONArray<T>(
  generator: () => AsyncGenerator<T, void, unknown>,
  options: StreamOptions = {}
): Response {
  const encoder = new TextEncoder();
  let isFirst = true;

  const stream = new ReadableStream({
    async start(controller) {
      // Start array
      controller.enqueue(encoder.encode("["));

      try {
        for await (const item of generator()) {
          const prefix = isFirst ? "" : ",";
          const chunk = prefix + JSON.stringify(item);
          controller.enqueue(encoder.encode(chunk));
          isFirst = false;
        }

        // Close array
        controller.enqueue(encoder.encode("]"));
        controller.close();
      } catch (error) {
        // Try to close the array gracefully
        if (!isFirst) {
          controller.enqueue(encoder.encode("]"));
        } else {
          controller.enqueue(encoder.encode("[]"));
        }
        controller.close();
        throw error;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
      ...options.headers,
    },
  });
}

// =============================================================================
// Streaming Utilities
// =============================================================================

/**
 * Transform stream with async function
 */
export function mapStream<T, U>(
  stream: ReadableStream<T>,
  transform: (chunk: T) => Promise<U> | U
): ReadableStream<U> {
  const reader = stream.getReader();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        controller.close();
        return;
      }

      const transformed = await transform(value);
      controller.enqueue(transformed);
    },
  });
}

/**
 * Filter stream
 */
export function filterStream<T>(
  stream: ReadableStream<T>,
  predicate: (chunk: T) => Promise<boolean> | boolean
): ReadableStream<T> {
  const reader = stream.getReader();

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          return;
        }

        if (await predicate(value)) {
          controller.enqueue(value);
          return;
        }
      }
    },
  });
}

/**
 * Batch stream chunks
 */
export function batchStream<T>(
  stream: ReadableStream<T>,
  batchSize: number
): ReadableStream<T[]> {
  const reader = stream.getReader();
  let batch: T[] = [];

  return new ReadableStream({
    async pull(controller) {
      while (batch.length < batchSize) {
        const { done, value } = await reader.read();

        if (done) {
          if (batch.length > 0) {
            controller.enqueue(batch);
          }
          controller.close();
          return;
        }

        batch.push(value);
      }

      controller.enqueue(batch);
      batch = [];
    },
  });
}

/**
 * Collect stream into array
 */
export async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const chunks: T[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return chunks;
}

/**
 * Create a timeout wrapper for streams
 */
export function withStreamTimeout<T>(
  stream: ReadableStream<T>,
  timeoutMs: number
): ReadableStream<T> {
  const reader = stream.getReader();

  return new ReadableStream({
    async pull(controller) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Stream timeout")), timeoutMs);
      });

      try {
        const result = await Promise.race([reader.read(), timeoutPromise]);

        if (result.done) {
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
