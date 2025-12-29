import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { geocodeAddress, type Coordinates } from "../_shared/geocoding.ts";

const API_DELAY = 1000; // 1 second delay between API calls (Nominatim rate limit)

/**
 * Delay helper for rate limiting
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a single geocoding queue item
 */
async function processQueueItem(
  supabase: any,
  queueItem: {
    id: number;
    post_id: number;
    post_address: string;
    retry_count: number;
  }
): Promise<{
  queue_id: number;
  post_id: number;
  success: boolean;
  reason?: string;
  coordinates?: Coordinates;
}> {
  console.log(
    `[Queue ${queueItem.id}] Processing post ${queueItem.post_id} (attempt ${queueItem.retry_count + 1})`
  );

  try {
    // Mark as processing
    const { error: markError } = await supabase.rpc("mark_geocode_processing", {
      queue_id: queueItem.id,
    });

    if (markError) {
      console.error(`[Queue ${queueItem.id}] Error marking as processing:`, markError);
      throw markError;
    }

    // Geocode the address
    console.log(`[Queue ${queueItem.id}] Geocoding: ${queueItem.post_address}`);
    const coordinates = await geocodeAddress(queueItem.post_address);

    if (!coordinates) {
      console.log(`[Queue ${queueItem.id}] No coordinates found for address`);

      // Mark as failed (will retry if under max_retries)
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

    console.log(
      `[Queue ${queueItem.id}] Coordinates found: ${coordinates.latitude}, ${coordinates.longitude}`
    );

    // Update post with coordinates
    const { error: updateError } = await supabase
      .from("posts")
      .update({
        location: `SRID=4326;POINT(${coordinates.longitude} ${coordinates.latitude})`,
      })
      .eq("id", queueItem.post_id);

    if (updateError) {
      console.error(`[Queue ${queueItem.id}] Error updating post location:`, updateError);

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
    const { error: completeError } = await supabase.rpc("mark_geocode_completed", {
      queue_id: queueItem.id,
    });

    if (completeError) {
      console.error(`[Queue ${queueItem.id}] Error marking as completed:`, completeError);
      // Post was updated successfully, so still return success
    }

    console.log(`[Queue ${queueItem.id}] ✅ Successfully geocoded post ${queueItem.post_id}`);

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: true,
      coordinates,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Queue ${queueItem.id}] Unexpected error:`, errorMessage);

    // Try to mark as failed
    try {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: errorMessage,
      });
    } catch (markFailError) {
      console.error(`[Queue ${queueItem.id}] Could not mark as failed:`, markFailError);
    }

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: false,
      reason: errorMessage,
    };
  }
}

/**
 * Process batch of geocoding queue items
 */
async function processBatchFromQueue(
  supabase: any,
  batchSize: number = 10
): Promise<{
  message: string;
  processed: number;
  successful: number;
  failed: number;
  results: any[];
}> {
  console.log(`📋 Starting batch processing (max ${batchSize} items)...`);

  // Get pending items from queue
  const { data: queueItems, error: fetchError } = await supabase.rpc(
    "get_pending_geocode_queue",
    {
      batch_size: batchSize,
    }
  );

  if (fetchError) {
    console.error("❌ Error fetching queue items:", fetchError);
    throw new Error(`Failed to fetch queue: ${fetchError.message}`);
  }

  if (!queueItems || queueItems.length === 0) {
    console.log("✅ No items in queue");
    return {
      message: "No items to process",
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
    };
  }

  console.log(`📦 Found ${queueItems.length} items to process`);

  const results = [];
  let successful = 0;
  let failed = 0;

  for (const item of queueItems) {
    try {
      const result = await processQueueItem(supabase, item);
      results.push(result);

      if (result.success) {
        successful++;
      } else {
        failed++;
      }

      // Rate limiting - wait between each geocoding request
      await delay(API_DELAY);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error(`❌ Error processing queue item ${item.id}:`, errorMessage);

      results.push({
        queue_id: item.id,
        post_id: item.post_id,
        success: false,
        reason: errorMessage,
      });
      failed++;

      // Continue processing other items
      await delay(API_DELAY);
    }
  }

  const summary = {
    message: `Processed ${queueItems.length} items: ${successful} successful, ${failed} failed`,
    processed: queueItems.length,
    successful,
    failed,
    results,
  };

  console.log(`✅ Batch complete: ${summary.message}`);
  return summary;
}

/**
 * Process a single post directly (legacy support)
 */
async function processSinglePost(
  supabase: any,
  postId: number,
  postAddress: string
): Promise<{
  id: number;
  success: boolean;
  reason?: string;
  coordinates?: Coordinates;
}> {
  console.log(`Processing single post ${postId}: ${postAddress}`);

  if (!postAddress || postAddress.trim() === "") {
    return {
      id: postId,
      success: false,
      reason: "No address provided",
    };
  }

  try {
    const coordinates = await geocodeAddress(postAddress);

    if (!coordinates) {
      return {
        id: postId,
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
      id: postId,
      success: true,
      coordinates,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error processing post ${postId}:`, errorMessage);
    return {
      id: postId,
      success: false,
      reason: errorMessage,
    };
  }
}

