/**
 * Image proxy and URL upload handlers.
 */

import { type HandlerContext, ok } from "../../_shared/api-handler.ts";
import { PayloadTooLargeError, ValidationError } from "../../_shared/errors.ts";
import { compressImage } from "../../_shared/compression/index.ts";
import { validateImageUrl } from "../../_shared/url-validation.ts";
import { detectFormat, downloadImage, logUploadMetrics } from "../../_shared/image-utils.ts";
import { uploadWithFallback } from "./storage.ts";

/**
 * Proxy an external image — download, compress, and re-upload.
 */
export async function handleProxy(ctx: HandlerContext): Promise<Response> {
  const body = await ctx.request.json();
  const imageUrl = body.url;
  const bucket = body.bucket || "assets";

  if (!imageUrl) {
    throw new ValidationError("Missing 'url' field");
  }

  const urlValidation = validateImageUrl(imageUrl);
  if (!urlValidation.valid) {
    throw new ValidationError(`Invalid image URL: ${urlValidation.reason}`);
  }

  const response = await fetch(imageUrl, {
    headers: { "User-Agent": "FoodShare-ImageAPI/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new ValidationError(`Failed to fetch: ${response.status}`);
  }

  const imageData = new Uint8Array(await response.arrayBuffer());

  if (imageData.length > 10 * 1024 * 1024) {
    throw new PayloadTooLargeError("Image too large (max 10MB)", 10 * 1024 * 1024);
  }

  const compressed = await compressImage(imageData, 800);
  const format = detectFormat(compressed.buffer);
  const filename = `${crypto.randomUUID()}.${format}`;

  const { publicUrl, storage } = await uploadWithFallback(
    ctx.supabase,
    bucket,
    filename,
    compressed.buffer,
    `image/${format}`,
  );

  return ok({
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
  }, ctx);
}

/**
 * Download an external image by URL and upload to storage.
 */
export async function handleUploadFromUrl(ctx: HandlerContext): Promise<Response> {
  const startTime = Date.now();

  const body = await ctx.request.json();
  const imageUrl = body.imageUrl || body.url;
  const bucket = body.bucket || "challenges";
  const customPath = body.path;
  const challengeId = body.challengeId;

  if (!imageUrl) {
    throw new ValidationError("Missing imageUrl");
  }

  const { supabase } = ctx;

  const imageData = await downloadImage(imageUrl);

  if (imageData.length > 10 * 1024 * 1024) {
    throw new PayloadTooLargeError("Image too large (max 10MB)", 10 * 1024 * 1024);
  }

  const originalSize = imageData.length;
  const compressed = await compressImage(imageData, 800);
  const format = detectFormat(compressed.buffer);
  const filename = customPath || `${crypto.randomUUID()}.${format}`;

  const { publicUrl, storage } = await uploadWithFallback(
    supabase,
    bucket,
    filename,
    compressed.buffer,
    `image/${format}`,
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

  return ok({
    challengeId,
    publicUrl,
    filePath: filename,
    metadata: {
      originalSize,
      compressedSize: compressed.compressedSize,
      savedBytes: originalSize - compressed.compressedSize,
      storage,
    },
  }, ctx);
}
