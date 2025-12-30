/**
 * DELETE USER - Account Deletion for Apple App Store Compliance
 *
 * Deletes user from auth.users, cascades to profiles, and cleans up storage.
 * Required for Apple App Store Review Guidelines section 5.1.1.
 *
 * POST /delete-user
 * Authorization: Bearer <jwt>
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Account deleted successfully",
 *   "deletedUserId": "uuid"
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Response Types
// =============================================================================

interface DeleteUserResponse {
  success: boolean;
  message: string;
  deletedUserId?: string;
}

// =============================================================================
// Handler
// =============================================================================

async function handleDeleteUser(ctx: HandlerContext): Promise<Response> {
  const { userId, request } = ctx;

  if (!userId) {
    return ok({
      success: false,
      message: "Authentication required",
    } as DeleteUserResponse, ctx);
  }

  logger.info("Deleting user", { userId });

  // Create admin client with service role key for deletion operations
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // Step 1: Delete user's avatar from storage (if exists)
  try {
    const { data: avatarFiles } = await supabaseAdmin.storage
      .from("avatars")
      .list(userId);

    if (avatarFiles && avatarFiles.length > 0) {
      const filesToDelete = avatarFiles.map((file) => `${userId}/${file.name}`);
      const { error: storageError } = await supabaseAdmin.storage
        .from("avatars")
        .remove(filesToDelete);

      if (storageError) {
        logger.warn("Failed to delete avatar files", { error: storageError.message });
        // Continue with deletion even if storage cleanup fails
      } else {
        logger.info("Deleted avatar files", { count: filesToDelete.length });
      }
    }
  } catch (storageError) {
    logger.warn("Storage cleanup error", {
      error: storageError instanceof Error ? storageError.message : String(storageError),
    });
    // Continue with deletion even if storage cleanup fails
  }

  // Step 2: Delete user's post images from storage (if exists)
  try {
    const { data: postImages } = await supabaseAdmin.storage
      .from("post-images")
      .list(userId);

    if (postImages && postImages.length > 0) {
      const filesToDelete = postImages.map((file) => `${userId}/${file.name}`);
      await supabaseAdmin.storage.from("post-images").remove(filesToDelete);
      logger.info("Deleted post images", { count: filesToDelete.length });
    }
  } catch (error) {
    logger.warn("Post images cleanup error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 3: Delete user from auth.users (cascades to profiles via FK)
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

  if (deleteError) {
    logger.error("Failed to delete user", new Error(deleteError.message));
    return ok({
      success: false,
      message: "Failed to delete account. Please try again.",
    } as DeleteUserResponse, ctx);
  }

  logger.info("User deleted successfully", { userId });

  return ok({
    success: true,
    message: "Account deleted successfully",
    deletedUserId: userId,
  } as DeleteUserResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "delete-user",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 3,
    windowMs: 3600000, // 3 deletions per hour max (very strict)
    keyBy: "user",
  },
  routes: {
    POST: {
      handler: handleDeleteUser,
    },
    // Also support DELETE method for RESTful semantics
    DELETE: {
      handler: handleDeleteUser,
    },
  },
});
