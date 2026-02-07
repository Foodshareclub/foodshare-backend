/**
 * Shared Image Utilities
 */

export function detectFormat(buffer: Uint8Array): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "webp";
  return "jpeg";
}

export async function downloadImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function logUploadMetrics(supabase: any, metrics: {
  userId: string | null;
  bucket: string;
  path: string;
  originalSize: number;
  compressedSize: number;
  savedBytes: number;
  compressionMethod: string;
  processingTime: number;
  storage?: "r2" | "supabase";
}) {
  try {
    await supabase.from("image_upload_metrics").insert({
      user_id: metrics.userId,
      bucket: metrics.bucket,
      path: metrics.path,
      original_size: metrics.originalSize,
      compressed_size: metrics.compressedSize,
      saved_bytes: metrics.savedBytes,
      compression_method: metrics.compressionMethod,
      processing_time_ms: metrics.processingTime,
      storage: metrics.storage || "supabase",
      uploaded_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to log metrics:", error);
  }
}
