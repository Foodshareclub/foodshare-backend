/**
 * Forum API v1
 *
 * REST API for community forum operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-forum                          - Feed listing
 * - GET    /api-v1-forum?id=<id>                  - Post detail
 * - GET    /api-v1-forum?action=categories        - List categories
 * - GET    /api-v1-forum?action=search&q=<query>  - Search posts
 * - GET    /api-v1-forum?action=drafts            - User drafts (auth)
 * - GET    /api-v1-forum?action=bookmarks         - User bookmarks (auth)
 * - GET    /api-v1-forum?action=unread            - Unread posts (auth)
 * - GET    /api-v1-forum?action=series&id=<id>    - Series detail
 * - POST   /api-v1-forum?action=create            - Create post
 * - POST   /api-v1-forum?action=comment           - Add comment
 * - POST   /api-v1-forum?action=like              - Toggle like
 * - POST   /api-v1-forum?action=bookmark          - Toggle bookmark
 * - POST   /api-v1-forum?action=react             - Toggle reaction
 * - POST   /api-v1-forum?action=subscribe         - Toggle subscription
 * - POST   /api-v1-forum?action=report            - Report content
 * - POST   /api-v1-forum?action=draft             - Save draft
 * - POST   /api-v1-forum?action=poll              - Create poll
 * - POST   /api-v1-forum?action=vote              - Vote on poll
 * - POST   /api-v1-forum?action=view              - Record view
 * - POST   /api-v1-forum?action=pin               - Toggle pin
 * - POST   /api-v1-forum?action=lock              - Toggle lock (mod)
 * - POST   /api-v1-forum?action=remove            - Remove post (mod)
 * - POST   /api-v1-forum?action=feature           - Feature post (mod)
 * - POST   /api-v1-forum?action=best-answer       - Mark best answer
 * - PUT    /api-v1-forum?id=<id>                  - Update post
 * - PUT    /api-v1-forum?action=comment&id=<id>   - Update comment
 * - DELETE /api-v1-forum?id=<id>                  - Delete post
 * - DELETE /api-v1-forum?action=comment&id=<id>   - Delete comment
 * - DELETE /api-v1-forum?action=draft&id=<id>     - Delete draft
 *
 * @module api-v1-forum
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  created,
  noContent,
  paginated,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import {
  ValidationError,
  NotFoundError,
  AuthorizationError,
} from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { cache, CACHE_TTLS } from "../_shared/cache.ts";

const VERSION = "1.0.0";

// =============================================================================
// Schemas
// =============================================================================

const forumQuerySchema = z.object({
  action: z.enum([
    "categories", "search", "drafts", "bookmarks", "unread", "series",
    "create", "comment", "like", "bookmark", "react", "subscribe",
    "report", "draft", "poll", "vote", "view", "pin", "lock",
    "remove", "feature", "best-answer",
  ]).optional(),
  id: z.string().optional(),
  q: z.string().optional(),
  categoryId: z.string().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  sortBy: z.enum(["recent", "popular", "trending", "unanswered"]).optional(),
  authorId: z.string().uuid().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tags: z.string().optional(), // comma-separated tag IDs
  limit: z.string().optional(),
  offset: z.string().optional(),
});

type ForumQuery = z.infer<typeof forumQuerySchema>;

const createPostSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(1).max(10000),
  categoryId: z.number().int().positive().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).default("discussion"),
  tags: z.array(z.number().int().positive()).max(5).optional(),
  imageUrl: z.string().url().optional(),
  richContent: z.record(z.unknown()).optional(),
});

const updatePostSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(1).max(10000).optional(),
  categoryId: z.number().int().positive().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  tags: z.array(z.number().int().positive()).max(5).optional(),
  imageUrl: z.string().url().nullable().optional(),
  richContent: z.record(z.unknown()).nullable().optional(),
});

const createCommentSchema = z.object({
  forumId: z.number().int().positive(),
  content: z.string().min(1).max(5000),
  parentId: z.number().int().positive().optional(),
  richContent: z.record(z.unknown()).optional(),
});

const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  richContent: z.record(z.unknown()).nullable().optional(),
});

const toggleLikeSchema = z.object({
  forumId: z.number().int().positive(),
});

const toggleBookmarkSchema = z.object({
  forumId: z.number().int().positive(),
});

const toggleReactionSchema = z.object({
  forumId: z.number().int().positive(),
  reactionType: z.string().min(1).max(50),
});

const toggleSubscriptionSchema = z.object({
  forumId: z.number().int().positive().optional(),
  categoryId: z.number().int().positive().optional(),
});

const submitReportSchema = z.object({
  forumId: z.number().int().positive().optional(),
  commentId: z.number().int().positive().optional(),
  reason: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
});

const saveDraftSchema = z.object({
  draftId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(10000).optional(),
  richContent: z.record(z.unknown()).optional(),
  categoryId: z.number().int().positive().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  tags: z.array(z.number().int().positive()).max(5).optional(),
  imageUrl: z.string().url().optional(),
  pollData: z.record(z.unknown()).optional(),
});

const createPollSchema = z.object({
  forumId: z.number().int().positive(),
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(20),
  pollType: z.enum(["single", "multiple"]).default("single"),
  endsAt: z.string().datetime().optional(),
  isAnonymous: z.boolean().default(false),
  showResultsBeforeVote: z.boolean().default(false),
});

const votePollSchema = z.object({
  pollId: z.string().uuid(),
  optionId: z.string().uuid(),
});

const recordViewSchema = z.object({
  forumId: z.number().int().positive(),
});

const togglePinSchema = z.object({
  forumId: z.number().int().positive(),
});

const toggleLockSchema = z.object({
  forumId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

const removePostSchema = z.object({
  forumId: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

const featurePostSchema = z.object({
  forumId: z.number().int().positive(),
  durationHours: z.number().int().positive().default(24),
  reason: z.string().max(500).optional(),
});

const markBestAnswerSchema = z.object({
  forumId: z.number().int().positive(),
  commentId: z.number().int().positive(),
});

// =============================================================================
// GET Handlers
// =============================================================================

async function getFeed(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function getPostDetail(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function getCategories(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function searchPosts(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  if (!query.q || query.q.trim().length === 0) {
    throw new ValidationError("Search query (q) is required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const offset = parseInt(query.offset || "0");

  // Use advanced overload if filters present
  const hasFilters = query.tags || query.authorId || query.dateFrom || query.dateTo;

  if (hasFilters) {
    const tags = query.tags ? query.tags.split(",").map((t) => parseInt(t.trim())).filter((t) => !isNaN(t)) : null;

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

async function getDrafts(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const offset = parseInt(query.offset || "0");

  const { data, error, count } = await supabase
    .from("forum_drafts")
    .select("*", { count: "exact" })
    .eq("profile_id", userId)
    .order("last_saved_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error("Drafts query failed", new Error(error.message));
    throw new ValidationError(`Failed to load drafts: ${error.message}`);
  }

  return paginated(data || [], ctx, {
    offset,
    limit,
    total: count || 0,
  });
}

async function getBookmarks(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const offset = parseInt(query.offset || "0");

  const { data, error, count } = await supabase
    .from("bookmarks")
    .select("*", { count: "exact" })
    .eq("profile_id", userId)
    .gt("forum_id", 0)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error("Bookmarks query failed", new Error(error.message));
    throw new ValidationError(`Failed to load bookmarks: ${error.message}`);
  }

  return paginated(data || [], ctx, {
    offset,
    limit,
    total: count || 0,
  });
}

async function getUnread(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function getSeries(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function createPost(ctx: HandlerContext): Promise<Response> {
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
    .substring(0, 100)
    + "-" + Date.now().toString(36);

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

async function createComment(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = createCommentSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const { data, error } = await supabase.rpc("create_forum_comment", {
    p_user_id: userId,
    p_forum_id: body.forumId,
    p_content: body.content,
    p_parent_id: body.parentId || null,
    p_rich_content: body.richContent || null,
  });

  if (error) {
    logger.error("Create comment failed", new Error(error.message));
    throw new ValidationError(`Failed to create comment: ${error.message}`);
  }

  logger.info("Comment created", { forumId: body.forumId, userId });

  return created(data, ctx);
}

async function toggleLike(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = toggleLikeSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("toggle_forum_like", {
    p_forum_id: body.forumId,
  });

  if (error) {
    logger.error("Toggle like failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle like: ${error.message}`);
  }

  return ok(data, ctx);
}

async function toggleBookmark(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = toggleBookmarkSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("toggle_forum_bookmark", {
    p_forum_id: body.forumId,
  });

  if (error) {
    logger.error("Toggle bookmark failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle bookmark: ${error.message}`);
  }

  return ok(data, ctx);
}

async function toggleReaction(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = toggleReactionSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("toggle_forum_reaction", {
    p_forum_id: body.forumId,
    p_reaction_type: body.reactionType,
  });

  if (error) {
    logger.error("Toggle reaction failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle reaction: ${error.message}`);
  }

  return ok(data, ctx);
}

async function toggleSubscription(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = toggleSubscriptionSchema.parse(ctx.body);

  if (!body.forumId && !body.categoryId) {
    throw new ValidationError("Either forumId or categoryId is required");
  }

  const { data, error } = await supabase.rpc("toggle_forum_subscription", {
    p_forum_id: body.forumId || null,
    p_category_id: body.categoryId || null,
  });

  if (error) {
    logger.error("Toggle subscription failed", new Error(error.message));
    throw new ValidationError(`Failed to toggle subscription: ${error.message}`);
  }

  return ok(data, ctx);
}

async function submitReport(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = submitReportSchema.parse(ctx.body);

  if (!body.forumId && !body.commentId) {
    throw new ValidationError("Either forumId or commentId is required");
  }

  const { data, error } = await supabase.rpc("submit_forum_report", {
    p_forum_id: body.forumId || null,
    p_comment_id: body.commentId || null,
    p_reason: body.reason,
    p_description: body.description || null,
  });

  if (error) {
    logger.error("Submit report failed", new Error(error.message));
    throw new ValidationError(`Failed to submit report: ${error.message}`);
  }

  logger.info("Forum report submitted", { forumId: body.forumId, commentId: body.commentId });

  return created({ reportId: data }, ctx);
}

async function saveDraft(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = saveDraftSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("save_forum_draft", {
    p_draft_id: body.draftId || null,
    p_title: body.title || null,
    p_description: body.description || null,
    p_rich_content: body.richContent || null,
    p_category_id: body.categoryId || null,
    p_post_type: body.postType || "discussion",
    p_tags: body.tags || null,
    p_image_url: body.imageUrl || null,
    p_poll_data: body.pollData || null,
  });

  if (error) {
    logger.error("Save draft failed", new Error(error.message));
    throw new ValidationError(`Failed to save draft: ${error.message}`);
  }

  return ok(data, ctx);
}

async function createPoll(ctx: HandlerContext): Promise<Response> {
  const { supabase } = ctx;
  const body = createPollSchema.parse(ctx.body);

  const { data, error } = await supabase.rpc("create_forum_poll", {
    p_forum_id: body.forumId,
    p_question: body.question,
    p_options: body.options,
    p_poll_type: body.pollType,
    p_ends_at: body.endsAt || null,
    p_is_anonymous: body.isAnonymous,
    p_show_results_before_vote: body.showResultsBeforeVote,
  });

  if (error) {
    logger.error("Create poll failed", new Error(error.message));
    throw new ValidationError(`Failed to create poll: ${error.message}`);
  }

  logger.info("Poll created", { forumId: body.forumId });

  return created(data, ctx);
}

async function votePoll(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = votePollSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Insert vote (unique constraint will prevent duplicates)
  const { data, error } = await supabase
    .from("forum_poll_votes")
    .insert({
      poll_id: body.pollId,
      option_id: body.optionId,
      profile_id: userId,
    })
    .select("id, poll_id, option_id, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ValidationError("You have already voted on this poll");
    }
    logger.error("Vote failed", new Error(error.message));
    throw new ValidationError(`Failed to vote: ${error.message}`);
  }

  // Increment vote count on the option (non-critical — triggers may handle this)
  try {
    await supabase.rpc("increment_poll_option_votes", { p_option_id: body.optionId });
  } catch {
    // Ignore — vote count triggers may handle this
  }

  logger.info("Poll vote recorded", { pollId: body.pollId, userId });

  return created(data, ctx);
}

async function recordView(ctx: HandlerContext): Promise<Response> {
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

async function togglePin(ctx: HandlerContext): Promise<Response> {
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

async function toggleLock(ctx: HandlerContext): Promise<Response> {
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

async function removePost(ctx: HandlerContext): Promise<Response> {
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

async function featurePost(ctx: HandlerContext): Promise<Response> {
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

async function markBestAnswer(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = markBestAnswerSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify post ownership (only post author can mark best answer)
  const { data: post, error: fetchError } = await supabase
    .from("forum")
    .select("id, profile_id")
    .eq("id", body.forumId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !post) {
    throw new NotFoundError("Forum post", String(body.forumId));
  }

  if (post.profile_id !== userId) {
    throw new AuthorizationError("Only the post author can mark the best answer");
  }

  // Verify comment exists on this post
  const { data: comment, error: commentError } = await supabase
    .from("comments")
    .select("id")
    .eq("id", body.commentId)
    .eq("forum_id", body.forumId)
    .single();

  if (commentError || !comment) {
    throw new NotFoundError("Comment", String(body.commentId));
  }

  // Clear any existing best answer, set new one
  const [updateForum, , updateNewComment] = await Promise.all([
    supabase
      .from("forum")
      .update({ best_answer_id: body.commentId })
      .eq("id", body.forumId),
    supabase
      .from("comments")
      .update({ is_best_answer: false })
      .eq("forum_id", body.forumId)
      .eq("is_best_answer", true),
    supabase
      .from("comments")
      .update({ is_best_answer: true })
      .eq("id", body.commentId),
  ]);

  if (updateForum.error || updateNewComment.error) {
    const err = updateForum.error || updateNewComment.error;
    logger.error("Mark best answer failed", new Error(err!.message));
    throw new ValidationError(`Failed to mark best answer: ${err!.message}`);
  }

  logger.info("Best answer marked", { forumId: body.forumId, commentId: body.commentId, userId });

  return ok({ forumId: body.forumId, bestAnswerId: body.commentId }, ctx);
}

// =============================================================================
// PUT Handlers
// =============================================================================

async function updatePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function updateComment(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const body = updateCommentSchema.parse(ctx.body);
  const commentId = parseInt(query.id!);

  if (isNaN(commentId)) {
    throw new ValidationError("Invalid comment id");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify ownership
  const { data: comment, error: fetchError } = await supabase
    .from("comments")
    .select("id, user_id")
    .eq("id", commentId)
    .single();

  if (fetchError || !comment) {
    throw new NotFoundError("Comment", query.id);
  }

  if (comment.user_id !== userId) {
    throw new AuthorizationError("You can only edit your own comments");
  }

  const updateData: Record<string, unknown> = {
    comment: body.content,
    is_edited: true,
    updated_at: new Date().toISOString(),
  };

  if (body.richContent !== undefined) updateData.rich_content = body.richContent;

  const { data, error } = await supabase
    .from("comments")
    .update(updateData)
    .eq("id", commentId)
    .select("id, comment, updated_at")
    .single();

  if (error) {
    logger.error("Update comment failed", new Error(error.message));
    throw new ValidationError(`Failed to update comment: ${error.message}`);
  }

  logger.info("Comment updated", { commentId, userId });

  return ok(data, ctx);
}

// =============================================================================
// DELETE Handlers
// =============================================================================

async function deletePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

async function deleteComment(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const commentId = parseInt(query.id!);

  if (isNaN(commentId)) {
    throw new ValidationError("Invalid comment id");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify ownership
  const { data: comment, error: fetchError } = await supabase
    .from("comments")
    .select("id, user_id")
    .eq("id", commentId)
    .single();

  if (fetchError || !comment) {
    throw new NotFoundError("Comment", query.id);
  }

  if (comment.user_id !== userId) {
    throw new AuthorizationError("You can only delete your own comments");
  }

  // Soft delete — set comment text to indicate deletion, preserve row for threading
  const { error } = await supabase
    .from("comments")
    .update({
      comment: "[deleted]",
      updated_at: new Date().toISOString(),
    })
    .eq("id", commentId);

  if (error) {
    logger.error("Delete comment failed", new Error(error.message));
    throw new ValidationError(`Failed to delete comment: ${error.message}`);
  }

  logger.info("Comment deleted", { commentId, userId });

  return noContent(ctx);
}

async function deleteDraft(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!query.id) {
    throw new ValidationError("Draft id is required");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Hard delete (drafts are user-owned temporary data)
  const { error } = await supabase
    .from("forum_drafts")
    .delete()
    .eq("id", query.id)
    .eq("profile_id", userId);

  if (error) {
    logger.error("Delete draft failed", new Error(error.message));
    throw new ValidationError(`Failed to delete draft: ${error.message}`);
  }

  logger.info("Draft deleted", { draftId: query.id, userId });

  return noContent(ctx);
}

// =============================================================================
// Route Dispatchers
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return ok({
      status: "healthy",
      service: "api-v1-forum",
      version: VERSION,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  const { query } = ctx;

  // Post detail by id (no action)
  if (query.id && !query.action) {
    return getPostDetail(ctx);
  }

  switch (query.action) {
    case "categories":
      return getCategories(ctx);
    case "search":
      return searchPosts(ctx);
    case "drafts":
      return getDrafts(ctx);
    case "bookmarks":
      return getBookmarks(ctx);
    case "unread":
      return getUnread(ctx);
    case "series":
      return getSeries(ctx);
    default:
      return getFeed(ctx);
  }
}

async function handlePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  switch (query.action) {
    case "create":
      return createPost(ctx);
    case "comment":
      return createComment(ctx);
    case "like":
      return toggleLike(ctx);
    case "bookmark":
      return toggleBookmark(ctx);
    case "react":
      return toggleReaction(ctx);
    case "subscribe":
      return toggleSubscription(ctx);
    case "report":
      return submitReport(ctx);
    case "draft":
      return saveDraft(ctx);
    case "poll":
      return createPoll(ctx);
    case "vote":
      return votePoll(ctx);
    case "view":
      return recordView(ctx);
    case "pin":
      return togglePin(ctx);
    case "lock":
      return toggleLock(ctx);
    case "remove":
      return removePost(ctx);
    case "feature":
      return featurePost(ctx);
    case "best-answer":
      return markBestAnswer(ctx);
    default:
      throw new ValidationError(
        "action query param required (create, comment, like, bookmark, react, subscribe, report, draft, poll, vote, view, pin, lock, remove, feature, best-answer)"
      );
  }
}

async function handlePut(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  if (!query.id) {
    throw new ValidationError("id query param required for PUT");
  }

  if (query.action === "comment") {
    return updateComment(ctx);
  }

  return updatePost(ctx);
}

async function handleDelete(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  if (!query.id && query.action !== "draft") {
    throw new ValidationError("id query param required for DELETE");
  }

  switch (query.action) {
    case "comment":
      return deleteComment(ctx);
    case "draft":
      return deleteDraft(ctx);
    default:
      return deletePost(ctx);
  }
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-forum",
  version: VERSION,
  requireAuth: false, // GET is public, mutations require auth
  rateLimit: {
    limit: 120,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema: forumQuerySchema,
      handler: handleGet,
      requireAuth: false,
    },
    POST: {
      querySchema: forumQuerySchema,
      handler: handlePost,
      requireAuth: true,
    },
    PUT: {
      querySchema: forumQuerySchema,
      handler: handlePut,
      requireAuth: true,
    },
    DELETE: {
      querySchema: forumQuerySchema,
      handler: handleDelete,
      requireAuth: true,
    },
  },
});
