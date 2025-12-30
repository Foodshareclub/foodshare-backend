/**
 * Upload Challenge Image Edge Function
 *
 * Downloads an image from URL and uploads it to challenge storage.
 * Used for importing challenge images from external sources.
 *
 * Features:
 * - Image download from URL
 * - Content type detection
 * - Storage upload with upsert
 * - Challenge record update
 *
 * Usage:
 * POST /upload-challenge-image
 * { "imageUrl": "https://...", "challengeId": 123 }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError, ServerError } from "../_shared/errors.ts";

// =============================================================================
// Request Schema
// =============================================================================

const uploadChallengeImageSchema = z.object({
  imageUrl: z.string().url(),
  challengeId: z.union([z.number(), z.string()]).transform((val) =>
    typeof val === "string" ? parseInt(val, 10) : val
  ),
});

type UploadChallengeImageRequest = z.infer<typeof uploadChallengeImageSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UploadResponse {
  success: boolean;
  challengeId: number;
  publicUrl: string;
  filePath: string;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleUploadChallengeImage(
  ctx: HandlerContext<UploadChallengeImageRequest>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const { imageUrl, challengeId } = body;

  logger.info("Uploading challenge image", {
    challengeId,
    imageUrl: imageUrl.substring(0, 50) + "...",
    requestId: requestCtx?.requestId,
  });

  // Fetch the image
  const imageResponse = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });

  if (!imageResponse.ok) {
    logger.error("Failed to fetch image", {
      status: imageResponse.status,
      imageUrl: imageUrl.substring(0, 50),
    });
    throw new ValidationError(`Failed to fetch image: ${imageResponse.status}`);
  }

  const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
  const imageData = await imageResponse.arrayBuffer();

  // Determine file extension
  let ext = "jpg";
  if (contentType.includes("png")) ext = "png";
  else if (contentType.includes("webp")) ext = "webp";
  else if (contentType.includes("gif")) ext = "gif";

  const filePath = `${challengeId}/image.${ext}`;

  // Upload to storage
  const { error: uploadError } = await supabase.storage
    .from("challenges")
    .upload(filePath, imageData, {
      contentType,
      upsert: true,
    });

  if (uploadError) {
    logger.error("Upload failed", { error: uploadError.message, challengeId });
    throw new ServerError(`Upload failed: ${uploadError.message}`);
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("challenges")
    .getPublicUrl(filePath);

  // Update the challenges table
  const { error: updateError } = await supabase
    .from("challenges")
    .update({ challenge_image: urlData.publicUrl })
    .eq("id", challengeId);

  if (updateError) {
    logger.error("DB update failed", {
      error: updateError.message,
      challengeId,
      publicUrl: urlData.publicUrl,
    });
    throw new ServerError(`DB update failed: ${updateError.message}`);
  }

  logger.info("Challenge image uploaded successfully", {
    challengeId,
    filePath,
    publicUrl: urlData.publicUrl,
    requestId: requestCtx?.requestId,
  });

  const result: UploadResponse = {
    success: true,
    challengeId: typeof challengeId === "number" ? challengeId : parseInt(String(challengeId), 10),
    publicUrl: urlData.publicUrl,
    filePath,
  };

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "upload-challenge-image",
  version: "2.0.0",
  requireAuth: false, // Service-level operation
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 uploads per minute
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: uploadChallengeImageSchema,
      handler: handleUploadChallengeImage,
    },
  },
});
