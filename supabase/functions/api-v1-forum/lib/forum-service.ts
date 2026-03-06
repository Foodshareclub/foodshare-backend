/**
 * Forum Service
 *
 * Reusable business logic for forum operations.
 * Separates data access from HTTP handlers.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../../_shared/logger.ts";

export interface ForumPost {
  id: number;
  forum_post_name: string;
  forum_post_description: string;
  profile_id: string;
  category_id: number | null;
  post_type: string;
  slug: string;
  forum_post_image: string | null;
  rich_content: Record<string, unknown> | null;
  forum_published: boolean;
  is_pinned: boolean;
  is_locked: boolean;
  deleted_at: string | null;
  forum_post_created_at: string;
  forum_post_updated_at: string | null;
}

export interface CreatePostInput {
  title: string;
  description: string;
  categoryId?: number;
  postType: string;
  imageUrl?: string;
  richContent?: Record<string, unknown>;
  tags?: number[];
}

export interface UpdatePostInput {
  title?: string;
  description?: string;
  categoryId?: number;
  postType?: string;
  imageUrl?: string | null;
  richContent?: Record<string, unknown> | null;
  tags?: number[];
}

export class ForumService {
  constructor(private supabase: SupabaseClient, private userId: string) {}

  async createPost(input: CreatePostInput) {
    const slug = this.generateSlug(input.title);

    const insertData = {
      forum_post_name: input.title,
      forum_post_description: input.description,
      profile_id: this.userId,
      category_id: input.categoryId || null,
      post_type: input.postType,
      slug,
      forum_post_image: input.imageUrl || null,
      rich_content: input.richContent || null,
      forum_published: true,
    };

    const { data, error } = await this.supabase
      .from("forum")
      .insert(insertData)
      .select("id, slug, forum_post_name, forum_post_created_at")
      .single();

    if (error) throw error;

    // Insert tags if provided
    if (input.tags && input.tags.length > 0) {
      await this.addTags(data.id, input.tags);
    }

    logger.info("Forum post created", { forumId: data.id, userId: this.userId });
    return data;
  }

  async updatePost(postId: number, input: UpdatePostInput) {
    // Verify ownership
    await this.verifyOwnership(postId);

    const updateData: Record<string, unknown> = {
      is_edited: true,
      forum_post_updated_at: new Date().toISOString(),
    };

    if (input.title !== undefined) updateData.forum_post_name = input.title;
    if (input.description !== undefined) updateData.forum_post_description = input.description;
    if (input.categoryId !== undefined) updateData.category_id = input.categoryId;
    if (input.postType !== undefined) updateData.post_type = input.postType;
    if (input.imageUrl !== undefined) updateData.forum_post_image = input.imageUrl;
    if (input.richContent !== undefined) updateData.rich_content = input.richContent;

    const { data, error } = await this.supabase
      .from("forum")
      .update(updateData)
      .eq("id", postId)
      .select("id, forum_post_name, forum_post_updated_at, slug")
      .single();

    if (error) throw error;

    // Update tags if provided
    if (input.tags !== undefined) {
      await this.replaceTags(postId, input.tags);
    }

    logger.info("Forum post updated", { forumId: postId, userId: this.userId });
    return data;
  }

  async deletePost(postId: number) {
    await this.verifyOwnership(postId);

    const { error } = await this.supabase
      .from("forum")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", postId);

    if (error) throw error;

    logger.info("Forum post deleted", { forumId: postId, userId: this.userId });
  }

  async getPost(postId: number, viewerId?: string) {
    const { data, error } = await this.supabase.rpc("get_forum_post_detail", {
      p_post_id: postId,
      p_user_id: viewerId || null,
    });

    if (error) throw error;
    if (!data) throw new Error("Post not found");

    return data;
  }

  async getFeed(params: {
    categoryId?: number;
    postType?: string;
    sortBy?: string;
    limit: number;
    offset: number;
  }) {
    const { data, error } = await this.supabase.rpc("get_forum_feed_data", {
      p_user_id: this.userId || null,
      p_category_id: params.categoryId || null,
      p_post_type: params.postType || null,
      p_sort_by: params.sortBy || "recent",
      p_page_limit: params.limit,
      p_page_offset: params.offset,
    });

    if (error) throw error;
    return data;
  }

  async searchPosts(params: {
    query: string;
    categoryId?: number;
    tags?: number[];
    authorId?: string;
    dateFrom?: string;
    dateTo?: string;
    sortBy?: string;
    limit: number;
    offset: number;
  }) {
    const { data, error } = await this.supabase.rpc("search_forum", {
      p_query: params.query,
      p_category_id: params.categoryId || null,
      p_tags: params.tags || null,
      p_author_id: params.authorId || null,
      p_date_from: params.dateFrom || null,
      p_date_to: params.dateTo || null,
      p_sort_by: params.sortBy || "relevance",
      p_limit: params.limit,
      p_offset: params.offset,
    });

    if (error) throw error;
    return data;
  }

  private async verifyOwnership(postId: number) {
    const { data, error } = await this.supabase
      .from("forum")
      .select("profile_id")
      .eq("id", postId)
      .is("deleted_at", null)
      .single();

    if (error || !data) throw new Error("Post not found");
    if (data.profile_id !== this.userId) throw new Error("Unauthorized");
  }

  private async addTags(postId: number, tagIds: number[]) {
    const tagRows = tagIds.map((tagId) => ({
      forum_id: postId,
      tag_id: tagId,
    }));

    const { error } = await this.supabase
      .from("forum_post_tags")
      .insert(tagRows);

    if (error) {
      logger.warn("Failed to insert tags", { error: error.message, forumId: postId });
    }
  }

  private async replaceTags(postId: number, tagIds: number[]) {
    // Delete existing tags
    await this.supabase
      .from("forum_post_tags")
      .delete()
      .eq("forum_id", postId);

    // Insert new tags
    if (tagIds.length > 0) {
      await this.addTags(postId, tagIds);
    }
  }

  private generateSlug(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 100) +
      "-" + Date.now().toString(36);
  }
}
