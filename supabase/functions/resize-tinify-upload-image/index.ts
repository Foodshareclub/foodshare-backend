/**
 * Smart Image Compress Edge Function v9 (Bundled)
 *
 * This is a bundled version for deployment. The source is componentized in:
 * - lib/config.ts, lib/logger.ts, lib/circuit-breaker.ts, lib/utils.ts, lib/types.ts
 * - services/tinypng.ts, services/cloudinary.ts, services/compressor.ts
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// TYPES
// ============================================================================

interface CompressResult {
  buffer: Uint8Array;
  method: string;
  service: string;
}
interface CompressionResult {
  success: boolean;
  originalPath: string;
  compressedPath?: string;
  originalSize: number;
  compressedSize?: number;
  compressedFormat?: string;
  compressionMethod?: string;
  processingTimeMs: number;
  error?: string;
}
interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}
interface CompressionServices {
  tinifyApiKey?: string;
  cloudinaryConfig?: CloudinaryConfig;
}
interface BatchItem {
  bucket: string;
  path: string;
  size: number;
}
type LogLevel = "info" | "warn" | "error" | "debug";
type CircuitState = "closed" | "open" | "half-open";
interface ServiceCircuit {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
}

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  targetSize: 100 * 1024,
  skipThreshold: 100 * 1024,
  maxBatchSize: 1,
  defaultBucket: "posts",
  widthTiers: [
    { maxOriginalSize: 200 * 1024, width: 1000 },
    { maxOriginalSize: 500 * 1024, width: 900 },
    { maxOriginalSize: 1024 * 1024, width: 800 },
    { maxOriginalSize: 3 * 1024 * 1024, width: 700 },
    { maxOriginalSize: 5 * 1024 * 1024, width: 600 },
    { maxOriginalSize: Infinity, width: 550 },
  ],
  circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 60000, halfOpenMaxAttempts: 1 },
  retry: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 5000 },
} as const;

const STORAGE_BUCKETS = {
  PROFILES: "profiles",
  POSTS: "posts",
  FLAGS: "flags",
  FORUM: "forum",
  CHALLENGES: "challenges",
  ROOMS: "rooms",
  ASSETS: "assets",
} as const;
type StorageBucketKey = keyof typeof STORAGE_BUCKETS;
type StorageBucket = (typeof STORAGE_BUCKETS)[StorageBucketKey];
const MAX_FILE_SIZES: Record<StorageBucketKey, number> = {
  PROFILES: 5 * 1024 * 1024,
  POSTS: 10 * 1024 * 1024,
  FLAGS: 2 * 1024 * 1024,
  FORUM: 10 * 1024 * 1024,
  CHALLENGES: 5 * 1024 * 1024,
  ROOMS: 5 * 1024 * 1024,
  ASSETS: 50 * 1024 * 1024,
};
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "3600",
};

// ============================================================================
// LOGGER
// ============================================================================

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry = { timestamp: new Date().toISOString(), level, message, ...context };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
function formatBytes(b: number): string {
  return b < 1024
    ? `${b}B`
    : b < 1024 * 1024
      ? `${(b / 1024).toFixed(1)}KB`
      : `${(b / 1024 / 1024).toFixed(2)}MB`;
}
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

const circuits: Record<string, ServiceCircuit> = {
  tinypng: { state: "closed", failures: 0, lastFailureTime: 0, halfOpenAttempts: 0 },
  cloudinary: { state: "closed", failures: 0, lastFailureTime: 0, halfOpenAttempts: 0 },
};

function getCircuitState(service: string): CircuitState {
  const c = circuits[service];
  if (!c) return "closed";
  if (
    c.state === "open" &&
    Date.now() - c.lastFailureTime >= CONFIG.circuitBreaker.resetTimeoutMs
  ) {
    c.state = "half-open";
    c.halfOpenAttempts = 0;
    log("info", "Circuit breaker state change", { service, from: "open", to: "half-open" });
  }
  return c.state;
}
function recordSuccess(service: string): void {
  const c = circuits[service];
  if (!c) return;
  const prev = c.state;
  c.state = "closed";
  c.failures = 0;
  c.halfOpenAttempts = 0;
  if (prev === "half-open") log("info", "Circuit breaker recovered", { service });
}
function recordFailure(service: string): void {
  const c = circuits[service];
  if (!c) return;
  c.failures++;
  c.lastFailureTime = Date.now();
  if (c.state === "half-open" || c.failures >= CONFIG.circuitBreaker.failureThreshold) {
    c.state = "open";
    log("warn", "Circuit breaker opened", { service, failures: c.failures });
  }
}
function canAttempt(service: string): boolean {
  const s = getCircuitState(service);
  if (s === "closed") return true;
  if (s === "open") return false;
  const c = circuits[service];
  if (c.halfOpenAttempts < CONFIG.circuitBreaker.halfOpenMaxAttempts) {
    c.halfOpenAttempts++;
    return true;
  }
  return false;
}

// ============================================================================
// UTILS
// ============================================================================

function detectFormat(d: Uint8Array): string {
  if (d[0] === 0xff && d[1] === 0xd8) return "jpeg";
  if (d[0] === 0x89 && d[1] === 0x50) return "png";
  if (d[0] === 0x47 && d[1] === 0x49) return "gif";
  if (d[0] === 0x52 && d[1] === 0x49) return "webp";
  return "jpeg";
}
function getBucketKey(bucket: string): StorageBucketKey {
  return (Object.keys(STORAGE_BUCKETS).find(
    (k) => STORAGE_BUCKETS[k as StorageBucketKey] === bucket
  ) || "POSTS") as StorageBucketKey;
}
function getSmartWidth(size: number): number {
  for (const t of CONFIG.widthTiers) if (size <= t.maxOriginalSize) return t.width;
  return 500;
}
function generateUUID(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status,
  });
}

// ============================================================================
// TINYPNG SERVICE
// ============================================================================

async function compressWithTinyPNG(
  imageData: Uint8Array,
  apiKey: string,
  targetWidth: number
): Promise<CompressResult> {
  const startTime = Date.now();
  const auth = "Basic " + btoa(`api:${apiKey}`);
  const compressRes = await fetch("https://api.tinify.com/shrink", {
    method: "POST",
    headers: { Authorization: auth },
    body: imageData,
  });
  if (!compressRes.ok) {
    const e = await compressRes.text();
    throw new Error(
      compressRes.status === 429
        ? `TinyPNG rate limited: ${e}`
        : `TinyPNG failed (${compressRes.status}): ${e}`
    );
  }
  const result = await compressRes.json();
  log("debug", "TinyPNG initial compression", {
    service: "tinypng",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(result.output.size),
    duration: formatDuration(Date.now() - startTime),
  });
  const resizeRes = await fetch(result.output.url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ resize: { method: "fit", width: targetWidth, height: targetWidth } }),
  });
  if (!resizeRes.ok) {
    log("warn", "TinyPNG resize failed", { service: "tinypng" });
    const dl = await fetch(result.output.url, { headers: { Authorization: auth } });
    return {
      buffer: new Uint8Array(await dl.arrayBuffer()),
      method: "tinypng",
      service: "tinypng",
    };
  }
  const buf = new Uint8Array(await resizeRes.arrayBuffer());
  log("info", "TinyPNG compression complete", {
    service: "tinypng",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(buf.length),
    targetWidth,
    savedPercent: ((1 - buf.length / imageData.length) * 100).toFixed(1),
    duration: formatDuration(Date.now() - startTime),
  });
  return { buffer: buf, method: `tinypng@${targetWidth}px`, service: "tinypng" };
}

// ============================================================================
// CLOUDINARY SERVICE
// ============================================================================

async function createSig(params: Record<string, string>, secret: string): Promise<string> {
  const str = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str + secret));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function compressWithCloudinary(
  imageData: Uint8Array,
  config: CloudinaryConfig,
  targetWidth: number
): Promise<CompressResult> {
  const startTime = Date.now();
  const ts = Math.floor(Date.now() / 1000).toString();
  const publicId = `temp_compress_${generateUUID().slice(0, 8)}`;
  const transform = `q_auto:good,f_auto,w_${targetWidth},c_limit`;
  const sig = await createSig(
    { public_id: publicId, timestamp: ts, transformation: transform },
    config.apiSecret
  );
  const form = new FormData();
  form.append("file", new Blob([imageData], { type: "image/jpeg" }));
  form.append("api_key", config.apiKey);
  form.append("timestamp", ts);
  form.append("signature", sig);
  form.append("public_id", publicId);
  form.append("transformation", transform);
  const uploadRes = await fetch(
    `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`,
    { method: "POST", body: form }
  );
  if (!uploadRes.ok)
    throw new Error(`Cloudinary upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  const uploadResult = await uploadRes.json();
  log("debug", "Cloudinary upload complete", {
    service: "cloudinary",
    publicId,
    duration: formatDuration(Date.now() - startTime),
  });
  const dlRes = await fetch(uploadResult.secure_url);
  if (!dlRes.ok) throw new Error(`Cloudinary download failed: ${dlRes.status}`);
  const buf = new Uint8Array(await dlRes.arrayBuffer());
  log("info", "Cloudinary compression complete", {
    service: "cloudinary",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(buf.length),
    targetWidth,
    savedPercent: ((1 - buf.length / imageData.length) * 100).toFixed(1),
    duration: formatDuration(Date.now() - startTime),
  });
  // Cleanup (fire and forget)
  (async () => {
    try {
      const delTs = Math.floor(Date.now() / 1000).toString();
      const delSig = await createSig({ public_id: publicId, timestamp: delTs }, config.apiSecret);
      const delForm = new FormData();
      delForm.append("public_id", publicId);
      delForm.append("api_key", config.apiKey);
      delForm.append("timestamp", delTs);
      delForm.append("signature", delSig);
      await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`, {
        method: "POST",
        body: delForm,
      });
    } catch {}
  })();
  return { buffer: buf, method: `cloudinary@${targetWidth}px`, service: "cloudinary" };
}

// ============================================================================
// COMPRESSOR (RACE)
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  service: string,
  max = CONFIG.retry.maxAttempts
): Promise<T> {
  let err: Error | null = null;
  for (let i = 1; i <= max; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
      if (i < max) {
        const d = Math.min(CONFIG.retry.baseDelayMs * Math.pow(2, i - 1), CONFIG.retry.maxDelayMs);
        log("warn", "Retry failed", { service, attempt: i, error: err.message, nextRetryMs: d });
        await new Promise((r) => setTimeout(r, d));
      }
    }
  }
  throw err || new Error(`${service} failed`);
}

type RaceOutcome =
  | { success: true; result: CompressResult; finishTime: number }
  | { success: false; error: string; service: string; finishTime: number };

async function wrapAttempt(
  service: string,
  fn: () => Promise<CompressResult>,
  start: number
): Promise<RaceOutcome> {
  try {
    const r = await fn();
    recordSuccess(service);
    return { success: true, result: r, finishTime: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    recordFailure(service);
    return { success: false, error: msg, service, finishTime: Date.now() - start };
  }
}

async function raceForSuccess(
  promises: Promise<RaceOutcome>[]
): Promise<
  | { success: true; result: CompressResult; winnerTime: number }
  | { success: false; errors: string[] }
> {
  if (!promises.length) return { success: false, errors: ["No services"] };
  const errors: string[] = [];
  let resolved = 0,
    hasWinner = false;
  return new Promise((resolve) => {
    promises.forEach((p) =>
      p.then((o) => {
        resolved++;
        if (o.success && !hasWinner) {
          hasWinner = true;
          resolve({ success: true, result: o.result, winnerTime: o.finishTime });
        } else if (!o.success) {
          errors.push(`${o.service}: ${o.error}`);
          log("warn", "Race participant failed", { service: o.service, error: o.error });
          if (resolved === promises.length && !hasWinner) resolve({ success: false, errors });
        }
      })
    );
  });
}

async function smartCompress(
  imageData: Uint8Array,
  services: CompressionServices
): Promise<CompressResult> {
  const start = Date.now(),
    size = imageData.length,
    width = getSmartWidth(size);
  log("info", "Starting compression race", {
    inputSize: formatBytes(size),
    targetWidth: width,
    tinypngAvailable: !!services.tinifyApiKey && canAttempt("tinypng"),
    cloudinaryAvailable: !!services.cloudinaryConfig && canAttempt("cloudinary"),
  });
  const attempts: Promise<RaceOutcome>[] = [];
  if (services.tinifyApiKey && canAttempt("tinypng"))
    attempts.push(
      wrapAttempt(
        "tinypng",
        () =>
          withRetry(() => compressWithTinyPNG(imageData, services.tinifyApiKey!, width), "tinypng"),
        start
      )
    );
  if (services.cloudinaryConfig && canAttempt("cloudinary"))
    attempts.push(
      wrapAttempt(
        "cloudinary",
        () =>
          withRetry(
            () => compressWithCloudinary(imageData, services.cloudinaryConfig!, width),
            "cloudinary"
          ),
        start
      )
    );
  if (!attempts.length) throw new Error("No compression services available");
  const outcome = await raceForSuccess(attempts);
  if (outcome.success) {
    log("info", "Compression race complete", {
      winner: outcome.result.service,
      winnerTime: formatDuration(outcome.winnerTime),
      inputSize: formatBytes(size),
      outputSize: formatBytes(outcome.result.buffer.length),
      savedPercent: ((1 - outcome.result.buffer.length / size) * 100).toFixed(1),
    });
    return outcome.result;
  }
  throw new Error(`All services failed: ${outcome.errors.join("; ")}`);
}

// ============================================================================
// DB LOGGING
// ============================================================================

async function logCompressionResult(
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
    log("warn", "Failed to log result", { error: String(e) });
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

async function processBatch(
  supabase: SupabaseClient,
  items: BatchItem[],
  services: CompressionServices
): Promise<{ processed: number; failed: number; skipped: number; results: CompressionResult[] }> {
  const batchStart = Date.now(),
    results: CompressionResult[] = [];
  let processed = 0,
    failed = 0,
    skipped = 0;
  log("info", "Batch processing started", { itemCount: items.length });
  for (const item of items) {
    const start = Date.now();
    try {
      const { data: fileData, error: dlErr } = await supabase.storage
        .from(item.bucket)
        .download(item.path);
      if (dlErr || !fileData) throw new Error(`Download failed: ${dlErr?.message || "No data"}`);
      const imageData = new Uint8Array(await fileData.arrayBuffer());
      if (imageData.length <= CONFIG.skipThreshold) {
        const r: CompressionResult = {
          success: true,
          originalPath: item.path,
          compressedPath: item.path,
          originalSize: imageData.length,
          compressedSize: imageData.length,
          compressionMethod: "skipped",
          processingTimeMs: Date.now() - start,
        };
        results.push(r);
        await logCompressionResult(supabase, item.bucket, r);
        skipped++;
        log("info", "Image skipped - already small", { path: item.path });
        continue;
      }
      const compressed = await smartCompress(imageData, services);
      const format = detectFormat(compressed.buffer);
      if (compressed.buffer.length >= imageData.length) {
        const r: CompressionResult = {
          success: true,
          originalPath: item.path,
          compressedPath: item.path,
          originalSize: imageData.length,
          compressedSize: imageData.length,
          compressionMethod: "no-improvement",
          processingTimeMs: Date.now() - start,
        };
        results.push(r);
        await logCompressionResult(supabase, item.bucket, r);
        skipped++;
        continue;
      }
      const { error: upErr } = await supabase.storage
        .from(item.bucket)
        .update(item.path, compressed.buffer, {
          contentType: `image/${format}`,
          cacheControl: "31536000",
          upsert: true,
        });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
      const r: CompressionResult = {
        success: true,
        originalPath: item.path,
        compressedPath: item.path,
        originalSize: imageData.length,
        compressedSize: compressed.buffer.length,
        compressedFormat: format,
        compressionMethod: compressed.method,
        processingTimeMs: Date.now() - start,
      };
      results.push(r);
      await logCompressionResult(supabase, item.bucket, r);
      processed++;
      log("info", "Image compressed", {
        path: item.path,
        originalSize: formatBytes(imageData.length),
        compressedSize: formatBytes(compressed.buffer.length),
        service: compressed.service,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown";
      const r: CompressionResult = {
        success: false,
        originalPath: item.path,
        originalSize: item.size,
        processingTimeMs: Date.now() - start,
        error: msg,
      };
      results.push(r);
      await logCompressionResult(supabase, item.bucket, r);
      failed++;
      log("error", "Compression failed", { path: item.path, error: msg });
    }
  }
  log("info", "Batch complete", {
    processed,
    failed,
    skipped,
    duration: formatDuration(Date.now() - batchStart),
  });
  return { processed, failed, skipped, results };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders, status: 204 });
  const requestId = generateUUID().slice(0, 8),
    startTime = Date.now();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!,
      supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;
    const tinifyApiKey = Deno.env.get("TINIFY_API_KEY"),
      cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME"),
      cloudKey = Deno.env.get("CLOUDINARY_API_KEY"),
      cloudSecret = Deno.env.get("CLOUDINARY_API_SECRET");
    if (!supabaseUrl || !supabaseKey) {
      log("error", "Config error", { requestId });
      return jsonResponse({ error: "Server configuration error" }, 500);
    }
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const services: CompressionServices = {};
    if (tinifyApiKey) services.tinifyApiKey = tinifyApiKey;
    if (cloudName && cloudKey && cloudSecret)
      services.cloudinaryConfig = { cloudName, apiKey: cloudKey, apiSecret: cloudSecret };
    const url = new URL(req.url),
      mode = url.searchParams.get("mode") || "upload";
    log("info", "Request started", {
      requestId,
      mode,
      servicesAvailable: {
        tinypng: !!services.tinifyApiKey,
        cloudinary: !!services.cloudinaryConfig,
      },
    });

    if (mode === "stats") {
      const { data: stats, error } = await supabase.from("compression_stats").select("*");
      if (error) return jsonResponse({ error: error.message }, 500);
      return jsonResponse(
        {
          success: true,
          stats,
          circuitBreakers: {
            tinypng: { state: getCircuitState("tinypng"), failures: circuits.tinypng.failures },
            cloudinary: {
              state: getCircuitState("cloudinary"),
              failures: circuits.cloudinary.failures,
            },
          },
          servicesConfigured: {
            tinypng: !!services.tinifyApiKey,
            cloudinary: !!services.cloudinaryConfig,
          },
        },
        200
      );
    }

    if (!services.tinifyApiKey && !services.cloudinaryConfig)
      return jsonResponse({ error: "No compression service configured" }, 500);

    if (mode === "batch") {
      const bucket = url.searchParams.get("bucket") || CONFIG.defaultBucket,
        limit = Math.min(parseInt(url.searchParams.get("limit") || "1"), 10),
        minSize = parseInt(url.searchParams.get("minSize") || String(CONFIG.skipThreshold));
      const { data: images, error } = await supabase.rpc("get_large_uncompressed_images", {
        target_bucket: bucket,
        size_threshold_bytes: minSize,
        max_results: limit,
      });
      if (error) return jsonResponse({ error: `Query failed: ${error.message}` }, 500);
      if (!images?.length) {
        log("info", "No images", { requestId });
        return jsonResponse(
          { success: true, message: "No large images found", processed: 0, failed: 0, skipped: 0 },
          200
        );
      }
      const items: BatchItem[] = images.map(
        (i: { bucket: string; path: string; size: number }) => ({
          bucket: i.bucket,
          path: i.path,
          size: i.size,
        })
      );
      const { processed, failed, skipped, results } = await processBatch(supabase, items, services);
      const totalSaved = results
        .filter((r) => r.success && r.compressedSize && r.compressionMethod?.includes("@"))
        .reduce((s, r) => s + (r.originalSize - (r.compressedSize || 0)), 0);
      log("info", "Batch request complete", {
        requestId,
        processed,
        failed,
        skipped,
        totalSavedBytes: formatBytes(totalSaved),
        duration: formatDuration(Date.now() - startTime),
      });
      return jsonResponse(
        {
          success: true,
          mode: "batch",
          bucket,
          processed,
          failed,
          skipped,
          totalSavedBytes: totalSaved,
          duration: Date.now() - startTime,
          circuitBreakers: {
            tinypng: getCircuitState("tinypng"),
            cloudinary: getCircuitState("cloudinary"),
          },
          results: results.map((r) => ({
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
          })),
        },
        200
      );
    }

    // UPLOAD mode
    let imageData: Uint8Array,
      targetBucket = CONFIG.defaultBucket,
      customPath = "";
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData(),
        file = form.get("file") as File | null,
        bucket = form.get("bucket") as string | null,
        path = form.get("path") as string | null;
      if (!file) return jsonResponse({ error: "No file provided" }, 400);
      imageData = new Uint8Array(await file.arrayBuffer());
      if (bucket && Object.values(STORAGE_BUCKETS).includes(bucket as StorageBucket))
        targetBucket = bucket;
      if (path) customPath = path;
    } else {
      imageData = new Uint8Array(await req.arrayBuffer());
      const bp = url.searchParams.get("bucket") || req.headers.get("x-bucket"),
        pp = url.searchParams.get("path") || req.headers.get("x-path");
      if (bp && Object.values(STORAGE_BUCKETS).includes(bp as StorageBucket)) targetBucket = bp;
      if (pp) customPath = pp;
    }
    if (!imageData.length) return jsonResponse({ error: "Empty file" }, 400);
    const originalSize = imageData.length;
    log("info", "Processing upload", {
      requestId,
      size: formatBytes(originalSize),
      bucket: targetBucket,
    });
    const compressed = await smartCompress(imageData, services);
    const format = detectFormat(compressed.buffer);
    const bucketKey = getBucketKey(targetBucket);
    if (compressed.buffer.length > MAX_FILE_SIZES[bucketKey])
      return jsonResponse({ error: `File too large for bucket ${targetBucket}` }, 400);
    const ext = format === "webp" ? "webp" : format === "jpeg" ? "jpg" : format;
    const fileName = customPath
      ? `${customPath}/${generateUUID().slice(0, 8)}-${Date.now()}.${ext}`
      : `${generateUUID().slice(0, 8)}-${Date.now()}.${ext}`;
    const { data: uploadData, error: upErr } = await supabase.storage
      .from(targetBucket)
      .upload(fileName, compressed.buffer, {
        contentType: `image/${format}`,
        cacheControl: "31536000",
        upsert: false,
      });
    if (upErr) return jsonResponse({ error: upErr.message }, 400);
    const result: CompressionResult = {
      success: true,
      originalPath: fileName,
      compressedPath: fileName,
      originalSize,
      compressedSize: compressed.buffer.length,
      compressedFormat: format,
      compressionMethod: compressed.method,
      processingTimeMs: Date.now() - startTime,
    };
    await logCompressionResult(supabase, targetBucket, result);
    const savedPercent = ((1 - compressed.buffer.length / originalSize) * 100).toFixed(1);
    log("info", "Upload complete", {
      requestId,
      path: fileName,
      originalSize: formatBytes(originalSize),
      compressedSize: formatBytes(compressed.buffer.length),
      savedPercent,
      service: compressed.service,
      duration: formatDuration(Date.now() - startTime),
    });
    return jsonResponse(
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
          service: compressed.service,
          bucket: targetBucket,
          path: fileName,
          duration: Date.now() - startTime,
        },
      },
      200
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown";
    log("error", "Request failed", {
      requestId,
      error: msg,
      duration: formatDuration(Date.now() - startTime),
    });
    return jsonResponse({ error: msg }, 500);
  }
});
