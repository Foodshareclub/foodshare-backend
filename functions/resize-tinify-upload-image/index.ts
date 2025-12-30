/**
 * Smart Image Compression Edge Function v16
 *
 * Modular architecture with separate provider implementations.
 * Migrated to createAPIHandler for unified patterns.
 *
 * Features:
 * - Modular provider system (TinyPNG, Cloudinary)
 * - Circuit breaker pattern for resilience
 * - Provider racing for best performance
 * - Request deduplication
 * - Orphan file detection and cleanup
 * - Batch processing with concurrency control
 * - Comprehensive health monitoring
 *
 * Modes:
 * - GET ?mode=health - Health check and metrics
 * - GET ?mode=quota - Provider quotas
 * - GET ?mode=providers - Provider health
 * - POST ?mode=batch - Process images from single bucket
 * - POST ?mode=batch-all - Process images from all buckets
 * - POST ?mode=upload - Compress and upload single image
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError, RateLimitError } from "../_shared/errors.ts";
import {
  createCompressionService,
  CompressionService,
  CompressionResult,
  BatchItem,
  BatchResult,
  ErrorType,
} from "../_shared/compression/index.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "v16",
  skipThreshold: 100 * 1024, // 100KB
  defaultBucket: "posts",
  batch: {
    maxConcurrency: 3,
    maxBatchSize: 20,
    defaultLimit: 5,
  },
  timeouts: {
    downloadTimeout: 20000,
    orphanCheckTimeout: 5000,
  },
  rateLimit: {
    maxRequestsPerMinute: 60,
    windowMs: 60000,
  },
} as const;

const BUCKETS = ["profiles", "posts", "flags", "forum", "challenges", "rooms", "assets"] as const;
type Bucket = (typeof BUCKETS)[number];

// =============================================================================
// State
// =============================================================================

const rateLimitWindow = { requests: 0, windowStart: Date.now() };
let orphansDetected = 0;

// =============================================================================
// Query Schemas
// =============================================================================

const modeQuerySchema = z.object({
  mode: z.enum(["health", "quota", "providers", "batch", "batch-all", "upload"]).optional().default("health"),
  bucket: z.string().optional(),
  limit: z.string().optional(),
  minSize: z.string().optional(),
  concurrency: z.string().optional(),
});

type ModeQuery = z.infer<typeof modeQuerySchema>;

// =============================================================================
// Utilities
// =============================================================================

function formatBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function detectFormat(d: Uint8Array): string {
  if (d[0] === 0xff && d[1] === 0xd8) return "jpeg";
  if (d[0] === 0x89 && d[1] === 0x50) return "png";
  if (d[0] === 0x47 && d[1] === 0x49) return "gif";
  if (d[0] === 0x52 && d[1] === 0x49) return "webp";
  return "jpeg";
}

function generateUUID(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function categorizeError(error: string): ErrorType {
  const e = error.toLowerCase();
  if (e.includes("orphan") || e.includes("not found") || e.includes("404")) return "orphan";
  if (e.includes("timeout") || e.includes("aborted")) return "timeout";
  if (e.includes("rate limit") || e.includes("quota") || e.includes("429")) return "quota";
  if (e.includes("invalid") || e.includes("unsupported")) return "validation";
  if (e.includes("network") || e.includes("fetch") || e.includes("connection")) return "network";
  if (e.includes("tinypng") || e.includes("cloudinary")) return "service";
  return "unknown";
}

function checkRateLimit(): boolean {
  const now = Date.now();
  if (now - rateLimitWindow.windowStart > CONFIG.rateLimit.windowMs) {
    rateLimitWindow.requests = 0;
    rateLimitWindow.windowStart = now;
  }
  if (rateLimitWindow.requests >= CONFIG.rateLimit.maxRequestsPerMinute) return false;
  rateLimitWindow.requests++;
  return true;
}

// =============================================================================
// Orphan Detection
// =============================================================================

async function checkFileExists(
  supabase: SupabaseClient,
  bucket: string,
  path: string
): Promise<boolean> {
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    if (!data?.publicUrl) return false;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeouts.orphanCheckTimeout);

    const res = await fetch(data.publicUrl, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);

    return res.ok;
  } catch {
    return false;
  }
}

async function markAsOrphan(
  supabase: SupabaseClient,
  bucket: string,
  path: string,
  size: number
): Promise<void> {
  try {
    await supabase.rpc("record_compression_result", {
      p_bucket: bucket,
      p_original_path: path,
      p_compressed_path: null,
      p_original_size: size,
      p_compressed_size: null,
      p_original_width: null,
      p_original_height: null,
      p_compressed_width: null,
      p_compressed_height: null,
      p_original_format: null,
      p_compressed_format: null,
      p_compression_method: "orphan-detected",
      p_quality_setting: null,
      p_processing_time_ms: 0,
      p_status: "orphan",
      p_error_message: "File exists in metadata but not in storage",
    });

    orphansDetected++;
    logger.warn("Orphan file detected", { bucket, path, size: formatBytes(size) });
  } catch (e) {
    logger.error("Failed to mark orphan", { bucket, path, error: String(e) });
  }
}

// =============================================================================
// DB Logging
// =============================================================================

async function logResult(
  supabase: SupabaseClient,
  bucket: string,
  result: CompressionResult
): Promise<void> {
  try {
    await supabase.rpc("record_compression_result", {
      p_bucket: bucket,
      p_original_path: result.originalPath,
      p_compressed_path: result.compressedPath || null,
      p_original_size: result.originalSize,
      p_compressed_size: result.compressedSize || null,
      p_original_width: null,
      p_original_height: null,
      p_compressed_width: null,
      p_compressed_height: null,
      p_original_format: null,
      p_compressed_format: result.compressedFormat || null,
      p_compression_method: result.compressionMethod || null,
      p_quality_setting: null,
      p_processing_time_ms: result.processingTimeMs,
      p_status: result.success ? "completed" : "failed",
      p_error_message: result.error || null,
    });
  } catch (e) {
    logger.warn("Failed to log result", { error: String(e) });
  }
}

// =============================================================================
// Batch Processing
// =============================================================================

async function processItem(
  supabase: SupabaseClient,
  item: BatchItem,
  compressionService: CompressionService
): Promise<CompressionResult> {
  const start = Date.now();

  try {
    // Check if file exists (orphan detection)
    const exists = await checkFileExists(supabase, item.bucket, item.path);
    if (!exists) {
      await markAsOrphan(supabase, item.bucket, item.path, item.size);
      return {
        success: false,
        originalPath: item.path,
        originalSize: item.size,
        processingTimeMs: Date.now() - start,
        error: "Orphan file - metadata exists but file not found",
        errorType: "orphan",
      };
    }

    // Download file
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeouts.downloadTimeout);

    const { data: fileData, error: dlErr } = await supabase.storage
      .from(item.bucket)
      .download(item.path);
    clearTimeout(timeoutId);

    if (dlErr || !fileData) {
      throw new Error(`Download failed: ${dlErr?.message || "No data"}`);
    }

    const imageData = new Uint8Array(await fileData.arrayBuffer());

    // Skip if already small
    if (imageData.length <= CONFIG.skipThreshold) {
      return {
        success: true,
        originalPath: item.path,
        compressedPath: item.path,
        originalSize: imageData.length,
        compressedSize: imageData.length,
        compressionMethod: "skipped-small",
        processingTimeMs: Date.now() - start,
      };
    }

    // Compress using the service
    const compressed = await compressionService.compress(imageData, `${item.bucket}:${item.path}`);
    const format = detectFormat(compressed.buffer);

    // Skip if no improvement
    if (compressed.buffer.length >= imageData.length) {
      return {
        success: true,
        originalPath: item.path,
        compressedPath: item.path,
        originalSize: imageData.length,
        compressedSize: imageData.length,
        compressionMethod: "no-improvement",
        processingTimeMs: Date.now() - start,
      };
    }

    // Upload compressed version
    const { error: upErr } = await supabase.storage
      .from(item.bucket)
      .update(item.path, compressed.buffer, {
        contentType: `image/${format}`,
        cacheControl: "31536000",
        upsert: true,
      });

    if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

    return {
      success: true,
      originalPath: item.path,
      compressedPath: item.path,
      originalSize: imageData.length,
      compressedSize: compressed.buffer.length,
      compressedFormat: format,
      compressionMethod: compressed.method,
      processingTimeMs: Date.now() - start,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      success: false,
      originalPath: item.path,
      originalSize: item.size,
      processingTimeMs: Date.now() - start,
      error: msg,
      errorType: categorizeError(msg),
    };
  }
}

async function processBatch(
  supabase: SupabaseClient,
  items: BatchItem[],
  compressionService: CompressionService,
  concurrency: number
): Promise<BatchResult> {
  const results: CompressionResult[] = [];
  let processed = 0,
    failed = 0,
    skipped = 0,
    orphaned = 0,
    totalSaved = 0;
  const times: number[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((item) => processItem(supabase, item, compressionService))
    );

    for (const result of chunkResults) {
      results.push(result);
      times.push(result.processingTimeMs);

      if (result.errorType === "orphan") {
        orphaned++;
      } else if (result.success) {
        if (
          result.compressionMethod?.includes("skipped") ||
          result.compressionMethod === "no-improvement"
        ) {
          skipped++;
        } else {
          processed++;
          totalSaved += result.originalSize - (result.compressedSize || 0);
        }
      } else {
        failed++;
      }

      await logResult(supabase, chunk[0]?.bucket || CONFIG.defaultBucket, result);
    }
  }

  const avgTimeMs =
    times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;

  logger.info("Batch complete", {
    processed,
    failed,
    skipped,
    orphaned,
    saved: formatBytes(totalSaved),
  });

  return { processed, failed, skipped, orphaned, results, totalSavedBytes: totalSaved, avgTimeMs };
}

// =============================================================================
// Handler Implementations
// =============================================================================

async function handleHealthCheck(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService
): Promise<Response> {
  const metrics = compressionService.getMetrics();
  const circuits = compressionService.getCircuits();
  const quotas = compressionService.getQuotas();

  return ok(
    {
      status: "healthy",
      version: CONFIG.version,
      uptime: formatDuration(metrics.uptime),
      providers: compressionService.getConfiguredProviders(),
      metrics: {
        requests: {
          total: metrics.requestsTotal,
          success: metrics.requestsSuccess,
          failed: metrics.requestsFailed,
        },
        bytes: {
          processed: formatBytes(metrics.bytesProcessed),
          saved: formatBytes(metrics.bytesSaved),
        },
        orphansDetected,
        avgLatency: formatDuration(metrics.avgLatencyMs),
        byProvider: metrics.compressionsByProvider,
      },
      circuits,
      quotas,
      rateLimit: {
        remaining: CONFIG.rateLimit.maxRequestsPerMinute - rateLimitWindow.requests,
      },
    },
    ctx
  );
}

async function handleQuotaCheck(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService
): Promise<Response> {
  const quotas = compressionService.getQuotas();
  const circuits = compressionService.getCircuits();

  return ok(
    {
      success: true,
      providers: compressionService.getConfiguredProviders(),
      quotas,
      circuits,
    },
    ctx
  );
}

async function handleProviderHealth(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService
): Promise<Response> {
  const health = await compressionService.checkHealth();
  const debug = compressionService.getDebugInfo();

  return ok(
    {
      success: true,
      providers: health,
      debug,
    },
    ctx
  );
}

async function handleBatch(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService,
  startTime: number
): Promise<Response> {
  const { supabase, query } = ctx;

  if (!checkRateLimit()) {
    throw new RateLimitError("Rate limit exceeded", CONFIG.rateLimit.windowMs / 1000);
  }

  if (!compressionService.hasAvailableProvider()) {
    throw new ServerError("No compression providers available");
  }

  const bucket = query.bucket || CONFIG.defaultBucket;
  const limit = Math.min(
    parseInt(query.limit || String(CONFIG.batch.defaultLimit)),
    CONFIG.batch.maxBatchSize
  );
  const minSize = parseInt(query.minSize || String(CONFIG.skipThreshold));
  const concurrency = Math.min(
    parseInt(query.concurrency || String(CONFIG.batch.maxConcurrency)),
    CONFIG.batch.maxConcurrency
  );

  const { data: images, error } = await supabase.rpc("get_large_uncompressed_images", {
    target_bucket: bucket,
    size_threshold_bytes: minSize,
    max_results: limit,
  });

  if (error) {
    throw new ServerError(`Query failed: ${error.message}`);
  }

  if (!images?.length) {
    return ok(
      {
        success: true,
        message: "No images to process",
        bucket,
        processed: 0,
        failed: 0,
        skipped: 0,
        orphaned: 0,
      },
      ctx
    );
  }

  const items: BatchItem[] = images.map(
    (i: { bucket: string; path: string; size: number }) => ({
      bucket: i.bucket,
      path: i.path,
      size: i.size,
    })
  );

  const result = await processBatch(supabase, items, compressionService, concurrency);

  return ok(
    {
      success: true,
      mode: "batch",
      bucket,
      concurrency,
      ...result,
      duration: Date.now() - startTime,
      circuits: compressionService.getCircuits(),
      results: result.results.map((r) => ({
        path: r.originalPath,
        success: r.success,
        originalSize: r.originalSize,
        compressedSize: r.compressedSize,
        savedPercent:
          r.compressedSize && r.originalSize > r.compressedSize
            ? Math.round((1 - r.compressedSize / r.originalSize) * 100)
            : 0,
        method: r.compressionMethod,
        error: r.error,
        errorType: r.errorType,
      })),
    },
    ctx
  );
}

async function handleBatchAll(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService,
  startTime: number
): Promise<Response> {
  const { supabase, query } = ctx;

  if (!checkRateLimit()) {
    throw new RateLimitError("Rate limit exceeded", CONFIG.rateLimit.windowMs / 1000);
  }

  if (!compressionService.hasAvailableProvider()) {
    throw new ServerError("No compression providers available");
  }

  const limit = Math.min(
    parseInt(query.limit || String(CONFIG.batch.defaultLimit)),
    CONFIG.batch.maxBatchSize
  );
  const minSize = parseInt(query.minSize || String(CONFIG.skipThreshold));
  const concurrency = Math.min(
    parseInt(query.concurrency || String(CONFIG.batch.maxConcurrency)),
    CONFIG.batch.maxConcurrency
  );

  const { data: images, error } = await supabase.rpc(
    "get_large_uncompressed_images_all_buckets",
    {
      size_threshold_bytes: minSize,
      max_results: limit,
    }
  );

  if (error) {
    throw new ServerError(`Query failed: ${error.message}`);
  }

  if (!images?.length) {
    return ok(
      {
        success: true,
        message: "No images to process across all buckets",
        buckets: BUCKETS,
        processed: 0,
        failed: 0,
        skipped: 0,
        orphaned: 0,
      },
      ctx
    );
  }

  const items: BatchItem[] = images.map(
    (i: { bucket: string; path: string; size: number }) => ({
      bucket: i.bucket,
      path: i.path,
      size: i.size,
    })
  );

  // Group by bucket for reporting
  const bucketCounts: Record<string, number> = {};
  items.forEach((item) => {
    bucketCounts[item.bucket] = (bucketCounts[item.bucket] || 0) + 1;
  });

  const result = await processBatch(supabase, items, compressionService, concurrency);

  // Group results by bucket
  const resultsByBucket: Record<string, number> = {};
  result.results.forEach((r) => {
    const bucket = items.find((i) => i.path === r.originalPath)?.bucket || "unknown";
    if (
      r.success &&
      !r.compressionMethod?.includes("skipped") &&
      r.compressionMethod !== "no-improvement"
    ) {
      resultsByBucket[bucket] = (resultsByBucket[bucket] || 0) + 1;
    }
  });

  return ok(
    {
      success: true,
      mode: "batch-all",
      buckets: BUCKETS,
      bucketCounts,
      resultsByBucket,
      concurrency,
      ...result,
      duration: Date.now() - startTime,
      circuits: compressionService.getCircuits(),
      results: result.results.map((r) => ({
        bucket: items.find((i) => i.path === r.originalPath)?.bucket,
        path: r.originalPath,
        success: r.success,
        originalSize: r.originalSize,
        compressedSize: r.compressedSize,
        savedPercent:
          r.compressedSize && r.originalSize > r.compressedSize
            ? Math.round((1 - r.compressedSize / r.originalSize) * 100)
            : 0,
        method: r.compressionMethod,
        error: r.error,
        errorType: r.errorType,
      })),
    },
    ctx
  );
}

async function handleUpload(
  ctx: HandlerContext<unknown, ModeQuery>,
  compressionService: CompressionService,
  startTime: number
): Promise<Response> {
  const { request, supabase, query } = ctx;

  if (!checkRateLimit()) {
    throw new RateLimitError("Rate limit exceeded", CONFIG.rateLimit.windowMs / 1000);
  }

  if (!compressionService.hasAvailableProvider()) {
    throw new ServerError("No compression providers available");
  }

  let imageData: Uint8Array;
  let targetBucket = CONFIG.defaultBucket;
  let customPath = "";
  const ct = request.headers.get("content-type") || "";

  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file") as File | null;
    const bucket = form.get("bucket") as string | null;
    const path = form.get("path") as string | null;

    if (!file) {
      throw new ServerError("No file provided");
    }
    imageData = new Uint8Array(await file.arrayBuffer());
    if (bucket && BUCKETS.includes(bucket as Bucket)) targetBucket = bucket;
    if (path) customPath = path;
  } else {
    imageData = new Uint8Array(await request.arrayBuffer());
    const bp = query.bucket || request.headers.get("x-bucket");
    const pp = request.headers.get("x-path");
    if (bp && BUCKETS.includes(bp as Bucket)) targetBucket = bp;
    if (pp) customPath = pp;
  }

  if (!imageData.length) {
    throw new ServerError("Empty file");
  }

  const originalSize = imageData.length;

  // Compress
  const compressed = await compressionService.compress(imageData, `upload:${generateUUID()}`);
  const format = detectFormat(compressed.buffer);

  // Generate filename
  const ext = format === "webp" ? "webp" : format === "jpeg" ? "jpg" : format;
  const fileName = customPath
    ? `${customPath}/${generateUUID().slice(0, 8)}-${Date.now()}.${ext}`
    : `${generateUUID().slice(0, 8)}-${Date.now()}.${ext}`;

  // Upload
  const { data: uploadData, error: upErr } = await supabase.storage
    .from(targetBucket)
    .upload(fileName, compressed.buffer, {
      contentType: `image/${format}`,
      cacheControl: "31536000",
      upsert: false,
    });

  if (upErr) {
    throw new ServerError(upErr.message);
  }

  const processingTimeMs = Date.now() - startTime;
  const savedPercent = ((1 - compressed.buffer.length / originalSize) * 100).toFixed(1);

  // Log result
  await logResult(supabase, targetBucket, {
    success: true,
    originalPath: fileName,
    compressedPath: fileName,
    originalSize,
    compressedSize: compressed.buffer.length,
    compressedFormat: format,
    compressionMethod: compressed.method,
    processingTimeMs,
  });

  logger.info("Upload complete", {
    path: fileName,
    in: formatBytes(originalSize),
    out: formatBytes(compressed.buffer.length),
    saved: savedPercent + "%",
    provider: compressed.provider,
    time: formatDuration(processingTimeMs),
  });

  return ok(
    {
      success: true,
      data: uploadData,
      metadata: {
        originalSize,
        finalSize: compressed.buffer.length,
        savedBytes: originalSize - compressed.buffer.length,
        savedPercent: parseFloat(savedPercent),
        format,
        method: compressed.method,
        provider: compressed.provider,
        bucket: targetBucket,
        path: fileName,
        duration: processingTimeMs,
      },
    },
    ctx
  );
}

// =============================================================================
// Main Handler
// =============================================================================

async function handleImageCompression(ctx: HandlerContext<unknown, ModeQuery>): Promise<Response> {
  const startTime = Date.now();
  const compressionService = createCompressionService();
  const mode = ctx.query.mode || "health";

  logger.info("Image compression request", { mode });

  switch (mode) {
    case "health":
      return handleHealthCheck(ctx, compressionService);
    case "quota":
      return handleQuotaCheck(ctx, compressionService);
    case "providers":
      return handleProviderHealth(ctx, compressionService);
    case "batch":
      return handleBatch(ctx, compressionService, startTime);
    case "batch-all":
      return handleBatchAll(ctx, compressionService, startTime);
    case "upload":
      return handleUpload(ctx, compressionService, startTime);
    default:
      return ok(
        {
          error: "Unknown mode",
          availableModes: ["health", "quota", "providers", "batch", "batch-all", "upload"],
        },
        ctx
      );
  }
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "resize-tinify-upload-image",
  version: CONFIG.version,
  requireAuth: false, // Public health check, rate-limited operations
  routes: {
    GET: {
      querySchema: modeQuerySchema,
      handler: handleImageCompression,
    },
    POST: {
      querySchema: modeQuerySchema,
      handler: handleImageCompression,
    },
  },
});
