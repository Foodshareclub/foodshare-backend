/**
 * Forum thread/post handlers
 *
 * CRUD operations for forum posts, feed listing, categories,
 * search, series, view tracking, and moderation actions.
 *
 * @module api-v1-forum/lib/threads
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { created, type HandlerContext, noContent, ok } from "../../_shared/api-handler.ts";
import { AuthorizationError, NotFoundError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import { cache, CACHE_TTLS } from "../../_shared/cache.ts";
import type { ForumQuery } from "../index.ts";

// =============================================================================
// Schemas
// =============================================================================

export const createPostSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(1).max(10000),
  categoryId: z.number().int().positive().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).default("discussion"),
  tags: z.array(z.number().int().positive()).max(5).optional(),
  imageUrl: z.string().url().optional(),
  richContent: z.record(z.unknown()).optional(),
});

export const updatePostSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(1).max(10000).optional(),
  categoryId: z.number().int().positive().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  tags: z.array(z.number().int().positive()).max(5).optional(),
  imageUrl: z.string().url().nullable().optional(),
  richContent: z.record(z.unknown()).nullable().optional(),
});

export const recordViewSchema = z.object({
  forumId: z.number().int().positive(),
});

export const togglePinSchema = z.object({
  forumId: z.number().int().positive(),
});

export const toggleLockSchema = z.object({
  forumId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export const removePostSchema = z.object({
  forumId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export const featurePostSchema = z.object({
  forumId: z.number().int().positive(),
  durationHours: z.number().int().positive().default(24),
  reason: z.string().max(500).optional(),
});

// =============================================================================
// GET Handlers
// =============================================================================

export async function getFeed(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  const categoryId = query.categoryId ? parseInt(query.categoryId) : null;
  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const offset = parseInt(query.offset || "0");

  const { data, error } = await supabase.rpc("get_forum_feed_data", {
    p_user_id: userId || null,
    p_category_id: categoryId,
    p_post_type: query.postType || null,
    p_sort_by: query.sortBy || "recent",
    p_page_limit: limit,
    p_page_offset: offset,
  });

  if (error) {
    logger.error("Feed query failed", new Error(error.message));
    throw new ValidationError(`Failed to load feed: ${error.message}`);
  }

  return ok(data, ctx);
}

export async function getPostDetail(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const postId = parseInt(query.id!);

  if (isNaN(postId)) {
    throw new ValidationError("Invalid post id");
  }

  const { data, error } = await supabase.rpc("get_forum_post_detail", {
    p_post_id: postId,
    p_user_id: userId || null,
  });

  if (error) {
    logger.error("Post detail query failed", new Error(error.message));
    throw new ValidationError(`Failed to load post: ${error.message}`);
  }

  if (!data) {
    throw new NotFoundError("Forum post", query.id);
  }

  return ok(data, ctx);
}

export async function getCategories(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase } = ctx;

  const cacheKey = "forum:categories";
  const cached = cache.get<unknown[]>(cacheKey);
  if (cached) {
    return ok(cached, ctx);
  }

  const { data, error } = await supabase
    .from("forum_categories")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    logger.error("Categories query failed", new Error(error.message));
    throw new ValidationError(`Failed to load categories: ${error.message}`);
  }

  cache.set(cacheKey, data, CACHE_TTLS.categories);
  return ok(data, ctx);
}

export async function searchPosts(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  if (!query.q || query.q.trim().length === 0) {
    throw new ValidationError("Search query (q) is required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const offset = parseInt(query.offset || "0");

  // Use advanced overload if filters present
  const hasFilters = query.tags || query.authorId || query.dateFrom || query.dateTo;

  if (hasFilters) {
    const tags = query.tags
      ? query.tags.split(",").map((t) => parseInt(t.trim())).filter((t) => !isNaN(t))
      : null;

    const { data, error } = await supabase.rpc("search_forum", {
      p_query: query.q.trim(),
      p_category_id: query.categoryId ? parseInt(query.categoryId) : null,
      p_tags: tags,
      p_author_id: query.authorId || null,
      p_date_from: query.dateFrom || null,
      p_date_to: query.dateTo || null,
      p_sort_by: query.sortBy || "relevance",
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      logger.error("Advanced search failed", new Error(error.message));
      throw new ValidationError(`Search failed: ${error.message}`);
    }

    return ok(data, ctx);
  }

  // Simple search
  const { data, error } = await supabase.rpc("search_forum", {
    p_query: query.q.trim(),
    p_category_id: query.categoryId ? parseInt(query.categoryId) : null,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    logger.error("Search failed", new Error(error.message));
    throw new ValidationError(`Search failed: ${error.message}`);
  }

  return ok(data, ctx);
}

export async function getUnread(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const categoryId = query.categoryId ? parseInt(query.categoryId) : null;

  const { data, error } = await supabase.rpc("get_unread_posts", {
    p_category_id: categoryId,
    p_limit: limit,
  });

  if (error) {
    logger.error("Unread query failed", new Error(error.message));
    throw new ValidationError(`Failed to load unread posts: ${error.message}`);
  }

  return ok(data, ctx);
}

export async function getSeries(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  if (!query.id) {
    throw new ValidationError("Series id is required");
  }

  const [seriesResult, postsResult] = await Promise.all([
    supabase
      .from("forum_series")
      .select("*")
      .eq("id", query.id)
      .single(),
    supabase
      .from("forum_series_posts")
      .select("*")
      .eq("series_id", query.id)
      .order("sort_order", { ascending: true }),
  ]);

  if (seriesResult.error || !seriesResult.data) {
    throw new NotFoundError("Forum series", query.id);
  }

  return ok({
    ...seriesResult.data,
    posts: postsResult.data || [],
  }, ctx);
}

// =============================================================================
// POST Handlers
// =============================================================================

export async function createPost(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = createPostSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Generate slug from title
  const slug = body.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 100) +
    "-" + Date.now().toString(36);

  const insertData: Record<string, unknown> = {
    forum_post_name: body.title,
    forum_post_description: body.description,
    profile_id: userId,
    category_id: body.categoryId || null,
    post_type: body.postType,
    slug,
    forum_post_image: body.imageUrl || null,
    rich_content: body.richContent || null,
    forum_published: true,
  };

  const { data, error } = await supabase
    .from("forum")
    .insert(insertData)
    .select("id, slug, forum_post_name, forum_post_created_at")
    .single();

  if (error) {
    logger.error("Create post failed", new Error(error.message));
    throw new ValidationError(`Failed to create post: ${error.message}`);
  }

  // Insert tags if provided
  if (body.tags && body.tags.length > 0) {
    const tagRows = body.tags.map((tagId) => ({
      forum_id: data.id,
      tag_id: tagId,
    }));

    const { error: tagError } = await supabase
      .from("forum_post_tags")
      .insert(tagRows);

    if (tagError) {
      logger.warn("Failed to insert tags", { error: tagError.message, forumId: data.id });
    }
  }

  logger.info("Forum post created", { forumId: data.id, userId });

  return created(data, ctx);
}

export async function recordView(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = recordViewSchema.parse(ctx.body);

  const { error } = await supabase.rpc("increment_forum_view", {
    p_forum_id: body.forumId,
  });

  if (error) {
    logger.warn("Record view failed", { error: error.message, forumId: body.forumId });
  }

  return ok({ recorded: true }, ctx);
}

export async function togglePin(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = togglePinSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify ownership or mod status
  const { data: post, error: fetchError } = await supabase
    .from("forum")
    .select("id, profile_id, is_pinned")
    .eq("id", body.forumId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !post) {
    throw new NotFoundError("Forum post", String(body.forumId));
  }

  if (post.profile_id !== userId) {
    throw new AuthorizationError("Only the post author or a moderator can pin/unpin");
  }

  const { error } = await supabase
    .from("forum")
    .update({ is_pinned: !post.is_pinned })
    .eq("id", body.forumId);

  if (error) {
    logger.error("Toggle pin failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle pin: ${error.message}`);
  }

  logger.info("Pin toggled", { forumId: body.forumId, isPinned: !post.is_pinned, userId });

  return ok({ forumId: body.forumId, isPinned: !post.is_pinned }, ctx);
}

export async function toggleLock(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = toggleLockSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("moderate_toggle_post_lock", {
    p_forum_id: body.forumId,
    p_reason: body.reason || null,
  });

  if (error) {
    logger.error("Toggle lock failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle lock: ${error.message}`);
  }

  logger.info("Lock toggled", { forumId: body.forumId });

  return ok({ forumId: body.forumId, isLocked: data }, ctx);
}

export async function removePost(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = removePostSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("moderate_remove_post", {
    p_forum_id: body.forumId,
    p_reason: body.reason || null,
  });

  if (error) {
    logger.error("Remove post failed", new Error(error.message));
    throw new ValidationError(`Failed to remove post: ${error.message}`);
  }

  logger.info("Post removed by moderator", { forumId: body.forumId });

  return ok({ forumId: body.forumId, removed: data }, ctx);
}

export async function featurePost(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = featurePostSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("feature_forum_post", {
    p_forum_id: body.forumId,
    p_duration_hours: body.durationHours,
    p_reason: body.reason || null,
  });

  if (error) {
    logger.error("Feature post failed", new Error(error.message));
    throw new ValidationError(`Failed to feature post: ${error.message}`);
  }

  logger.info("Post featured", { forumId: body.forumId, durationHours: body.durationHours });

  return ok({ forumId: body.forumId, featured: data }, ctx);
}

// =============================================================================
// PUT Handlers
// =============================================================================

export async function updatePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const body = updatePostSchema.parse(ctx.body);
  const postId = parseInt(query.id!);

  if (isNaN(postId)) {
    throw new ValidationError("Invalid post id");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify ownership
  const { data: post, error: fetchError } = await supabase
    .from("forum")
    .select("id, profile_id")
    .eq("id", postId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !post) {
    throw new NotFoundError("Forum post", query.id);
  }

  if (post.profile_id !== userId) {
    throw new AuthorizationError("You can only edit your own posts");
  }

  const updateData: Record<string, unknown> = {
    is_edited: true,
    forum_post_updated_at: new Date().toISOString(),
  };

  if (body.title !== undefined) updateData.forum_post_name = body.title;
  if (body.description !== undefined) updateData.forum_post_description = body.description;
  if (body.categoryId !== undefined) updateData.category_id = body.categoryId;
  if (body.postType !== undefined) updateData.post_type = body.postType;
  if (body.imageUrl !== undefined) updateData.forum_post_image = body.imageUrl;
  if (body.richContent !== undefined) updateData.rich_content = body.richContent;

  const { data, error } = await supabase
    .from("forum")
    .update(updateData)
    .eq("id", postId)
    .select("id, forum_post_name, forum_post_updated_at, slug")
    .single();

  if (error) {
    logger.error("Update post failed", new Error(error.message));
    throw new ValidationError(`Failed to update post: ${error.message}`);
  }

  // Update tags if provided
  if (body.tags !== undefined) {
    // Delete existing tags
    await supabase
      .from("forum_post_tags")
      .delete()
      .eq("forum_id", postId);

    // Insert new tags
    if (body.tags.length > 0) {
      const tagRows = body.tags.map((tagId) => ({
        forum_id: postId,
        tag_id: tagId,
      }));

      const { error: tagError } = await supabase
        .from("forum_post_tags")
        .insert(tagRows);

      if (tagError) {
        logger.warn("Failed to update tags", { error: tagError.message, forumId: postId });
      }
    }
  }

  logger.info("Forum post updated", { forumId: postId, userId });

  return ok(data, ctx);
}

// =============================================================================
// DELETE Handlers
// =============================================================================

export async function deletePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const postId = parseInt(query.id!);

  if (isNaN(postId)) {
    throw new ValidationError("Invalid post id");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify ownership
  const { data: post, error: fetchError } = await supabase
    .from("forum")
    .select("id, profile_id")
    .eq("id", postId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !post) {
    throw new NotFoundError("Forum post", query.id);
  }

  if (post.profile_id !== userId) {
    throw new AuthorizationError("You can only delete your own posts");
  }

  // Soft delete
  const { error } = await supabase
    .from("forum")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", postId);

  if (error) {
    logger.error("Delete post failed", new Error(error.message));
    throw new ValidationError(`Failed to delete post: ${error.message}`);
  }

  logger.info("Forum post deleted", { forumId: postId, userId });

  return noContent(ctx);
}
