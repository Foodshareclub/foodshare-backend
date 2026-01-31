/**
 * Engagement API v1
 *
 * REST API for post engagement operations (likes, bookmarks, shares).
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-engagement?postId=<id>           - Get engagement status
 * - GET    /api-v1-engagement?postIds=1,2,3         - Batch get engagement
 * - POST   /api-v1-engagement?action=like           - Toggle like
 * - POST   /api-v1-engagement?action=bookmark       - Toggle bookmark
 * - POST   /api-v1-engagement?action=share          - Record share
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
import { ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

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

const querySchema = z.object({
  postId: z.string().optional(),
  postIds: z.string().optional(), // Comma-separated for batch
  action: z.enum(["like", "bookmark", "share", "bookmarks"]).optional(),
  limit: z.string().optional(),
});

type ToggleBody = z.infer<typeof toggleEngagementSchema>;
type ShareBody = z.infer<typeof shareSchema>;
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

  // Check if already liked
  const { data: existing } = await supabase
    .from("post_likes")
    .select("id")
    .eq("post_id", body.postId)
    .eq("profile_id", userId)
    .single();

  let isLiked: boolean;

  if (existing) {
    // Unlike
    await supabase
      .from("post_likes")
      .delete()
      .eq("post_id", body.postId)
      .eq("profile_id", userId);
    isLiked = false;

    // Log activity
    await logActivity(supabase, body.postId, userId, "unliked");
  } else {
    // Like
    await supabase.from("post_likes").insert({
      post_id: body.postId,
      profile_id: userId,
    });
    isLiked = true;

    // Log activity
    await logActivity(supabase, body.postId, userId, "liked");
  }

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

  // Check if already bookmarked
  const { data: existing } = await supabase
    .from("post_bookmarks")
    .select("id")
    .eq("post_id", body.postId)
    .eq("profile_id", userId)
    .single();

  let isBookmarked: boolean;

  if (existing) {
    // Remove bookmark
    await supabase
      .from("post_bookmarks")
      .delete()
      .eq("post_id", body.postId)
      .eq("profile_id", userId);
    isBookmarked = false;

    // Log activity
    await logActivity(supabase, body.postId, userId, "unbookmarked");
  } else {
    // Add bookmark
    await supabase.from("post_bookmarks").insert({
      post_id: body.postId,
      profile_id: userId,
    });
    isBookmarked = true;

    // Log activity
    await logActivity(supabase, body.postId, userId, "bookmarked");
  }

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

async function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  if (ctx.query.action === "bookmarks") {
    return getUserBookmarks(ctx);
  }
  return getEngagement(ctx);
}

async function handlePost(ctx: HandlerContext<ToggleBody | ShareBody, QueryParams>): Promise<Response> {
  const action = ctx.query.action;

  switch (action) {
    case "like":
      return toggleLike(ctx as HandlerContext<ToggleBody, QueryParams>);
    case "bookmark":
      return toggleBookmark(ctx as HandlerContext<ToggleBody, QueryParams>);
    case "share":
      return recordShare(ctx as HandlerContext<ShareBody, QueryParams>);
    default:
      throw new ValidationError("action query param required (like, bookmark, share)");
  }
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
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
});
