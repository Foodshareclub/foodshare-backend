/**
 * Response Compression Utilities
 *
 * Provides optimized compression for Edge Function responses
 * with support for gzip, deflate, and brotli algorithms.
 */

// Compression algorithm types
export type CompressionAlgorithm = "gzip" | "deflate" | "br" | "none";

// Compression configuration
export interface CompressionConfig {
  algorithm: CompressionAlgorithm;
  level?: number; // 1-9 for gzip/deflate, 1-11 for brotli
  minSize?: number; // Minimum size to compress (bytes)
  mimeTypes?: string[]; // MIME types to compress
}

// Default configuration
const DEFAULT_CONFIG: CompressionConfig = {
  algorithm: "gzip",
  level: 6,
  minSize: 1024, // 1KB minimum
  mimeTypes: [
    "application/json",
    "text/html",
    "text/css",
    "text/javascript",
    "application/javascript",
    "text/plain",
    "text/xml",
    "application/xml",
  ],
};

// Compression statistics
interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  ratio: number;
  algorithm: CompressionAlgorithm;
  timeMs: number;
}

/**
 * Select best compression algorithm based on Accept-Encoding header.
 */
export function selectAlgorithm(acceptEncoding: string | null): CompressionAlgorithm {
  if (!acceptEncoding) return "none";

  const encodings = acceptEncoding.toLowerCase();

  // Prefer brotli if available (best compression)
  if (encodings.includes("br")) return "br";

  // Fall back to gzip (widely supported)
  if (encodings.includes("gzip")) return "gzip";

  // Then deflate
  if (encodings.includes("deflate")) return "deflate";

  return "none";
}

/**
 * Check if content type should be compressed.
 */
export function shouldCompress(
  contentType: string | null,
  contentLength: number,
  config: CompressionConfig = DEFAULT_CONFIG
): boolean {
  // Check minimum size
  if (contentLength < (config.minSize ?? DEFAULT_CONFIG.minSize!)) {
    return false;
  }

  // Check MIME type
  if (!contentType) return false;

  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  const allowedMimes = config.mimeTypes ?? DEFAULT_CONFIG.mimeTypes!;

  return allowedMimes.some((mime) => mimeType.includes(mime) || mime.includes(mimeType));
}

/**
 * Compress data using specified algorithm.
 */
export async function compress(
  data: Uint8Array | string,
  algorithm: CompressionAlgorithm,
  level?: number
): Promise<{ data: Uint8Array; stats: CompressionStats }> {
  const startTime = Date.now();
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const originalSize = input.length;

  if (algorithm === "none") {
    return {
      data: input,
      stats: {
        originalSize,
        compressedSize: originalSize,
        ratio: 1,
        algorithm: "none",
        timeMs: 0,
      },
    };
  }

  let compressed: Uint8Array;

  switch (algorithm) {
    case "gzip":
      compressed = await compressGzip(input, level ?? 6);
      break;
    case "deflate":
      compressed = await compressDeflate(input, level ?? 6);
      break;
    case "br":
      // Note: Brotli not available in Deno by default, fall back to gzip
      compressed = await compressGzip(input, level ?? 6);
      break;
    default:
      compressed = input;
  }

  const timeMs = Date.now() - startTime;

  return {
    data: compressed,
    stats: {
      originalSize,
      compressedSize: compressed.length,
      ratio: compressed.length / originalSize,
      algorithm,
      timeMs,
    },
  };
}

/**
 * Compress using gzip via CompressionStream.
 */
async function compressGzip(data: Uint8Array, _level: number): Promise<Uint8Array> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Compress using deflate via CompressionStream.
 */
async function compressDeflate(data: Uint8Array, _level: number): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Decompress data.
 */
