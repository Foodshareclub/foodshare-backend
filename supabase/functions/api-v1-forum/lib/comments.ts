/**
 * Forum comment handlers
 *
 * CRUD operations for comments on forum posts,
 * including best answer marking.
 *
 * @module api-v1-forum/lib/comments
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { created, type HandlerContext, noContent, ok } from "../../_shared/api-handler.ts";
import { AuthorizationError, NotFoundError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import type { ForumQuery } from "../index.ts";

// =============================================================================
// Schemas
// =============================================================================

export const createCommentSchema = z.object({
  forumId: z.number().int().positive(),
  content: z.string().min(1).max(5000),
  parentId: z.number().int().positive().optional(),
  richContent: z.record(z.unknown()).optional(),
});

export const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  richContent: z.record(z.unknown()).nullable().optional(),
});

export const markBestAnswerSchema = z.object({
  forumId: z.number().int().positive(),
  commentId: z.number().int().positive(),
});

// =============================================================================
// POST Handlers
// =============================================================================

export async function createComment(ctx: HandlerContext): Promise<Response> {
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

export async function markBestAnswer(ctx: HandlerContext): Promise<Response> {
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

export async function updateComment(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

export async function deleteComment(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
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

  // Soft delete -- set comment text to indicate deletion, preserve row for threading
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
