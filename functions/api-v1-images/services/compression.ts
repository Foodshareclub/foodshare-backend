/**
 * Image Compression Service
 * Wraps existing resize-tinify-upload-image function
 * @module api-v1-images/services/compression
 */

import type { ImageUploadOptions } from "../types/index.ts";

export interface CompressionResult {
  buffer: Uint8Array;
  format: string;
  originalSize: number;
  compressedSize: number;
  savedPercent: number;
  method: string;
}

export async function compressImage(
  imageData: Uint8Array,
  options: ImageUploadOptions = {}
): Promise<CompressionResult> {
  const originalSize = imageData.length;
  
  // Call existing compression function via internal invoke
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  
  const formData = new FormData();
  formData.append("file", new Blob([imageData], { type: "image/jpeg" }));
  
  const response = await fetch(
    `${supabaseUrl}/functions/v1/resize-tinify-upload-image?mode=compress`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabaseKey}`,
      },
      body: formData,
    }
  );
  
  if (!response.ok) {
    throw new Error(`Compression failed: ${response.statusText}`);
  }
  
  const result = await response.json();
  
  return {
    buffer: new Uint8Array(await (await fetch(result.data.path)).arrayBuffer()),
    format: result.metadata.format,
    originalSize,
    compressedSize: result.metadata.finalSize,
    savedPercent: result.metadata.savedPercent,
    method: result.metadata.method,
  };
}

export async function generateThumbnail(
  imageData: Uint8Array,
  maxWidth: number = 300
): Promise<Uint8Array> {
  // Use existing compression with smaller width
  const result = await compressImage(imageData, { maxWidth });
  return result.buffer;
}
