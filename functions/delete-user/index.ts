// ============================================================================
// DELETE USER - Account Deletion for Apple App Store Compliance
// Deletes user from auth.users, cascades to profiles, and cleans up storage
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "1.0.0";

// CORS headers for iOS app
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface DeleteUserResponse {
  success: boolean;
  message: string;
  deletedUserId?: string;
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  console.log(`[${requestId}] Delete user request received`);

  try {
    // Get the authorization header from the request
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error(`[${requestId}] No authorization header provided`);
      return new Response(
        JSON.stringify({
          success: false,
          message: "Missing authorization header",
        } as DeleteUserResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Create a Supabase client with the user's JWT to verify identity
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    // Get the authenticated user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      console.error(`[${requestId}] Failed to get user:`, userError?.message);
      return new Response(
        JSON.stringify({
          success: false,
          message: "Unauthorized - invalid or expired token",
        } as DeleteUserResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const userId = user.id;
    console.log(`[${requestId}] Deleting user: ${userId}`);

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
          console.warn(
            `[${requestId}] Failed to delete avatar files:`,
            storageError.message
          );
          // Continue with deletion even if storage cleanup fails
        } else {
          console.log(
            `[${requestId}] Deleted ${filesToDelete.length} avatar file(s)`
          );
        }
      }
    } catch (storageError) {
      console.warn(`[${requestId}] Storage cleanup error:`, storageError);
      // Continue with deletion even if storage cleanup fails
    }

    // Step 2: Delete user from auth.users (cascades to profiles via FK)
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(
      userId
    );

    if (deleteError) {
      console.error(`[${requestId}] Failed to delete user:`, deleteError.message);
      return new Response(
        JSON.stringify({
          success: false,
          message: "Failed to delete account. Please try again.",
        } as DeleteUserResponse),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] User ${userId} deleted successfully in ${duration}ms`
    );

    return new Response(
      JSON.stringify({
        success: true,
        message: "Account deleted successfully",
        deletedUserId: userId,
      } as DeleteUserResponse),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-Version": VERSION,
          "X-Duration-Ms": duration.toString(),
        },
      }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Unexpected error:`, error);

    return new Response(
      JSON.stringify({
        success: false,
        message: "An unexpected error occurred. Please try again.",
      } as DeleteUserResponse),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-Version": VERSION,
          "X-Duration-Ms": duration.toString(),
        },
      }
    );
  }
});
