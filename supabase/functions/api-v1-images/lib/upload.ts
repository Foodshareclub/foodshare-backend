/**
 * Image upload handlers — single and batch uploads.
 */

import { type HandlerContext, ok } from "../../_shared/api-handler.ts";
import { PayloadTooLargeError, RateLimitError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import { extractEXIF, getImageDimensions } from "../services/exif.ts";
import { compressImage, generateThumbnail } from "../../_shared/compression/index.ts";
import { analyzeImage } from "../services/ai.ts";
import { detectFormat, logUploadMetrics } from "../../_shared/image-utils.ts";
import { ALLOWED_BUCKETS, checkRateLimit, uploadWithFallback } from "./storage.ts";
import type { BatchUploadResponse, ImageUploadResponse } from "../types/index.ts";

/**
 * Single image upload handler.
 * Uses ctx.supabase and ctx.userId from createAPIHandler auth.
 */
export async function handleUpload(ctx: HandlerContext): Promise<Response> {
  const startTime = Date.now();

  const formData = await ctx.request.formData();
  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string) || "food-images";
  const customPath = formData.get("path") as string | null;
  const generateThumb = formData.get("generateThumbnail") !== "false";
  const extractEXIFData = formData.get("extractEXIF") !== "false";
  const enableAI = formData.get("enableAI") === "true";

  if (!file) {
    throw new ValidationError("No file provided");
  }

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    throw new ValidationError(`Invalid bucket: ${bucket}`);
  }

  if (file.size > 10 * 1024 * 1024) {
    throw new PayloadTooLargeError("File too large (max 10MB)", 10 * 1024 * 1024);
  }

  const { supabase, userId } = ctx;

  if (userId) {
    const allowed = await checkRateLimit(userId, supabase);
    if (!allowed) {
      throw new RateLimitError("Maximum 100 uploads per day");
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
    supabase,
    bucket,
    path,
    compressed.buffer,
    `image/${format}`,
  );

  let thumbnailUrl: string | undefined;
  let thumbnailPath: string | undefined;
  if (thumbnailBuffer) {
    const thumbFilename = `${crypto.randomUUID()}_thumb.jpg`;
    const thumbPath = customPath
      ? `${customPath.replace(/\.[^.]+$/, "")}_thumb.jpg`
      : thumbFilename;

    try {
      const thumbResult = await uploadWithFallback(
        supabase,
        bucket,
        thumbPath,
        thumbnailBuffer,
        "image/jpeg",
      );
      thumbnailUrl = thumbResult.publicUrl;
      thumbnailPath = thumbPath;
    } catch (error) {
      logger.error(
        "Thumbnail upload failed",
        error instanceof Error ? error : new Error(String(error)),
      );
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

  return ok(response, ctx);
}

/**
 * Batch image upload handler.
 */
export async function handleBatchUpload(ctx: HandlerContext): Promise<Response> {
  const startTime = Date.now();

  const formData = await ctx.request.formData();
  const bucket = (formData.get("bucket") as string) || "food-images";

  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("file") && value instanceof File) {
      files.push(value);
    }
  }

  if (files.length === 0) {
    throw new ValidationError("No files provided");
  }

  const results: ImageUploadResponse[] = [];
  let succeeded = 0;
  let failed = 0;
  let totalSavedBytes = 0;

  for (const file of files) {
    try {
      const mockReq = new Request(ctx.request.url, {
        method: "POST",
        headers: ctx.request.headers,
        body: (() => {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("bucket", bucket);
          return fd;
        })(),
      });

      // Create a sub-context for each file upload
      const subCtx: HandlerContext = { ...ctx, request: mockReq };
      const result = await handleUpload(subCtx);
      const data = await result.clone().json() as ImageUploadResponse;

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

  return ok(response, ctx);
}
