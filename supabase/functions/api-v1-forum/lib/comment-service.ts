/**
 * Comment Service
 * 
 * Business logic for forum comments and replies.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../../_shared/logger.ts";

export interface CreateCommentInput {
  forumId: number;
  content: string;
  parentId?: number;
}

export interface UpdateCommentInput {
  content: string;
}

export class CommentService {
  constructor(private supabase: SupabaseClient, private userId: string) {}

  async createComment(input: CreateCommentInput) {
    const insertData = {
      forum_id: input.forumId,
      profile_id: this.userId,
      forum_comment_content: input.content,
      parent_comment_id: input.parentId || null,
    };

    const { data, error } = await this.supabase
      .from("forum_comments")
      .insert(insertData)
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Comment created", { commentId: data.id, forumId: input.forumId });
    return data;
  }

  async updateComment(commentId: number, input: UpdateCommentInput) {
    await this.verifyOwnership(commentId);

    const { data, error } = await this.supabase
      .from("forum_comments")
      .update({
        forum_comment_content: input.content,
        is_edited: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", commentId)
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Comment updated", { commentId });
    return data;
  }

  async deleteComment(commentId: number) {
    await this.verifyOwnership(commentId);

    const { error } = await this.supabase
      .from("forum_comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", commentId);

    if (error) throw error;

    logger.info("Comment deleted", { commentId });
  }

  async markBestAnswer(commentId: number, forumId: number) {
    // Verify post ownership
    const { data: post, error: postError } = await this.supabase
      .from("forum")
      .select("profile_id, post_type")
      .eq("id", forumId)
      .single();

    if (postError || !post) throw new Error("Post not found");
    if (post.profile_id !== this.userId) throw new Error("Only post author can mark best answer");
    if (post.post_type !== "question") throw new Error("Only questions can have best answers");

    const { error } = await this.supabase
      .from("forum_comments")
      .update({ is_best_answer: true })
      .eq("id", commentId);

    if (error) throw error;

    logger.info("Best answer marked", { commentId, forumId });
  }

  private async verifyOwnership(commentId: number) {
    const { data, error } = await this.supabase
      .from("forum_comments")
      .select("profile_id")
      .eq("id", commentId)
      .is("deleted_at", null)
      .single();

    if (error || !data) throw new Error("Comment not found");
    if (data.profile_id !== this.userId) throw new Error("Unauthorized");
  }
}
