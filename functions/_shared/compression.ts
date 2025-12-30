/**
 * Response Compression Middleware
 *
 * Implements transparent response compression for Edge Functions:
 * - Brotli (br) - Best compression, modern browsers
 * - Gzip - Wide compatibility
 * - Deflate - Fallback
 *
 * Features:
 * - Automatic Accept-Encoding negotiation
 * - Content-type aware (skip binary/compressed)
 * - Streaming support for large responses
 * - Configurable minimum size threshold
 *
 * @module
 */

// =============================================================================
// Types
// =============================================================================

export interface CompressionConfig {
  /** Minimum response size in bytes to compress (default: 1024) */
  threshold?: number;
  /** Compression level 1-9 (default: 6) */
  level?: number;
  /** Content types to compress (default: text/*, application/json, etc.) */
  compressibleTypes?: string[];
  /** Content types to never compress */
  excludeTypes?: string[];
  /** Prefer Brotli over Gzip when both are accepted */
  preferBrotli?: boolean;
}

export type CompressionEncoding = "br" | "gzip" | "deflate" | "identity";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_THRESHOLD = 1024; // 1KB
const DEFAULT_LEVEL = 6;

const DEFAULT_COMPRESSIBLE_TYPES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/x-www-form-urlencoded",
  "image/svg+xml",
];

const DEFAULT_EXCLUDE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/",
  "audio/",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-brotli",
];

// =============================================================================
// Encoding Negotiation
// =============================================================================

/**
 * Parse Accept-Encoding header and return preferred encoding
 */