/**
 * Get queue statistics
 */
async function getQueueStats(supabase: any): Promise<{
  pending: number;
  processing: number;
  failed_retryable: number;
  failed_permanent: number;
  completed_today: number;
}> {
  const { data, error } = await supabase.from("location_update_queue").select("status, retry_count, max_retries, completed_at");

  if (error) {
    console.error("Error fetching queue stats:", error);
    throw error;
  }

  const stats = {
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
      const completedDate = new Date(item.completed_at);
      if (completedDate >= today) {
        stats.completed_today++;
      }
    }
  }

  return stats;
}

/**
 * Main Edge Function handler
 */
serve(async (req) => {
  console.log("🚀 update-post-coordinates Edge Function invoked");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    console.error("❌ Missing required environment variables");
    return new Response(
      JSON.stringify({
        error: "Server configuration error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  try {
    const contentType = req.headers.get("content-type");
    let requestBody: any = {};

    if (contentType?.includes("application/json")) {
      try {
        requestBody = await req.json();
      } catch (e) {
        console.log("Could not parse JSON body, using empty object");
      }
    }

    const { operation, id, post_address, batch_size } = requestBody;

    console.log(`📋 Operation: ${operation || "BATCH_UPDATE"}`);

    // Handle different operations
    switch (operation) {
      case "BATCH_UPDATE":
      case undefined: // Default operation
      case null: {
        const size = batch_size || 10;
        const result = await processBatchFromQueue(supabase, size);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      case "STATS": {
        const stats = await getQueueStats(supabase);
        return new Response(
          JSON.stringify({
            message: "Queue statistics",
            stats,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      case "SINGLE": {
        // Legacy: process single post directly
        if (!id || !post_address) {
          return new Response(
            JSON.stringify({
              error: "Missing id or post_address for SINGLE operation",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        const result = await processSinglePost(supabase, id, post_address);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      case "CLEANUP": {
        // Cleanup old completed queue entries
        const daysOld = requestBody.days_old || 30;
        const { data, error } = await supabase.rpc("cleanup_old_geocode_queue", {
          days_old: daysOld,
        });

        if (error) throw error;

        return new Response(
          JSON.stringify({
            message: `Cleaned up ${data || 0} old queue entries`,
            deleted: data || 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      case "DELETE": {
        // Acknowledge delete (for webhook compatibility)
        console.log(`Post ${id} deleted`);
        return new Response(
          JSON.stringify({
            message: "Delete acknowledged",
            id,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      default: {
        return new Response(
          JSON.stringify({
            error: `Unknown operation: ${operation}`,
            available_operations: ["BATCH_UPDATE", "STATS", "SINGLE", "CLEANUP", "DELETE"],
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Unexpected error:", errorMessage);

    return new Response(
      JSON.stringify({
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
