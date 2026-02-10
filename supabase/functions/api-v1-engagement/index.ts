/**
 * Engagement API v1
 *
 * REST API for post engagement operations (likes, bookmarks, favorites, shares).
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-engagement?postId=<id>           - Get engagement status
 * - GET    /api-v1-engagement?postIds=1,2,3         - Batch get engagement
 * - POST   /api-v1-engagement?action=like           - Toggle like
 * - POST   /api-v1-engagement?action=bookmark       - Toggle bookmark
 * - POST   /api-v1-engagement?action=favorite       - Toggle favorite (atomic)
 * - POST   /api-v1-engagement?action=share          - Record share
 * - POST   /api-v1-engagement/batch                 - Batch operations
 * - GET    /api-v1-engagement?action=bookmarks      - Get user's bookmarks
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 *
 * @module api-v1-engagement
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { ValidationError, ServerError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { toggleRow } from "../_shared/toggle.ts";

const VERSION = "1.0.0";

// =============================================================================
// Schemas
// =============================================================================

const toggleEngagementSchema = z.object({
  postId: z.number().int().positive(),
});

const shareSchema = z.object({
  postId: z.number().int().positive(),
  method: z.enum(["link", "social", "email", "other"]).default("link"),
});

const batchOperationSchema = z.object({
  correlationId: z.string().uuid(),
  type: z.enum(["toggle_favorite", "toggle_like", "toggle_bookmark", "mark_read", "archive_room"]),
  entityId: z.string(),
  payload: z.record(z.unknown()).optional(),
});

const batchOperationsSchema = z.object({
  operations: z.array(batchOperationSchema).min(1).max(50),
});

const querySchema = z.object({
  postId: z.string().optional(),
  postIds: z.string().optional(), // Comma-separated for batch
  action: z.enum(["like", "bookmark", "favorite", "share", "bookmarks"]).optional(),
  mode: z.enum(["toggle", "add", "remove"]).optional(), // For favorite action
  limit: z.string().optional(),
});

type ToggleBody = z.infer<typeof toggleEngagementSchema>;
type ShareBody = z.infer<typeof shareSchema>;
type BatchOperation = z.infer<typeof batchOperationSchema>;
type BatchOperationsBody = z.infer<typeof batchOperationsSchema>;
type QueryParams = z.infer<typeof querySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * Get engagement status for a post or batch of posts
 */
async function getEngagement(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  // Batch request
  if (query.postIds) {
    const postIds = query.postIds.split(",").map((id) => parseInt(id.trim())).filter((id) => !isNaN(id));

    if (postIds.length === 0 || postIds.length > 100) {
      throw new ValidationError("Invalid postIds (1-100 required)");
    }

    // Get like counts
    const { data: likes } = await supabase
      .from("post_likes")
      .select("post_id")
      .in("post_id", postIds);

    const likeCountMap: Record<number, number> = {};
    for (const like of likes || []) {
      likeCountMap[like.post_id] = (likeCountMap[like.post_id] || 0) + 1;
    }

    // Get user's likes and bookmarks if authenticated
    let userLikes: number[] = [];
    let userBookmarks: number[] = [];

    if (userId) {
      const [likesResult, bookmarksResult] = await Promise.all([
        supabase
          .from("post_likes")
          .select("post_id")
          .eq("profile_id", userId)
          .in("post_id", postIds),
        supabase
          .from("post_bookmarks")
          .select("post_id")
          .eq("profile_id", userId)
          .in("post_id", postIds),
      ]);

      userLikes = (likesResult.data || []).map((l) => l.post_id);
      userBookmarks = (bookmarksResult.data || []).map((b) => b.post_id);
    }

    // Build result
    const result: Record<number, { isLiked: boolean; isBookmarked: boolean; likeCount: number }> = {};
    for (const postId of postIds) {
      result[postId] = {
        isLiked: userLikes.includes(postId),
        isBookmarked: userBookmarks.includes(postId),
        likeCount: likeCountMap[postId] || 0,
      };
    }

    return ok(result, ctx);
  }

  // Single post request
  if (query.postId) {
    const postId = parseInt(query.postId);
    if (isNaN(postId)) {
      throw new ValidationError("Invalid postId");
    }

    const { count: likeCount } = await supabase
      .from("post_likes")
      .select("id", { count: "exact", head: true })
      .eq("post_id", postId);

    let isLiked = false;
    let isBookmarked = false;

    if (userId) {
      const [likeResult, bookmarkResult] = await Promise.all([
        supabase
          .from("post_likes")
          .select("id")
          .eq("post_id", postId)
          .eq("profile_id", userId)
          .single(),
        supabase
          .from("post_bookmarks")
          .select("id")
          .eq("post_id", postId)
          .eq("profile_id", userId)
          .single(),
      ]);

      isLiked = !!likeResult.data;
      isBookmarked = !!bookmarkResult.data;
    }

    return ok({
      postId,
      isLiked,
      isBookmarked,
      likeCount: likeCount || 0,
    }, ctx);
  }

  throw new ValidationError("postId or postIds required");
}

