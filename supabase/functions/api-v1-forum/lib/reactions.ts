/**
 * Forum engagement/reaction handlers
 *
 * User engagement actions: likes, bookmarks, reactions, subscriptions,
 * reports, drafts, polls, and voting.
 *
 * @module api-v1-forum/lib/reactions
 */

import { datetimeSchema, positiveIntSchema, uuidSchema, z } from "../../_shared/schemas/common.ts";
import {
  created,
  type HandlerContext,
  noContent,
  ok,
} from "../../_shared/api-handler.ts";
import { ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import type { ForumQuery } from "../index.ts";
import { EngagementService } from "./engagement-service.ts";

// =============================================================================
// Schemas
// =============================================================================

export const toggleLikeSchema = z.object({
  forumId: positiveIntSchema,
});

export const toggleBookmarkSchema = z.object({
  forumId: positiveIntSchema,
});

export const toggleReactionSchema = z.object({
  forumId: positiveIntSchema,
  reactionType: z.string().min(1).max(50),
});

export const toggleSubscriptionSchema = z.object({
  forumId: positiveIntSchema.optional(),
  categoryId: positiveIntSchema.optional(),
});

export const submitReportSchema = z.object({
  forumId: positiveIntSchema.optional(),
  commentId: positiveIntSchema.optional(),
  reason: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
});

export const saveDraftSchema = z.object({
  draftId: uuidSchema.optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(10000).optional(),
  richContent: z.record(z.unknown()).optional(),
  categoryId: positiveIntSchema.optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  tags: z.array(positiveIntSchema).max(5).optional(),
  imageUrl: z.string().url().optional(),
  pollData: z.record(z.unknown()).optional(),
});

export const createPollSchema = z.object({
  forumId: positiveIntSchema,
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(200)).min(2).max(20),
  pollType: z.enum(["single", "multiple"]).default("single"),
  endsAt: datetimeSchema.optional(),
  isAnonymous: z.boolean().default(false),
  showResultsBeforeVote: z.boolean().default(false),
});

export const votePollSchema = z.object({
  pollId: uuidSchema,
  optionId: uuidSchema,
});

// =============================================================================
// GET Handlers
// =============================================================================

export async function getDrafts(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

export async function getBookmarks(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

// =============================================================================
// POST Handlers
// =============================================================================

export async function toggleLike(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = toggleLikeSchema.parse(ctx.body);

  if (!userId) throw new ValidationError("Authentication required");

  const service = new EngagementService(supabase, userId);
  const data = await service.toggleLike(body.forumId);

  return ok(data, ctx);
}

export async function toggleBookmark(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = toggleBookmarkSchema.parse(ctx.body);

  if (!userId) throw new ValidationError("Authentication required");

  const service = new EngagementService(supabase, userId);
  const data = await service.toggleBookmark(body.forumId);

  return ok(data, ctx);
}

export async function toggleReaction(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = toggleReactionSchema.parse(ctx.body);

  if (!userId) throw new ValidationError("Authentication required");

  const service = new EngagementService(supabase, userId);
  const data = await service.toggleReaction(body.forumId, body.reactionType);

  return ok(data, ctx);
}

export async function toggleSubscription(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = toggleSubscriptionSchema.parse(ctx.body);

  if (!userId) throw new ValidationError("Authentication required");
  if (!body.forumId) throw new ValidationError("forumId is required");

  const service = new EngagementService(supabase, userId);
  const data = await service.toggleSubscription(body.forumId);

  return ok(data, ctx);
}

export async function submitReport(ctx: HandlerContext): Promise<Response> {
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

export async function saveDraft(ctx: HandlerContext): Promise<Response> {
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

export async function createPoll(ctx: HandlerContext): Promise<Response> {
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

export async function votePoll(ctx: HandlerContext): Promise<Response> {
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

  // Increment vote count on the option (non-critical -- triggers may handle this)
  try {
    await supabase.rpc("increment_poll_option_votes", { p_option_id: body.optionId });
  } catch {
    // Ignore -- vote count triggers may handle this
  }

  logger.info("Poll vote recorded", { pollId: body.pollId, userId });

  return created(data, ctx);
}

// =============================================================================
// DELETE Handlers
// =============================================================================

export async function deleteDraft(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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
