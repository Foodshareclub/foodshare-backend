/**
 * Forum thread/post handlers
 *
 * CRUD operations for forum posts, feed listing, categories,
 * search, series, view tracking, and moderation actions.
 *
 * @module api-v1-forum/lib/threads
 */

import { positiveIntSchema, z } from "../../_shared/schemas/common.ts";
import { created, type HandlerContext, noContent, ok } from "../../_shared/api-handler.ts";
import { AuthorizationError, NotFoundError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import { cache, CACHE_TTLS } from "../../_shared/cache.ts";
import type { ForumQuery } from "../index.ts";
import { ForumService } from "./forum-service.ts";

// =============================================================================
// Schemas
// =============================================================================

export const createPostSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(1).max(10000),
  categoryId: positiveIntSchema.optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).default("discussion"),
  tags: z.array(positiveIntSchema).max(5).optional(),
  imageUrl: z.string().url().optional(),
  richContent: z.record(z.unknown()).optional(),
});

export const updatePostSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(1).max(10000).optional(),
  categoryId: positiveIntSchema.optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  tags: z.array(positiveIntSchema).max(5).optional(),
  imageUrl: z.string().url().nullable().optional(),
  richContent: z.record(z.unknown()).nullable().optional(),
});

export const recordViewSchema = z.object({
  forumId: positiveIntSchema,
});

export const togglePinSchema = z.object({
  forumId: positiveIntSchema,
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
// Helpers
// =============================================================================

const MODERATOR_ROLES = ["moderator", "admin", "superadmin"];

// deno-lint-ignore no-explicit-any
async function hasModeratorRole(supabase: any, userId: string): Promise<boolean> {
  const { data: userRoles } = await supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", userId);

  if (!userRoles || userRoles.length === 0) return false;

  return userRoles.some((r: { roles: { name: string } | { name: string }[] }) => {
    const roleData = r.roles as unknown as { name: string } | { name: string }[];
    const name = Array.isArray(roleData) ? roleData[0]?.name : roleData?.name;
    return name && MODERATOR_ROLES.includes(name);
  });
}

// =============================================================================
// GET Handlers
// =============================================================================

export async function getFeed(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  const service = new ForumService(supabase, userId || "");
  
  const data = await service.getFeed({
    categoryId: query.categoryId ? parseInt(query.categoryId) : undefined,
    postType: query.postType,
    sortBy: query.sortBy,
    limit: Math.min(parseInt(query.limit || "20"), 50),
    offset: parseInt(query.offset || "0"),
  });

  return ok(data, ctx);
}

export async function getPostDetail(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const postId = parseInt(query.id!);

  if (isNaN(postId)) {
    throw new ValidationError("Invalid post id");
  }

  const service = new ForumService(supabase, userId || "");
  const data = await service.getPost(postId, userId);

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
  const tags = query.tags
    ? query.tags.split(",").map((t) => parseInt(t.trim())).filter((t) => !isNaN(t))
    : undefined;

  const service = new ForumService(supabase, "");
  const data = await service.searchPosts({
    query: query.q.trim(),
    categoryId: query.categoryId ? parseInt(query.categoryId) : undefined,
    tags,
    authorId: query.authorId,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    sortBy: query.sortBy,
    limit,
    offset,
  });

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

  const service = new ForumService(supabase, userId);
  const data = await service.createPost({
    title: body.title,
    description: body.description,
    categoryId: body.categoryId,
    postType: body.postType,
    imageUrl: body.imageUrl,
    richContent: body.richContent,
    tags: body.tags,
  });

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
    // Check moderator role
    const isMod = await hasModeratorRole(supabase, userId);
    if (!isMod) {
      throw new AuthorizationError("Only the post author or a moderator can pin/unpin");
    }
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
  const { supabase, userId } = ctx;
  const body = toggleLockSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const isMod = await hasModeratorRole(supabase, userId);
  if (!isMod) {
    throw new AuthorizationError("Moderator access required");
  }

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
  const { supabase, userId } = ctx;
  const body = removePostSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const isMod = await hasModeratorRole(supabase, userId);
  if (!isMod) {
    throw new AuthorizationError("Moderator access required");
  }

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

  const service = new ForumService(supabase, userId);
  const data = await service.updatePost(postId, {
    title: body.title,
    description: body.description,
    categoryId: body.categoryId,
    postType: body.postType,
    imageUrl: body.imageUrl,
    richContent: body.richContent,
    tags: body.tags,
  });

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

  const service = new ForumService(supabase, userId);
  await service.deletePost(postId);

  return noContent(ctx);
}
