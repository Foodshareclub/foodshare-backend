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

  const imageData = await imageResponse.arrayBuffer();

  // Use api-v1-images for compression and upload
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const formData = new FormData();
  formData.append("file", new Blob([imageData]), "image.jpg");
  formData.append("bucket", "challenges");
  formData.append("path", `${challengeId}/image.jpg`);
  formData.append("generateThumbnail", "true");
  formData.append("extractEXIF", "false");
  formData.append("enableAI", "false");

  const uploadResponse = await fetch(
    `${supabaseUrl}/functions/v1/api-v1-images/upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
      },
      body: formData,
    }
  );

  if (!uploadResponse.ok) {
    const error = await uploadResponse.text();
    logger.error("Image API upload failed", { error, challengeId });
    throw new ServerError(`Upload failed: ${error}`);
  }

  const uploadResult = await uploadResponse.json();
  const publicUrl = uploadResult.data.url;

  // Update the challenges table
  const { error: updateError } = await supabase
    .from("challenges")
    .update({ challenge_image: publicUrl })
    .eq("id", challengeId);

  if (updateError) {
    logger.error("DB update failed", {
      error: updateError.message,
      challengeId,
      publicUrl,
    });
    throw new ServerError(`DB update failed: ${updateError.message}`);
  }

  logger.info("Challenge image uploaded successfully", {
    challengeId,
    publicUrl,
    requestId: requestCtx?.requestId,
  });

  const result: UploadResponse = {
    success: true,
    challengeId: typeof challengeId === "number" ? challengeId : parseInt(String(challengeId), 10),
    publicUrl,
    filePath: uploadResult.data.path,
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
