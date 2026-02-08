/**
 * Enterprise Image API v1
 *
 * Unified image processing endpoint for all features:
 * - Listings, Forum, Profiles, Challenges
 *
 * Features:
 * - Smart compression (TinyPNG/Cloudinary)
 * - EXIF extraction (GPS, timestamp, camera)
 * - Thumbnail generation
 * - AI food detection (optional)
 * - Batch upload support
 * - Orphan cleanup
 * - Recompression
 * - External URL upload
 *
 * Routes:
 * - POST /upload           - Single image upload
 * - POST /batch            - Batch image upload
 * - POST /proxy            - Proxy external image
 * - POST /upload-from-url  - Download and upload external image
 * - POST /cleanup          - Cleanup orphan images (cron)
 * - POST /recompress       - Recompress old images (cron)
 * - GET  /health           - Health check
 *
 * @module api-v1-images
 * @version 2.0.0
 */

import { getSupabaseClient } from "../_shared/supabase.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { AppError, ServerError } from "../_shared/errors.ts";
import { parseRoute } from "../_shared/routing.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractEXIF, getImageDimensions } from "./services/exif.ts";
import { compressImage, generateThumbnail } from "../_shared/compression/index.ts";
import { analyzeImage } from "./services/ai.ts";
import { isR2Configured, uploadToR2 } from "../_shared/r2-storage.ts";
import { validateImageUrl } from "../_shared/url-validation.ts";
import { detectFormat, downloadImage, logUploadMetrics } from "../_shared/image-utils.ts";
import { cleanupOrphanImages } from "./services/cleanup.ts";
import { recompressOldImages } from "./services/recompression.ts";
import type {
  ImageUploadResponse,
  BatchUploadResponse,
} from "./types/index.ts";

const VERSION = "2.0.0";
const SERVICE = "api-v1-images";
const ALLOWED_BUCKETS = ["food-images", "profiles", "forum", "challenges", "rooms", "assets", "avatars", "posts"];

// Rate limiting: 100 uploads per user per day
const RATE_LIMIT_KEY = "image_upload_count";
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 86400; // 24 hours

// deno-lint-ignore no-explicit-any
async function checkRateLimit(userId: string, supabase: any): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_rate_limits")
    .select("count, reset_at")
    .eq("user_id", userId)
    .eq("key", RATE_LIMIT_KEY)
    .single();

  if (error || !data) {
    await supabase.from("user_rate_limits").insert({
      user_id: userId,
      key: RATE_LIMIT_KEY,
      count: 1,
      reset_at: new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString(),
    });
    return true;
  }

  if (new Date(data.reset_at) < new Date()) {
    await supabase.from("user_rate_limits")
      .update({
        count: 1,
        reset_at: new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString(),
      })
      .eq("user_id", userId)
      .eq("key", RATE_LIMIT_KEY);
    return true;
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return false;
  }

  await supabase.from("user_rate_limits")
    .update({ count: data.count + 1 })
    .eq("user_id", userId)
    .eq("key", RATE_LIMIT_KEY);

  return true;
}

async function uploadWithFallback(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  bucket: string,
  path: string,
  buffer: Uint8Array,
  contentType: string
): Promise<{ publicUrl: string; storage: "r2" | "supabase" }> {
  if (isR2Configured()) {
    const r2Path = `${bucket}/${path}`;
    const result = await uploadToR2(buffer, r2Path, contentType);
    if (result.success) {
      return { publicUrl: result.publicUrl, storage: "r2" };
    }
    logger.error("R2 upload failed, falling back to Supabase", new Error(result.error));
  }

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType,
      cacheControl: "31536000",
      upsert: true,
    });

  if (uploadError) {
    throw new ServerError(`Upload failed: ${uploadError.message}`);
  }

  const publicUrl = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  return { publicUrl, storage: "supabase" };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}

// =============================================================================
// Upload Handlers
// =============================================================================

