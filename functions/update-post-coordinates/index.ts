/**
 * Update Post Coordinates Edge Function
 *
 * Geocodes post addresses and updates their locations.
 * Supports multiple operations: BATCH_UPDATE, STATS, SINGLE, CLEANUP, DELETE.
 *
 * Features:
 * - Queue-based batch processing
 * - Rate limiting for Nominatim API
 * - Retry logic with exponential backoff
 * - Queue statistics
 *
 * Usage:
 * POST /update-post-coordinates
 * { "operation": "BATCH_UPDATE", "batch_size": 10 }
 * { "operation": "STATS" }
 * { "operation": "SINGLE", "id": 123, "post_address": "..." }
 * { "operation": "CLEANUP", "days_old": 30 }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { geocodeAddress, type Coordinates } from "../_shared/geocoding.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  defaultBatchSize: 10,
  apiDelay: 1000, // Nominatim rate limit
};

// =============================================================================
// Request Schema
// =============================================================================

const operationSchema = z.object({
  operation: z.enum(["BATCH_UPDATE", "STATS", "SINGLE", "CLEANUP", "DELETE"]).optional(),
  batch_size: z.number().optional(),
  id: z.number().optional(),
  post_address: z.string().optional(),
  days_old: z.number().optional(),
}).optional();

type OperationRequest = z.infer<typeof operationSchema>;

// =============================================================================
// Types
// =============================================================================

interface QueueItem {
  id: number;
  post_id: number;
  post_address: string;
  retry_count: number;
}

interface ProcessResult {
  queue_id: number;
  post_id: number;
  success: boolean;
  reason?: string;
  coordinates?: Coordinates;
}

interface QueueStats {
  pending: number;
  processing: number;
  failed_retryable: number;
  failed_permanent: number;
  completed_today: number;
}

// =============================================================================
// Delay Helper
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Queue Processing
// =============================================================================

async function processQueueItem(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  queueItem: QueueItem
): Promise<ProcessResult> {
  logger.info("Processing queue item", {
    queueId: queueItem.id,
    postId: queueItem.post_id,
    attempt: queueItem.retry_count + 1,
  });

  try {
    // Mark as processing
    const { error: markError } = await supabase.rpc("mark_geocode_processing", {
      queue_id: queueItem.id,
    });

    if (markError) {
      throw markError;
    }

    // Geocode the address
    const coordinates = await geocodeAddress(queueItem.post_address);

    if (!coordinates) {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: "No coordinates found for address",
      });

      return {
        queue_id: queueItem.id,
        post_id: queueItem.post_id,
        success: false,
        reason: "No coordinates found",
      };
    }

    // Update post with coordinates
    const { error: updateError } = await supabase
      .from("posts")
      .update({
        location: `SRID=4326;POINT(${coordinates.longitude} ${coordinates.latitude})`,
      })
      .eq("id", queueItem.post_id);

    if (updateError) {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: `Database update failed: ${updateError.message}`,
      });

      return {
        queue_id: queueItem.id,
        post_id: queueItem.post_id,
        success: false,
        reason: `Database error: ${updateError.message}`,
      };
    }

    // Mark as completed
    await supabase.rpc("mark_geocode_completed", {
      queue_id: queueItem.id,
    });

    logger.info("Successfully geocoded post", {
      queueId: queueItem.id,
      postId: queueItem.post_id,
    });

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: true,
      coordinates,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Error processing queue item", {
      queueId: queueItem.id,
      error: errorMessage,
    });

    try {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: errorMessage,
      });
    } catch {
      // Ignore marking failure
    }

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: false,
      reason: errorMessage,
    };
  }
}

async function processBatchFromQueue(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  batchSize: number
): Promise<{
  message: string;
  processed: number;
  successful: number;
  failed: number;
  results: ProcessResult[];
}> {
  logger.info("Starting batch processing", { batchSize });

  // Get pending items from queue
  const { data: queueItems, error: fetchError } = await supabase.rpc(
    "get_pending_geocode_queue",
    { batch_size: batchSize }
  );

  if (fetchError) {
    throw new Error(`Failed to fetch queue: ${fetchError.message}`);
  }

  if (!queueItems || queueItems.length === 0) {
    return {
      message: "No items to process",
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
    };
  }

  const results: ProcessResult[] = [];
  let successful = 0;
  let failed = 0;

  for (const item of queueItems) {
    try {
      const result = await processQueueItem(supabase, item as QueueItem);
      results.push(result);

      if (result.success) successful++;
      else failed++;

      // Rate limiting
      await delay(CONFIG.apiDelay);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.push({
        queue_id: item.id,
        post_id: item.post_id,
        success: false,
        reason: errorMessage,
      });
      failed++;
      await delay(CONFIG.apiDelay);
    }
  }

  return {
    message: `Processed ${queueItems.length} items: ${successful} successful, ${failed} failed`,
    processed: queueItems.length,
    successful,
    failed,
    results,
  };
}

async function processSinglePost(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  postId: number,
  postAddress: string
): Promise<ProcessResult> {
  if (!postAddress || postAddress.trim() === "") {
    return {
      queue_id: 0,
      post_id: postId,
      success: false,
      reason: "No address provided",
    };
  }

  const coordinates = await geocodeAddress(postAddress);

  if (!coordinates) {
    return {
      queue_id: 0,
      post_id: postId,
      success: false,
      reason: "No coordinates found",
    };
  }

  const { error } = await supabase
    .from("posts")
    .update({
      location: `SRID=4326;POINT(${coordinates.longitude} ${coordinates.latitude})`,
    })
    .eq("id", postId);

  if (error) throw error;

  return {
    queue_id: 0,
    post_id: postId,
    success: true,
    coordinates,
  };
}

async function getQueueStats(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>
): Promise<QueueStats> {
  const { data, error } = await supabase
    .from("location_update_queue")
    .select("status, retry_count, max_retries, completed_at");

  if (error) throw error;

  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    failed_retryable: 0,
    failed_permanent: 0,
    completed_today: 0,
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const item of data || []) {
    if (item.status === "pending") {
      stats.pending++;
    } else if (item.status === "processing") {
      stats.processing++;
    } else if (item.status === "failed") {
      if (item.retry_count < item.max_retries) {
        stats.failed_retryable++;
      } else {
        stats.failed_permanent++;
      }
    } else if (item.status === "completed" && item.completed_at) {
      if (new Date(item.completed_at) >= today) {
        stats.completed_today++;
      }
    }
  }

  return stats;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleUpdatePostCoordinates(
  ctx: HandlerContext<OperationRequest>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;

  const operation = body?.operation || "BATCH_UPDATE";
  const batchSize = body?.batch_size || CONFIG.defaultBatchSize;

  logger.info("Processing post coordinates operation", {
    operation,
    requestId: requestCtx?.requestId,
  });

  switch (operation) {
    case "BATCH_UPDATE":
    case undefined:
    case null: {
      const result = await processBatchFromQueue(supabase, batchSize);
      return ok(result, ctx);
    }

    case "STATS": {
      const stats = await getQueueStats(supabase);
      return ok({ message: "Queue statistics", stats }, ctx);
    }

    case "SINGLE": {
      if (!body?.id || !body?.post_address) {
        return new Response(
          JSON.stringify({
            error: "Missing id or post_address for SINGLE operation",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const result = await processSinglePost(supabase, body.id, body.post_address);
      return ok(result, ctx);
    }

    case "CLEANUP": {
      const daysOld = body?.days_old || 30;
      const { data, error } = await supabase.rpc("cleanup_old_geocode_queue", {
        days_old: daysOld,
      });

      if (error) throw error;

      return ok({
        message: `Cleaned up ${data || 0} old queue entries`,
        deleted: data || 0,
      }, ctx);
    }

    case "DELETE": {
      logger.info("Post deleted", { id: body?.id });
      return ok({ message: "Delete acknowledged", id: body?.id }, ctx);
    }

    default: {
      return new Response(
        JSON.stringify({
          error: `Unknown operation: ${operation}`,
          available_operations: ["BATCH_UPDATE", "STATS", "SINGLE", "CLEANUP", "DELETE"],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "update-post-coordinates",
  version: CONFIG.version,
  requireAuth: false, // Service-level operation
  routes: {
    POST: {
      schema: operationSchema,
      handler: handleUpdatePostCoordinates,
    },
    GET: {
      handler: handleUpdatePostCoordinates, // Support GET for cron
    },
  },
});
