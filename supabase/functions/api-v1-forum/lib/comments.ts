/**
 * Forum comment handlers
 *
 * CRUD operations for comments on forum posts,
 * including best answer marking.
 *
 * @module api-v1-forum/lib/comments
 */

import { positiveIntSchema, z } from "../../_shared/schemas/common.ts";
import { created, type HandlerContext, noContent, ok } from "../../_shared/api-handler.ts";
import { ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import type { ForumQuery } from "../index.ts";
import { CommentService } from "./comment-service.ts";

// =============================================================================
// Schemas
// =============================================================================

export const createCommentSchema = z.object({
  forumId: positiveIntSchema,
  content: z.string().min(1).max(5000),
  parentId: positiveIntSchema.optional(),
  richContent: z.record(z.unknown()).optional(),
});

export const updateCommentSchema = z.object({
  content: z.string().min(1).max(5000),
  richContent: z.record(z.unknown()).nullable().optional(),
});

export const markBestAnswerSchema = z.object({
  forumId: positiveIntSchema,
  commentId: positiveIntSchema,
});

// =============================================================================
// GET Handlers
// =============================================================================

export async function getComments(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  if (!query.id) {
    throw new ValidationError("forumId query param required");
  }

  const forumId = parseInt(query.id);
  if (isNaN(forumId)) {
    throw new ValidationError("Invalid forumId");
  }

  const limit = Math.min(parseInt(query.limit || "50"), 100);
  const offset = parseInt(query.offset || "0");

  const { data, error } = await supabase
    .from("comments")
    .select(`
      *,
      author:profiles!comments_user_id_fkey(id, nickname, avatar_url, is_verified)
    `)
    .eq("forum_id", forumId)
    .order("comment_created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error("Fetch comments failed", new Error(error.message));
    throw new ValidationError(`Failed to fetch comments: ${error.message}`);
  }

  return ok(data, ctx);
}

// =============================================================================
// POST Handlers
// =============================================================================

export async function createComment(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = createCommentSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const service = new CommentService(supabase, userId);
  const data = await service.createComment({
    forumId: body.forumId,
    content: body.content,
    parentId: body.parentId,
  });

  return created(data, ctx);
}

export async function markBestAnswer(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId } = ctx;
  const body = markBestAnswerSchema.parse(ctx.body);

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const service = new CommentService(supabase, userId);
  await service.markBestAnswer(body.commentId, body.forumId);

  return ok({ commentId: body.commentId, isBestAnswer: true }, ctx);
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

  const service = new CommentService(supabase, userId);
  const data = await service.updateComment(commentId, { content: body.content });

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

  const service = new CommentService(supabase, userId);
  await service.deleteComment(commentId);

  return noContent(ctx);
}