async function handleUpload(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string) || "food-images";
  const customPath = formData.get("path") as string | null;
  const generateThumb = formData.get("generateThumbnail") !== "false";
  const extractEXIFData = formData.get("extractEXIF") !== "false";
  const enableAI = formData.get("enableAI") === "true";

  if (!file) {
    return jsonResponse({ error: "No file provided" }, 400, corsHeaders);
  }

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return jsonResponse({ error: `Invalid bucket: ${bucket}` }, 400, corsHeaders);
  }

  if (file.size > 10 * 1024 * 1024) {
    return jsonResponse({ error: "File too large (max 10MB)" }, 400, corsHeaders);
  }

  const supabase = getSupabaseClient();

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  let userId: string | null = null;

  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token);
    userId = user?.id || null;

    if (userId) {
      const allowed = await checkRateLimit(userId, supabase);
      if (!allowed) {
        return jsonResponse({
          error: "Rate limit exceeded. Maximum 100 uploads per day."
        }, 429, corsHeaders);
      }
    }
  }

  const imageData = new Uint8Array(await file.arrayBuffer());
  const originalSize = imageData.length;

  const exif = extractEXIFData ? await extractEXIF(imageData) : null;
  const dimensions = getImageDimensions(imageData);
  const compressed = await compressImage(imageData, 800);

  let thumbnailBuffer: Uint8Array | null = null;
  if (generateThumb) {
    thumbnailBuffer = await generateThumbnail(imageData, 300);
  }

  const format = detectFormat(compressed.buffer);
  const filename = `${crypto.randomUUID()}.${format}`;
  const path = customPath || filename;

  const { publicUrl, storage } = await uploadWithFallback(
    supabase, bucket, path, compressed.buffer, `image/${format}`
  );

  let thumbnailUrl: string | undefined;
  let thumbnailPath: string | undefined;
  if (thumbnailBuffer) {
    const thumbFilename = `${crypto.randomUUID()}_thumb.jpg`;
    const thumbPath = customPath ? `${customPath.replace(/\.[^.]+$/, '')}_thumb.jpg` : thumbFilename;

    try {
      const thumbResult = await uploadWithFallback(
        supabase, bucket, thumbPath, thumbnailBuffer, "image/jpeg"
      );
      thumbnailUrl = thumbResult.publicUrl;
      thumbnailPath = thumbPath;
    } catch (error) {
      logger.error("Thumbnail upload failed", error instanceof Error ? error : new Error(String(error)));
    }
  }

  let ai = null;
  if (enableAI) {
    try {
      ai = await analyzeImage(publicUrl);
    } catch (error) {
      logger.error("AI analysis failed", error instanceof Error ? error : new Error(String(error)));
    }
  }

  const processingTime = Date.now() - startTime;

  const response: ImageUploadResponse = {
    success: true,
    data: {
      url: publicUrl,
      path,
      thumbnailUrl,
      thumbnailPath,
    },
    metadata: {
      originalSize,
      finalSize: compressed.compressedSize,
      savedBytes: compressed.savedPercent > 0 ? originalSize - compressed.compressedSize : 0,
      savedPercent: compressed.savedPercent,
      format: detectFormat(compressed.buffer),
      dimensions: dimensions || undefined,
      exif: exif || undefined,
      ai: ai || undefined,
      processingTime,
      compressionMethod: compressed.method,
      storage,
    },
  };

  await logUploadMetrics(supabase, {
    userId,
    bucket,
    path,
    originalSize,
    compressedSize: compressed.compressedSize,
    savedBytes: originalSize - compressed.compressedSize,
    compressionMethod: compressed.method,
    processingTime,
    storage,
  });

  return jsonResponse(response, 200, corsHeaders);
}

async function handleBatchUpload(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();

  const formData = await req.formData();
  const bucket = (formData.get("bucket") as string) || "food-images";

  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("file") && value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    return jsonResponse({ error: "No files provided" }, 400, corsHeaders);
  }

  const results: ImageUploadResponse[] = [];
  let succeeded = 0;
  let failed = 0;
  let totalSavedBytes = 0;

  for (const file of files) {
    try {
      const mockReq = new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: (() => {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("bucket", bucket);
          return fd;
        })(),
      });

      const result = await handleUpload(mockReq, corsHeaders);
      const data = await result.json() as ImageUploadResponse;

      results.push(data);
      succeeded++;
      totalSavedBytes += data.metadata.savedBytes;
    } catch (error) {
      failed++;
      logger.error("Batch upload error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  const response: BatchUploadResponse = {
    success: failed === 0,
    results,
    summary: {
      total: files.length,
      succeeded,
      failed,
      totalSavedBytes,
      processingTime: Date.now() - startTime,
    },
  };

  return jsonResponse(response, 200, corsHeaders);
}

