/**
 * Atomic Favorites Edge Function
 *
 * Provides atomic toggle/add/remove operations for favorites to prevent race conditions.
 * Uses Postgres INSERT ON CONFLICT for atomic operations.
 *
 * Endpoints:
 * - POST /atomic-favorites { action: "toggle"|"add"|"remove", postId: number }
 *
 * Features:
 * - Atomic operations using database constraints
 * - Returns new favorite state and updated like counter
 * - Cross-platform support (iOS/Android/Web)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Request Schema
// =============================================================================

const toggleFavoriteSchema = z.object({
  action: z.enum(["toggle", "add", "remove"]),
  postId: z.number().int().positive(),
});

type ToggleFavoriteRequest = z.infer<typeof toggleFavoriteSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface FavoriteResponse {
  isFavorited: boolean;
  likeCount: number;
  action: "added" | "removed" | "unchanged";
}

// =============================================================================
// Handler
// =============================================================================

async function handleToggleFavorite(
  ctx: HandlerContext<ToggleFavoriteRequest>
): Promise<Response> {
  const { action, postId } = ctx.body;
  const userId = ctx.userId;

  if (!userId) {
    throw new ValidationError("User must be authenticated");
  }

  logger.info("Atomic favorite operation", { action, postId, userId });

  let result: FavoriteResponse;

  switch (action) {
    case "toggle":
      result = await toggleFavorite(ctx.supabase, userId, postId);
      break;
    case "add":
      result = await addFavorite(ctx.supabase, userId, postId);
      break;
    case "remove":
      result = await removeFavorite(ctx.supabase, userId, postId);
      break;
  }

  logger.info("Favorite operation completed", {
    action,
    postId,
    result: result.action,
    isFavorited: result.isFavorited,
  });

  return ok(result, ctx);
}

// =============================================================================
// Database Operations (Atomic)
// =============================================================================

async function toggleFavorite(
  supabase: ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2.43.4").createClient>,
  userId: string,
  postId: number
): Promise<FavoriteResponse> {
  // Use a database RPC function for atomic toggle
  const { data, error } = await supabase.rpc("toggle_post_favorite_atomic", {
    p_user_id: userId,
    p_post_id: postId,
  });

  if (error) {
    logger.error("Toggle favorite failed", { error, postId, userId });
    throw new ValidationError(`Failed to toggle favorite: ${error.message}`);
  }

  return {
    isFavorited: data.is_favorited,
    likeCount: data.like_count,
    action: data.was_added ? "added" : "removed",
  };
}

async function addFavorite(
  supabase: ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2.43.4").createClient>,
  userId: string,
  postId: number
): Promise<FavoriteResponse> {
  // Insert with ON CONFLICT DO NOTHING
  const { error: insertError } = await supabase
    .from("favorites")
    .upsert(
      { user_id: userId, post_id: postId },
      { onConflict: "user_id,post_id", ignoreDuplicates: true }
    );

  if (insertError) {
    logger.error("Add favorite failed", { error: insertError, postId, userId });
    throw new ValidationError(`Failed to add favorite: ${insertError.message}`);
  }

  // Get updated count
  const { data: post, error: countError } = await supabase
    .from("posts")
    .select("post_like_counter")
    .eq("id", postId)
    .single();

  if (countError) {
    logger.error("Failed to get like count", { error: countError, postId });
  }

  return {
    isFavorited: true,
    likeCount: post?.post_like_counter ?? 0,
    action: "added",
  };
}

async function removeFavorite(
  supabase: ReturnType<typeof import("https://esm.sh/@supabase/supabase-js@2.43.4").createClient>,
  userId: string,
  postId: number
): Promise<FavoriteResponse> {
  const { error: deleteError } = await supabase
    .from("favorites")
    .delete()
    .eq("user_id", userId)
    .eq("post_id", postId);

  if (deleteError) {
    logger.error("Remove favorite failed", { error: deleteError, postId, userId });
    throw new ValidationError(`Failed to remove favorite: ${deleteError.message}`);
  }

  // Get updated count
  const { data: post, error: countError } = await supabase
    .from("posts")
    .select("post_like_counter")
    .eq("id", postId)
    .single();

  if (countError) {
    logger.error("Failed to get like count", { error: countError, postId });
  }

  return {
    isFavorited: false,
    likeCount: post?.post_like_counter ?? 0,
    action: "removed",
  };
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "atomic-favorites",
  version: "1.0.0",
  requireAuth: true,
  routes: {
    POST: {
      schema: toggleFavoriteSchema,
      handler: handleToggleFavorite,
    },
  },
});
