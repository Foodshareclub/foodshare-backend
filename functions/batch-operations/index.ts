/**
 * Batch Operations Edge Function
 *
 * Provides batch operations for efficient offline sync and bulk updates.
 * Supports batch favorites, mark_read, and archive operations.
 *
 * Endpoints:
 * - POST /batch-operations { operations: [...] }
 *
 * Features:
 * - Process multiple operations in a single request
 * - Correlation IDs for tracking individual operation results
 * - Optimized for offline-first sync scenarios
 * - Cross-platform support (iOS/Android)
 *
 * Phase 20: Extended Edge Function Suite
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Request Schema
// =============================================================================

const operationSchema = z.object({
  correlationId: z.string().uuid(),
  type: z.enum(["toggle_favorite", "mark_read", "archive_room", "toggle_bookmark"]),
  entityId: z.string(),
  payload: z.record(z.unknown()).optional(),
});

const batchOperationsSchema = z.object({
  operations: z.array(operationSchema).min(1).max(50),
});

type Operation = z.infer<typeof operationSchema>;
type BatchOperationsRequest = z.infer<typeof batchOperationsSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface OperationResult {
  correlationId: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface BatchResponse {
  totalOperations: number;
  successful: number;
  failed: number;
  results: OperationResult[];
}

// =============================================================================
// Handler
// =============================================================================

async function handleBatchOperations(
  ctx: HandlerContext<BatchOperationsRequest>
): Promise<Response> {
  const { operations } = ctx.body;
  const userId = ctx.userId;

  if (!userId) {
    throw new ValidationError("User must be authenticated");
  }

  logger.info("Processing batch operations", {
    count: operations.length,
    userId,
    types: [...new Set(operations.map(op => op.type))],
  });

  const results: OperationResult[] = [];
  let successful = 0;
  let failed = 0;

  // Process operations sequentially to maintain consistency
  for (const operation of operations) {
    try {
      const data = await processOperation(ctx, userId, operation);
      results.push({
        correlationId: operation.correlationId,
        success: true,
        data,
      });
      successful++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.push({
        correlationId: operation.correlationId,
        success: false,
        error: errorMessage,
      });
      failed++;
      logger.warn("Batch operation failed", {
        correlationId: operation.correlationId,
        type: operation.type,
        error: errorMessage,
      });
    }
  }

  const response: BatchResponse = {
    totalOperations: operations.length,
    successful,
    failed,
    results,
  };

  logger.info("Batch operations completed", {
    total: operations.length,
    successful,
    failed,
    userId,
  });

  return ok(response, ctx);
}

// =============================================================================
// Operation Processors
// =============================================================================

async function processOperation(
  ctx: HandlerContext<BatchOperationsRequest>,
  userId: string,
  operation: Operation
): Promise<Record<string, unknown>> {
  switch (operation.type) {
    case "toggle_favorite":
      return processToggleFavorite(ctx, userId, operation);
    case "mark_read":
      return processMarkRead(ctx, userId, operation);
    case "archive_room":
      return processArchiveRoom(ctx, userId, operation);
    case "toggle_bookmark":
      return processToggleBookmark(ctx, userId, operation);
    default:
      throw new ValidationError(`Unknown operation type: ${operation.type}`);
  }
}

async function processToggleFavorite(
  ctx: HandlerContext<BatchOperationsRequest>,
  userId: string,
  operation: Operation
): Promise<Record<string, unknown>> {
  const postId = parseInt(operation.entityId, 10);
  if (isNaN(postId)) {
    throw new ValidationError("Invalid post ID");
  }

  const { data, error } = await ctx.supabase.rpc("toggle_post_favorite_atomic", {
    p_user_id: userId,
    p_post_id: postId,
  });

  if (error) {
    throw new ValidationError(`Toggle favorite failed: ${error.message}`);
  }

  return {
    isFavorited: data.is_favorited,
    likeCount: data.like_count,
    action: data.was_added ? "added" : "removed",
  };
}

async function processMarkRead(
  ctx: HandlerContext<BatchOperationsRequest>,
  userId: string,
  operation: Operation
): Promise<Record<string, unknown>> {
  const roomId = operation.entityId;

  const { data, error } = await ctx.supabase.rpc("mark_messages_read", {
    p_room_id: roomId,
    p_user_id: userId,
  });

  if (error) {
    throw new ValidationError(`Mark read failed: ${error.message}`);
  }

  return {
    roomId,
    markedRead: true,
    timestamp: new Date().toISOString(),
  };
}

async function processArchiveRoom(
  ctx: HandlerContext<BatchOperationsRequest>,
  userId: string,
  operation: Operation
): Promise<Record<string, unknown>> {
  const roomId = operation.entityId;

  const { error } = await ctx.supabase
    .from("room_members")
    .update({ is_archived: true })
    .eq("room_id", roomId)
    .eq("profile_id", userId);

  if (error) {
    throw new ValidationError(`Archive room failed: ${error.message}`);
  }

  return {
    roomId,
    archived: true,
    timestamp: new Date().toISOString(),
  };
}

async function processToggleBookmark(
  ctx: HandlerContext<BatchOperationsRequest>,
  userId: string,
  operation: Operation
): Promise<Record<string, unknown>> {
  const postId = parseInt(operation.entityId, 10);
  if (isNaN(postId)) {
    throw new ValidationError("Invalid post ID");
  }

  // Check if bookmark exists
  const { data: existing, error: checkError } = await ctx.supabase
    .from("forum_bookmarks")
    .select("id")
    .eq("user_id", userId)
    .eq("post_id", postId)
    .maybeSingle();

  if (checkError) {
    throw new ValidationError(`Bookmark check failed: ${checkError.message}`);
  }

  let isBookmarked: boolean;

  if (existing) {
    // Remove bookmark
    const { error: deleteError } = await ctx.supabase
      .from("forum_bookmarks")
      .delete()
      .eq("id", existing.id);

    if (deleteError) {
      throw new ValidationError(`Remove bookmark failed: ${deleteError.message}`);
    }
    isBookmarked = false;
  } else {
    // Add bookmark
    const { error: insertError } = await ctx.supabase
      .from("forum_bookmarks")
      .insert({ user_id: userId, post_id: postId });

    if (insertError) {
      throw new ValidationError(`Add bookmark failed: ${insertError.message}`);
    }
    isBookmarked = true;
  }

  return {
    postId,
    isBookmarked,
    action: isBookmarked ? "added" : "removed",
  };
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "batch-operations",
  version: "1.0.0",
  requireAuth: true,
  routes: {
    POST: {
      schema: batchOperationsSchema,
      handler: handleBatchOperations,
    },
  },
});