/**
 * Get user's bookmarked posts
 */
async function getUserBookmarks(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "50"), 100);

  const { data, error } = await supabase
    .from("post_bookmarks")
    .select("post_id, created_at")
    .eq("profile_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    logger.error("Failed to get bookmarks", new Error(error.message));
    throw error;
  }

  return ok({
    postIds: (data || []).map((b) => b.post_id),
    count: data?.length || 0,
  }, ctx);
}

/**
 * Toggle like on a post
 */
async function toggleLike(ctx: HandlerContext<ToggleBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const result = await toggleRow(supabase, {
    table: "post_likes",
    entityColumn: "post_id",
    userColumn: "profile_id",
  }, body.postId, userId);

  const isLiked = result.active;
  await logActivity(supabase, body.postId, userId, isLiked ? "liked" : "unliked");

  // Get updated count
  const { count } = await supabase
    .from("post_likes")
    .select("id", { count: "exact", head: true })
    .eq("post_id", body.postId);

  logger.info("Like toggled", { postId: body.postId, userId, isLiked });

  return ok({
    postId: body.postId,
    isLiked,
    likeCount: count || 0,
  }, ctx);
}

/**
 * Toggle bookmark on a post
 */
async function toggleBookmark(ctx: HandlerContext<ToggleBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const result = await toggleRow(supabase, {
    table: "post_bookmarks",
    entityColumn: "post_id",
    userColumn: "profile_id",
  }, body.postId, userId);

  const isBookmarked = result.active;
  await logActivity(supabase, body.postId, userId, isBookmarked ? "bookmarked" : "unbookmarked");

  logger.info("Bookmark toggled", { postId: body.postId, userId, isBookmarked });

  return ok({
    postId: body.postId,
    isBookmarked,
  }, ctx);
}

/**
 * Record a share
 */
async function recordShare(ctx: HandlerContext<ShareBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  // Log activity (shares can be anonymous)
  await logActivity(supabase, body.postId, userId || null, "shared", {
    method: body.method,
  });

  logger.info("Share recorded", { postId: body.postId, method: body.method });

  return ok({ success: true }, ctx);
}

/**
 * Toggle favorite (atomic operation)
 */