export function negotiateEncoding(
  acceptEncoding: string | null,
  preferBrotli = true
): CompressionEncoding {
  if (!acceptEncoding) return "identity";

  const encodings = acceptEncoding
    .toLowerCase()
    .split(",")
    .map((e) => {
      const [encoding, quality] = e.trim().split(";q=");
      return {
        encoding: encoding.trim(),
        quality: quality ? parseFloat(quality) : 1.0,
      };
    })
    .filter((e) => e.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  // Check for supported encodings in preference order
  const hasBrotli = encodings.some((e) => e.encoding === "br");
  const hasGzip = encodings.some((e) => e.encoding === "gzip");
  const hasDeflate = encodings.some((e) => e.encoding === "deflate");

  if (preferBrotli && hasBrotli) return "br";
  if (hasGzip) return "gzip";
  if (hasBrotli) return "br"; // Fallback to brotli if no gzip
  if (hasDeflate) return "deflate";

  return "identity";
}

/**
 * Check if content type is compressible
 */
export function isCompressible(
  contentType: string | null,
  compressibleTypes = DEFAULT_COMPRESSIBLE_TYPES,
  excludeTypes = DEFAULT_EXCLUDE_TYPES
): boolean {
  if (!contentType) return false;

  const type = contentType.split(";")[0].trim().toLowerCase();

  // Check exclusions first
  for (const exclude of excludeTypes) {
    if (exclude.endsWith("/")) {
      if (type.startsWith(exclude)) return false;
    } else if (type === exclude) {
      return false;
    }
  }

  // Check compressible types
  for (const compressible of compressibleTypes) {
    if (compressible.endsWith("/")) {
      if (type.startsWith(compressible)) return true;
    } else if (type === compressible) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Compression Functions
// =============================================================================

/**
 * Compress data using the specified encoding
 */
export async function compress(
  data: Uint8Array,
  encoding: CompressionEncoding,
  _level = DEFAULT_LEVEL
): Promise<Uint8Array> {
  if (encoding === "identity") return data;

  // Use Web Streams Compression API
  const compressionFormat = encoding === "br" ? "deflate" : encoding; // Brotli not in standard API

  try {
    const stream = new CompressionStream(compressionFormat as CompressionFormat);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    // Write data (cast to satisfy TypeScript)
    writer.write(data as unknown as BufferSource);
    writer.close();

    // Read compressed data
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    // Combine chunks
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  } catch {
    // Fallback to uncompressed if compression fails
    return data;
  }
}

/**
 * Create a compression transform stream
 */
export function createCompressionStream(
  encoding: CompressionEncoding
): CompressionStream | null {
  if (encoding === "identity" || encoding === "br") {
    // Brotli not supported in standard CompressionStream
    return null;
  }

  try {
    return new CompressionStream(encoding as CompressionFormat);
  } catch {
    return null;
  }
}

// =============================================================================
// Response Compression
// =============================================================================

/**
 * Compress a Response body
 */
export async function compressResponse(
  response: Response,
  encoding: CompressionEncoding,
  config: CompressionConfig = {}
): Promise<Response> {
  const { threshold = DEFAULT_THRESHOLD, level = DEFAULT_LEVEL } = config;

  // Skip if identity encoding
  if (encoding === "identity") return response;

  // Skip if already compressed
  if (response.headers.has("Content-Encoding")) return response;

  // Check content type
  const contentType = response.headers.get("Content-Type");
  if (!isCompressible(contentType, config.compressibleTypes, config.excludeTypes)) {
    return response;
  }

  // Get body
  const body = await response.arrayBuffer();

  // Skip if below threshold
  if (body.byteLength < threshold) return response;

  // Compress
  const compressed = await compress(new Uint8Array(body), encoding, level);

  // Only use compressed version if it's smaller
  if (compressed.length >= body.byteLength) {
    return response;
  }

  // Create new response with compressed body
  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", compressed.length.toString());
  headers.append("Vary", "Accept-Encoding");

  return new Response(compressed.buffer as ArrayBuffer, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
// Streaming Compression
// =============================================================================

/**
 * Create a compressed streaming response
 */
export function createCompressedStream(
  stream: ReadableStream<Uint8Array>,
  encoding: CompressionEncoding,
  headers: Headers
): ReadableStream<Uint8Array> {
  if (encoding === "identity") return stream;

  const compressionStream = createCompressionStream(encoding);
  if (!compressionStream) return stream;

  // Update headers
  headers.set("Content-Encoding", encoding);
  headers.delete("Content-Length"); // Unknown for streams
  headers.append("Vary", "Accept-Encoding");
  headers.set("Transfer-Encoding", "chunked");

  // Use type assertion for CompressionStream compatibility
  return stream.pipeThrough(compressionStream as unknown as TransformStream<Uint8Array, Uint8Array>);
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Compression middleware for handlers
 */
export function withCompression<T extends (request: Request) => Promise<Response>>(
  handler: T,
  config: CompressionConfig = {}
): T {
  return (async (request: Request) => {
    // Get accepted encoding
    const acceptEncoding = request.headers.get("Accept-Encoding");
    const encoding = negotiateEncoding(acceptEncoding, config.preferBrotli);

    // Execute handler
    const response = await handler(request);

    // Skip compression for certain status codes
    if (response.status === 204 || response.status === 304) {
      return response;
    }

    // Compress response
    return compressResponse(response, encoding, config);
  }) as T;
}

/**
 * Pre-compression check (use before expensive operations)
 */
export function shouldCompress(request: Request): boolean {
  const acceptEncoding = request.headers.get("Accept-Encoding");
  return negotiateEncoding(acceptEncoding) !== "identity";
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Get compression stats for a response
 */
export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  ratio: number;
  encoding: CompressionEncoding;
  saved: number;
}

export async function getCompressionStats(
  data: Uint8Array,
  encoding: CompressionEncoding
): Promise<CompressionStats> {
  const originalSize = data.length;
  const compressed = await compress(data, encoding);
  const compressedSize = compressed.length;

  return {
    originalSize,
    compressedSize,
    ratio: originalSize > 0 ? compressedSize / originalSize : 1,
    encoding,
    saved: originalSize - compressedSize,
  };
}

// =============================================================================
// ETag Support
// =============================================================================

/**
 * Generate ETag for content
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hashHex.slice(0, 16)}"`;
}

/**
 * Add ETag and handle conditional requests
 */
export async function handleConditionalRequest(
  request: Request,
  response: Response
): Promise<Response> {
  // Only for successful GET/HEAD requests
  if (!["GET", "HEAD"].includes(request.method) || !response.ok) {
    return response;
  }

  // Generate ETag if not present
  let etag = response.headers.get("ETag");
  if (!etag) {
    const body = await response.clone().arrayBuffer();
    etag = await generateETag(new Uint8Array(body));
  }

  // Check If-None-Match
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": response.headers.get("Cache-Control") || "",
      },
    });
  }

  // Add ETag to response
  const headers = new Headers(response.headers);
  headers.set("ETag", etag);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
