/**
 * Image Recompression Service
 */

import { logger } from "../../_shared/logger.ts";

export interface RecompressionResults {
  processed: number;
  compressed: number;
  failed: number;
  skipped: number;
  totalSaved: number;
}

export async function recompressOldImages(
  supabase: any,
  options: {
    batchSize?: number;
    cutoffDate?: string;
  } = {},
): Promise<RecompressionResults> {
  const batchSize = options.batchSize ?? 50;
  const _cutoffDate = options.cutoffDate ?? "2026-02-06T00:00:00Z";

  const results: RecompressionResults = {
    processed: 0,
    compressed: 0,
    failed: 0,
    skipped: 0,
    totalSaved: 0,
  };

  const buckets = ["food-images", "profiles", "forum", "challenges", "avatars", "posts"];

  for (const bucket of buckets) {
    const { data: files } = await supabase.storage
      .from(bucket)
      .list("", {
        limit: batchSize,
        sortBy: { column: "created_at", order: "asc" },
      });

    if (!files) continue;

    for (const file of files) {
      results.processed++;

      const { data: existing } = await supabase
        .from("image_upload_metrics")
        .select("id")
        .eq("bucket", bucket)
        .eq("path", file.name)
        .single();

      if (existing) {
        results.skipped++;
        continue;
      }

      if (file.metadata?.size && file.metadata.size < 100 * 1024) {
        results.skipped++;
        continue;
      }

      try {
        const { data: fileData } = await supabase.storage
          .from(bucket)
          .download(file.name);

        if (!fileData) {
          results.failed++;
          continue;
        }

        const _originalSize = fileData.size;
        const buffer = await fileData.arrayBuffer();

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

        const formData = new FormData();
        formData.append("file", new Blob([buffer]));
        formData.append("bucket", bucket);
        formData.append("path", file.name);
        formData.append("generateThumbnail", "false");
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
          },
        );

        if (uploadResponse.ok) {
          const result = await uploadResponse.json();
          results.compressed++;
          results.totalSaved += result.metadata.savedBytes || 0;

          logger.info("Recompressed image", {
            bucket,
            file: file.name,
            savedBytes: result.metadata.savedBytes,
          });
        } else {
          results.failed++;
          logger.error("Failed to recompress image", { bucket, file: file.name });
        }
      } catch (error) {
        results.failed++;
        logger.error("Error processing image for recompression", {
          bucket,
          file: file.name,
          error,
        });
      }
    }
  }

  return results;
}