export async function decompress(
  data: Uint8Array,
  algorithm: CompressionAlgorithm
): Promise<Uint8Array> {
  if (algorithm === "none") return data;

  const format = algorithm === "br" ? "gzip" : algorithm;
  const stream = new DecompressionStream(format as CompressionFormat);
  const writer = stream.writable.getWriter();
  writer.write(data);
  writer.close();

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Create a compressed response.
 */
export async function createCompressedResponse(
  body: string | Record<string, unknown> | Uint8Array,
  options: {
    status?: number;
    headers?: Record<string, string>;
    acceptEncoding?: string | null;
    config?: CompressionConfig;
  } = {}
): Promise<Response> {
  const {
    status = 200,
    headers = {},
    acceptEncoding = null,
    config = DEFAULT_CONFIG,
  } = options;

  // Determine content type
  let contentType = headers["Content-Type"] ?? headers["content-type"];
  let data: Uint8Array;

  if (typeof body === "string") {
    data = new TextEncoder().encode(body);
    contentType = contentType ?? "text/plain";
  } else if (body instanceof Uint8Array) {
    data = body;
    contentType = contentType ?? "application/octet-stream";
  } else {
    data = new TextEncoder().encode(JSON.stringify(body));
    contentType = contentType ?? "application/json";
  }

  // Check if should compress
  const algorithm = selectAlgorithm(acceptEncoding);

  if (!shouldCompress(contentType, data.length, config) || algorithm === "none") {
    return new Response(data, {
      status,
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": String(data.length),
      },
    });
  }

  // Compress
  const { data: compressed, stats } = await compress(data, algorithm, config.level);

  // Only use compressed if it's actually smaller
  if (stats.ratio >= 1) {
    return new Response(data, {
      status,
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": String(data.length),
      },
    });
  }

  // Return compressed response
  return new Response(compressed, {
    status,
    headers: {
      ...headers,
      "Content-Type": contentType,
      "Content-Encoding": algorithm === "br" ? "gzip" : algorithm, // Fall back br to gzip
      "Content-Length": String(compressed.length),
      "X-Original-Size": String(stats.originalSize),
      "X-Compression-Ratio": stats.ratio.toFixed(3),
      "Vary": "Accept-Encoding",
    },
  });
}

/**
 * Middleware for automatic compression.
 */
export function compressionMiddleware(
  handler: (req: Request) => Promise<Response>,
  config: CompressionConfig = DEFAULT_CONFIG
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const response = await handler(req);

    // Get accept encoding
    const acceptEncoding = req.headers.get("Accept-Encoding");

    // Check if already compressed
    if (response.headers.get("Content-Encoding")) {
      return response;
    }

    // Get response body
    const contentType = response.headers.get("Content-Type");
    const body = await response.arrayBuffer();
    const data = new Uint8Array(body);

    // Check if should compress
    const algorithm = selectAlgorithm(acceptEncoding);

    if (!shouldCompress(contentType, data.length, config) || algorithm === "none") {
      return new Response(data, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Compress
    const { data: compressed, stats } = await compress(data, algorithm, config.level);

    // Only use compressed if it's actually smaller
    if (stats.ratio >= 1) {
      return new Response(data, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Create new headers
    const headers = new Headers(response.headers);
    headers.set("Content-Encoding", algorithm === "br" ? "gzip" : algorithm);
    headers.set("Content-Length", String(compressed.length));
    headers.set("X-Original-Size", String(stats.originalSize));
    headers.set("X-Compression-Ratio", stats.ratio.toFixed(3));
    headers.set("Vary", "Accept-Encoding");

    return new Response(compressed, {
      status: response.status,
      headers,
    });
  };
}

/**
 * Get compression recommendations for a response.
 */
export function getCompressionRecommendation(
  contentType: string,
  contentLength: number,
  acceptEncoding: string | null
): {
  shouldCompress: boolean;
  algorithm: CompressionAlgorithm;
  expectedRatio: number;
  reason: string;
} {
  const canCompress = shouldCompress(contentType, contentLength);
  const algorithm = selectAlgorithm(acceptEncoding);

  if (!canCompress) {
    return {
      shouldCompress: false,
      algorithm: "none",
      expectedRatio: 1,
      reason: contentLength < 1024
        ? "Content too small"
        : "Content type not compressible",
    };
  }

  if (algorithm === "none") {
    return {
      shouldCompress: false,
      algorithm: "none",
      expectedRatio: 1,
      reason: "Client does not accept compression",
    };
  }

  // Estimate compression ratio based on content type
  let expectedRatio = 0.7; // Default

  if (contentType.includes("json")) {
    expectedRatio = 0.3; // JSON compresses well
  } else if (contentType.includes("text")) {
    expectedRatio = 0.4;
  } else if (contentType.includes("html")) {
    expectedRatio = 0.35;
  }

  return {
    shouldCompress: true,
    algorithm,
    expectedRatio,
    reason: `${algorithm} compression recommended`,
  };
}

export { CompressionStats };
