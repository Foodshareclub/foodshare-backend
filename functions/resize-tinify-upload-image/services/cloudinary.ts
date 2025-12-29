/**
 * Cloudinary Compression Service
 * https://cloudinary.com/documentation
 */

import { log, formatBytes, formatDuration } from "../lib/logger.ts";
import { generateUUID } from "../lib/utils.ts";
import type { CompressResult, CloudinaryConfig } from "../lib/types.ts";

async function createSignature(params: Record<string, string>, apiSecret: string): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const stringToSign = sortedKeys.map((key) => `${key}=${params[key]}`).join("&");
  const signatureData = new TextEncoder().encode(stringToSign + apiSecret);
  const hashBuffer = await crypto.subtle.digest("SHA-1", signatureData);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function cleanupCloudinaryImage(publicId: string, config: CloudinaryConfig): Promise<void> {
  const deleteTimestamp = Math.floor(Date.now() / 1000).toString();
  const deleteParams: Record<string, string> = {
    public_id: publicId,
    timestamp: deleteTimestamp,
  };
  const deleteSignature = await createSignature(deleteParams, config.apiSecret);

  const deleteFormData = new FormData();
  deleteFormData.append("public_id", publicId);
  deleteFormData.append("api_key", config.apiKey);
  deleteFormData.append("timestamp", deleteTimestamp);
  deleteFormData.append("signature", deleteSignature);

  await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/image/destroy`, {
    method: "POST",
    body: deleteFormData,
  });
}

export async function compressWithCloudinary(
  imageData: Uint8Array,
  config: CloudinaryConfig,
  targetWidth: number
): Promise<CompressResult> {
  const startTime = Date.now();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `temp_compress_${generateUUID().slice(0, 8)}`;

  // Transformation: auto quality, auto format, resize
  const transformation = `q_auto:good,f_auto,w_${targetWidth},c_limit`;

  // Parameters to sign
  const paramsToSign: Record<string, string> = {
    public_id: publicId,
    timestamp: timestamp,
    transformation: transformation,
  };

  const signature = await createSignature(paramsToSign, config.apiSecret);

  // Create form data for upload
  const formData = new FormData();
  const blob = new Blob([imageData], { type: "image/jpeg" });
  formData.append("file", blob);
  formData.append("api_key", config.apiKey);
  formData.append("timestamp", timestamp);
  formData.append("signature", signature);
  formData.append("public_id", publicId);
  formData.append("transformation", transformation);

  // Upload to Cloudinary
  const uploadUrl = `https://api.cloudinary.com/v1_1/${config.cloudName}/image/upload`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    const error = await uploadResponse.text();
    throw new Error(`Cloudinary upload failed (${uploadResponse.status}): ${error}`);
  }

  const uploadResult = await uploadResponse.json();
  const uploadDuration = Date.now() - startTime;

  log("debug", "Cloudinary upload complete", {
    service: "cloudinary",
    publicId,
    uploadDuration: formatDuration(uploadDuration),
  });

  // Download the transformed image
  const downloadStart = Date.now();
  const transformedUrl = uploadResult.secure_url;
  const downloadResponse = await fetch(transformedUrl);

  if (!downloadResponse.ok) {
    throw new Error(`Cloudinary download failed: ${downloadResponse.status}`);
  }

  const compressedBuffer = new Uint8Array(await downloadResponse.arrayBuffer());
  const totalDuration = Date.now() - startTime;

  log("info", "Cloudinary compression complete", {
    service: "cloudinary",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(compressedBuffer.length),
    targetWidth,
    savedPercent: ((1 - compressedBuffer.length / imageData.length) * 100).toFixed(1),
    duration: formatDuration(totalDuration),
    downloadDuration: formatDuration(Date.now() - downloadStart),
  });

  // Clean up temp image (fire and forget)
  cleanupCloudinaryImage(publicId, config).catch((err) => {
    log("warn", "Cloudinary cleanup failed", {
      service: "cloudinary",
      publicId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    buffer: compressedBuffer,
    method: `cloudinary@${targetWidth}px`,
    service: "cloudinary",
  };
}