async function toggleFavorite(ctx: HandlerContext<ToggleBody, QueryParams>): Promise<Response> {
  const { supabase, userId, body, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const mode = query.mode || "toggle";

  logger.info("Favorite operation", { mode, postId: body.postId, userId });

  let isFavorited: boolean;
  let action: "added" | "removed" | "unchanged";

  if (mode === "toggle") {
    // Use RPC for atomic toggle
    const { data, error } = await supabase.rpc("toggle_post_favorite_atomic", {
      p_user_id: userId,
      p_post_id: body.postId,
    });

    if (error) {
      logger.error("Toggle favorite failed", { error, postId: body.postId, userId });
      throw new ValidationError(`Failed to toggle favorite: ${error.message}`);
    }

    isFavorited = data.is_favorited;
    action = data.was_added ? "added" : "removed";
  } else if (mode === "add") {
    // Add favorite (upsert)
    const { error } = await supabase
      .from("favorites")
      .upsert(
        { user_id: userId, post_id: body.postId },
        { onConflict: "user_id,post_id", ignoreDuplicates: true }
      );

    if (error) {
      logger.error("Add favorite failed", { error, postId: body.postId, userId });
      throw new ValidationError(`Failed to add favorite: ${error.message}`);
    }

    isFavorited = true;
    action = "added";
  } else {
    // Remove favorite
    const { error } = await supabase
      .from("favorites")
      .delete()
      .eq("user_id", userId)
      .eq("post_id", body.postId);

    if (error) {
      logger.error("Remove favorite failed", { error, postId: body.postId, userId });
      throw new ValidationError(`Failed to remove favorite: ${error.message}`);
    }

    isFavorited = false;
    action = "removed";
  }

  // Get updated like count
  const { data: post } = await supabase
    .from("posts")
    .select("post_like_counter")
    .eq("id", body.postId)
    .single();

  logger.info("Favorite operation completed", {
    mode,
    postId: body.postId,
    action,
    isFavorited,
  });

  return ok({
    postId: body.postId,
    isFavorited,
    likeCount: post?.post_like_counter ?? 0,
    action,
  }, ctx);
}

// =============================================================================
// Helpers
// =============================================================================

async function logActivity(
  supabase: ReturnType<typeof import("../_shared/api-handler.ts").createAPIHandler>,
  postId: number,
  actorId: string | null,
  activityType: string,
  metadata?: Record<string, unknown>
) {
  try {
    // @ts-ignore - supabase client type
    await supabase.from("post_activity_logs").insert({
      post_id: postId,
      actor_id: actorId,
      activity_type: activityType,
      metadata: {
        ...metadata,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    // Don't fail the main operation if activity logging fails
    logger.warn("Failed to log activity", { postId, activityType, error: err });
  }
}

// =============================================================================
// Route Handlers
// =============================================================================

function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return ok({ status: "healthy", service: "api-v1-engagement", version: VERSION, timestamp: new Date().toISOString() }, ctx);
  }

  if (ctx.query.action === "bookmarks") {
    return getUserBookmarks(ctx);
  }
  return getEngagement(ctx);
}

function handlePost(ctx: HandlerContext<ToggleBody | ShareBody | BatchOperationsBody, QueryParams>): Promise<Response> {
  const url = new URL(ctx.request.url);
  
  if (url.pathname.endsWith("/batch")) {
    return handleBatchOperations(ctx as HandlerContext<BatchOperationsBody, QueryParams>);
  }
  
  const action = ctx.query.action;

  switch (action) {
    case "like":
      return toggleLike(ctx as HandlerContext<ToggleBody, QueryParams>);
    case "bookmark":
      return toggleBookmark(ctx as HandlerContext<ToggleBody, QueryParams>);
    case "favorite":
      return toggleFavorite(ctx as HandlerContext<ToggleBody, QueryParams>);
    case "share":
      return recordShare(ctx as HandlerContext<ShareBody, QueryParams>);
    default:
      throw new ValidationError("action query param required (like, bookmark, favorite, share)");
  }
}

async function handleBatchOperations(ctx: HandlerContext<BatchOperationsBody, QueryParams>): Promise<Response> {
  const { operations } = ctx.body;
  const { userId, supabase } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  logger.info("Processing batch operations", {
    count: operations.length,
    userId: userId.substring(0, 8),
    types: [...new Set(operations.map(op => op.type))],
  });

  const results = await Promise.all(
    operations.map(async (operation) => {
      try {
        let data: unknown;
        const entityId = parseInt(operation.entityId, 10);

        switch (operation.type) {
          case "toggle_favorite": {
            const { data: result, error } = await supabase.rpc("toggle_post_favorite_atomic", {
              p_user_id: userId,
              p_post_id: entityId,
            });
            if (error) throw new ServerError(error.message);
            data = { isFavorited: result.is_favorited, likeCount: result.like_count };
            break;
          }
          case "toggle_like": {
            const likeResult = await toggleRow(supabase, {
              table: "post_likes",
              entityColumn: "post_id",
              userColumn: "profile_id",
            }, entityId, userId);
            data = { isLiked: likeResult.active };
            break;
          }
          case "toggle_bookmark": {
            const bookmarkResult = await toggleRow(supabase, {
              table: "post_bookmarks",
              entityColumn: "post_id",
              userColumn: "profile_id",
            }, entityId, userId);
            data = { isBookmarked: bookmarkResult.active };
            break;
          }
          case "mark_read": {
            const { error } = await supabase.rpc("mark_messages_read", {
              p_room_id: operation.entityId,
              p_user_id: userId,
            });
            if (error) throw new ServerError(error.message);
            data = { markedRead: true };
            break;
          }
          case "archive_room": {
            const { error } = await supabase
              .from("room_members")
              .update({ is_archived: true })
              .eq("room_id", operation.entityId)
              .eq("profile_id", userId);
            if (error) throw new ServerError(error.message);
            data = { archived: true };
            break;
          }
        }

        return { correlationId: operation.correlationId, success: true, data };
      } catch (error) {
        return {
          correlationId: operation.correlationId,
          success: false,
          error: (error as Error).message,
        };
      }
    })
  );

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  return ok({
    totalOperations: operations.length,
    successful,
    failed,
    results,
  }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-engagement",
  version: "1.0.0",
  requireAuth: false, // GET is public, POST requires auth for most actions
  rateLimit: {
    limit: 120,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema,
      handler: handleGet,
      requireAuth: false,
    },
    POST: {
      querySchema,
      handler: handlePost,
      requireAuth: true,
    },
  },
}));
