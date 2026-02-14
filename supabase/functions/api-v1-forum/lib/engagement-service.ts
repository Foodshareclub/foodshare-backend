/**
 * Engagement Service
 * 
 * Business logic for likes, bookmarks, reactions, and subscriptions.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../../_shared/logger.ts";

export class EngagementService {
  constructor(private supabase: SupabaseClient, private userId: string) {}

  async toggleLike(forumId: number) {
    const { data: existing } = await this.supabase
      .from("forum_likes")
      .select("id")
      .eq("forum_id", forumId)
      .eq("profile_id", this.userId)
      .maybeSingle();

    if (existing) {
      await this.supabase
        .from("forum_likes")
        .delete()
        .eq("id", existing.id);
      
      logger.info("Like removed", { forumId });
      return { liked: false };
    } else {
      await this.supabase
        .from("forum_likes")
        .insert({ forum_id: forumId, profile_id: this.userId });
      
      logger.info("Like added", { forumId });
      return { liked: true };
    }
  }

  async toggleBookmark(forumId: number) {
    const { data: existing } = await this.supabase
      .from("forum_bookmarks")
      .select("id")
      .eq("forum_id", forumId)
      .eq("profile_id", this.userId)
      .maybeSingle();

    if (existing) {
      await this.supabase
        .from("forum_bookmarks")
        .delete()
        .eq("id", existing.id);
      
      logger.info("Bookmark removed", { forumId });
      return { bookmarked: false };
    } else {
      await this.supabase
        .from("forum_bookmarks")
        .insert({ forum_id: forumId, profile_id: this.userId });
      
      logger.info("Bookmark added", { forumId });
      return { bookmarked: true };
    }
  }

  async toggleReaction(forumId: number, reactionType: string) {
    const { data: existing } = await this.supabase
      .from("forum_reactions")
      .select("id, reaction_type")
      .eq("forum_id", forumId)
      .eq("profile_id", this.userId)
      .maybeSingle();

    if (existing) {
      if (existing.reaction_type === reactionType) {
        await this.supabase
          .from("forum_reactions")
          .delete()
          .eq("id", existing.id);
        
        logger.info("Reaction removed", { forumId, reactionType });
        return { reacted: false, reactionType: null };
      } else {
        await this.supabase
          .from("forum_reactions")
          .update({ reaction_type: reactionType })
          .eq("id", existing.id);
        
        logger.info("Reaction updated", { forumId, reactionType });
        return { reacted: true, reactionType };
      }
    } else {
      await this.supabase
        .from("forum_reactions")
        .insert({ forum_id: forumId, profile_id: this.userId, reaction_type: reactionType });
      
      logger.info("Reaction added", { forumId, reactionType });
      return { reacted: true, reactionType };
    }
  }

  async toggleSubscription(forumId: number) {
    const { data: existing } = await this.supabase
      .from("forum_subscriptions")
      .select("id")
      .eq("forum_id", forumId)
      .eq("profile_id", this.userId)
      .maybeSingle();

    if (existing) {
      await this.supabase
        .from("forum_subscriptions")
        .delete()
        .eq("id", existing.id);
      
      logger.info("Subscription removed", { forumId });
      return { subscribed: false };
    } else {
      await this.supabase
        .from("forum_subscriptions")
        .insert({ forum_id: forumId, profile_id: this.userId });
      
      logger.info("Subscription added", { forumId });
      return { subscribed: true };
    }
  }

  async getBookmarks(limit: number, offset: number) {
    const { data, error } = await this.supabase
      .from("forum_bookmarks")
      .select(`
        forum_id,
        created_at,
        forum:forum(*)
      `)
      .eq("profile_id", this.userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return data;
  }

  async getDrafts(limit: number) {
    const { data, error } = await this.supabase
      .from("forum_drafts")
      .select("*")
      .eq("profile_id", this.userId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  async saveDraft(input: { title: string; content: string; categoryId?: number }) {
    const { data, error } = await this.supabase
      .from("forum_drafts")
      .upsert({
        profile_id: this.userId,
        title: input.title,
        content: input.content,
        category_id: input.categoryId || null,
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Draft saved", { draftId: data.id });
    return data;
  }

  async deleteDraft(draftId: number) {
    const { error } = await this.supabase
      .from("forum_drafts")
      .delete()
      .eq("id", draftId)
      .eq("profile_id", this.userId);

    if (error) throw error;

    logger.info("Draft deleted", { draftId });
  }

  async submitReport(input: { forumId?: number; commentId?: number; reason: string; details?: string }) {
    const { data, error } = await this.supabase
      .from("forum_reports")
      .insert({
        forum_id: input.forumId || null,
        comment_id: input.commentId || null,
        reporter_id: this.userId,
        reason: input.reason,
        details: input.details || null,
      })
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Report submitted", { reportId: data.id });
    return data;
  }
}