async function handleProxy(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await req.json();
  const imageUrl = body.url;
  const bucket = body.bucket || "assets";

  if (!imageUrl) {
    return jsonResponse({ error: "Missing 'url' field" }, 400, corsHeaders);
  }

  const urlValidation = validateImageUrl(imageUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: `Invalid image URL: ${urlValidation.reason}` }, 400, corsHeaders);
  }

  const response = await fetch(imageUrl, {
    headers: { "User-Agent": "FoodShare-ImageAPI/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    return jsonResponse({ error: `Failed to fetch: ${response.status}` }, 400, corsHeaders);
  }

  const imageData = new Uint8Array(await response.arrayBuffer());

  if (imageData.length > 10 * 1024 * 1024) {
    return jsonResponse({ error: "Image too large (max 10MB)" }, 400, corsHeaders);
  }

  const supabase = getSupabaseClient();

  const compressed = await compressImage(imageData, 800);
  const format = detectFormat(compressed.buffer);
  const filename = `${crypto.randomUUID()}.${format}`;

  const { publicUrl, storage } = await uploadWithFallback(
    supabase, bucket, filename, compressed.buffer, `image/${format}`
  );

  return jsonResponse({
    success: true,
    data: {
      url: publicUrl,
      path: filename,
      originalUrl: imageUrl,
    },
    metadata: {
      originalSize: imageData.length,
      compressedSize: compressed.compressedSize,
      savedBytes: imageData.length - compressed.compressedSize,
      savedPercent: compressed.savedPercent,
      format,
      storage,
    },
  }, 200, corsHeaders);
}

async function handleUploadFromUrl(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();

  const body = await req.json();
  const imageUrl = body.imageUrl || body.url;
  const bucket = body.bucket || "challenges";
  const customPath = body.path;
  const challengeId = body.challengeId;

  if (!imageUrl) {
    return jsonResponse({ error: "Missing imageUrl" }, 400, corsHeaders);
  }

  const supabase = getSupabaseClient();

  const imageData = await downloadImage(imageUrl);

  if (imageData.length > 10 * 1024 * 1024) {
    return jsonResponse({ error: "Image too large (max 10MB)" }, 400, corsHeaders);
  }

  const originalSize = imageData.length;
  const compressed = await compressImage(imageData, 800);
  const format = detectFormat(compressed.buffer);
  const filename = customPath || `${crypto.randomUUID()}.${format}`;

  const { publicUrl, storage } = await uploadWithFallback(
    supabase, bucket, filename, compressed.buffer, `image/${format}`
  );

  if (challengeId) {
    await supabase
      .from("challenges")
      .update({ challenge_image: publicUrl })
      .eq("id", challengeId);
  }

  const processingTime = Date.now() - startTime;

  await logUploadMetrics(supabase, {
    userId: null,
    bucket,
    path: filename,
    originalSize,
    compressedSize: compressed.compressedSize,
    savedBytes: originalSize - compressed.compressedSize,
    compressionMethod: compressed.method,
    processingTime,
    storage,
  });

  return jsonResponse({
    success: true,
    challengeId,
    publicUrl,
    filePath: filename,
    metadata: {
      originalSize,
      compressedSize: compressed.compressedSize,
      savedBytes: originalSize - compressed.compressedSize,
      storage,
    },
  }, 200, corsHeaders);
}

async function handleCleanup(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = req.headers.get("authorization");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const body = await req.json().catch(() => ({}));

  const supabase = getSupabaseClient();

  const stats = await cleanupOrphanImages(supabase, {
    gracePeriodHours: body.gracePeriodHours,
    batchSize: body.batchSize,
    dryRun: body.dryRun,
  });

  return jsonResponse({ success: true, ...stats }, 200, corsHeaders);
}

async function handleRecompress(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = req.headers.get("authorization");

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const body = await req.json().catch(() => ({}));

  const supabase = getSupabaseClient();

  const results = await recompressOldImages(supabase, {
    batchSize: body.batchSize,
    cutoffDate: body.cutoffDate,
  });

  return jsonResponse({
    success: true,
    version: VERSION,
    service: SERVICE,
    results,
  }, 200, corsHeaders);
}

// =============================================================================
// Route Handlers for createAPIHandler
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      r2: isR2Configured(),
    }, ctx);
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  switch (route.resource) {
    case "upload":
      return await handleUpload(ctx.request, ctx.corsHeaders);
    case "batch":
      return await handleBatchUpload(ctx.request, ctx.corsHeaders);
    case "proxy":
      return await handleProxy(ctx.request, ctx.corsHeaders);
    case "upload-from-url":
      return await handleUploadFromUrl(ctx.request, ctx.corsHeaders);
    case "cleanup":
      return await handleCleanup(ctx.request, ctx.corsHeaders);
    case "recompress":
      return await handleRecompress(ctx.request, ctx.corsHeaders);
    default:
      throw new AppError("Not found", "NOT_FOUND", 404);
  }
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
