/**
 * Orphan Image Cleanup Service
 */

import { deleteFromR2 } from "../../_shared/r2-storage.ts";
import { logger } from "../../_shared/logger.ts";

interface OrphanImage {
  metric_id: number;
  bucket: string;
  path: string;
  storage: string;
  compressed_size: number;
  uploaded_at: string;
}

export interface CleanupStats {
  checked: number;
  orphansFound: number;
  orphansDeleted: number;
  deleteFailed: number;
  bytesReclaimed: number;
  dryRun: boolean;
  gracePeriodHours: number;
  errors: { metricId: number; error: string }[];
  durationMs: number;
}

async function deleteOrphanImage(
  supabase: any,
  orphan: OrphanImage,
  dryRun: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (dryRun) return { success: true };

  try {
    if (orphan.storage === "r2") {
      const r2Path = `${orphan.bucket}/${orphan.path}`;
      const result = await deleteFromR2(r2Path);
      if (!result.success) return { success: false, error: result.error };
    } else {
      const { error } = await supabase.storage
        .from(orphan.bucket)
        .remove([orphan.path]);
      if (error) return { success: false, error: error.message };
    }

    const { error: deleteMetricError } = await supabase
      .from("image_upload_metrics")
      .delete()
      .eq("id", orphan.metric_id);

    if (deleteMetricError) {
      logger.warn("Image deleted but metrics row removal failed", {
        metricId: orphan.metric_id,
        error: deleteMetricError.message,
      });
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function cleanupOrphanImages(
  supabase: any,
  options: {
    gracePeriodHours?: number;
    batchSize?: number;
    dryRun?: boolean;
  } = {}
): Promise<CleanupStats> {
  const startTime = performance.now();
  const gracePeriodHours = options.gracePeriodHours ?? 24;
  const batchSize = options.batchSize ?? 100;
  const dryRun = options.dryRun ?? false;

  logger.info("Starting orphan image cleanup", { gracePeriodHours, batchSize, dryRun });

  const { data: orphans, error: rpcError } = await supabase.rpc(
    "find_orphan_images",
    {
      grace_period_hours: gracePeriodHours,
      batch_limit: batchSize,
    },
  );

  if (rpcError) {
    logger.error("find_orphan_images RPC failed", new Error(rpcError.message));
    throw new Error(`RPC failed: ${rpcError.message}`);
  }

  const orphanList = (orphans || []) as OrphanImage[];
  const stats: CleanupStats = {
    checked: orphanList.length,
    orphansFound: orphanList.length,
    orphansDeleted: 0,
    deleteFailed: 0,
    bytesReclaimed: 0,
    dryRun,
    gracePeriodHours,
    errors: [],
    durationMs: 0,
  };

  for (const orphan of orphanList) {
    const result = await deleteOrphanImage(supabase, orphan, dryRun);

    if (result.success) {
      stats.orphansDeleted++;
      stats.bytesReclaimed += orphan.compressed_size || 0;
    } else {
      stats.deleteFailed++;
      stats.errors.push({
        metricId: orphan.metric_id,
        error: result.error || "Unknown error",
      });
    }
  }

  stats.durationMs = Math.round(performance.now() - startTime);

  logger.info("Orphan cleanup complete", {
    orphansFound: stats.orphansFound,
    orphansDeleted: stats.orphansDeleted,
    deleteFailed: stats.deleteFailed,
    bytesReclaimed: stats.bytesReclaimed,
    dryRun,
    durationMs: stats.durationMs,
  });

  return stats;
}
