/**
 * Notify Forum Post Edge Function
 *
 * Database webhook trigger that sends Telegram notifications
 * when new forum posts are created.
 *
 * Features:
 * - Admin notification for all posts
 * - Channel posting for superadmin authors
 * - Forum thread support
 *
 * Trigger: Database INSERT on forum table
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;
const channelUsername = "@foodshare_club";
const channelThreadId = Deno.env.get("CHANNEL_THREAD_ID");
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

// =============================================================================
// Request Schema (Database Webhook Payload)
// =============================================================================

const forumPostSchema = z.object({
  record: z.object({
    id: z.union([z.number(), z.string()]),
    forum_post_name: z.string(),
    forum_post_description: z.string().optional().nullable(),
    forum_published: z.boolean().optional().nullable(),
    slug: z.string().optional().nullable(),
    profile_id: z.string().optional().nullable(),
  }).passthrough(),
}).passthrough();

type ForumPostPayload = z.infer<typeof forumPostSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface NotifyResponse {
  adminNotification: boolean;
  channelNotification: boolean;
}

// =============================================================================
// Telegram API
// =============================================================================

async function sendTelegramMessage(
  chatId: string,
  text: string,
  threadId?: string
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    };

    if (threadId) {
      payload.message_thread_id = parseInt(threadId);
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!result.ok) {
      logger.error("Telegram API error", { error: result });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("Error sending Telegram message", { error });
    return false;
  }
}

// =============================================================================
// Profile & Role Helpers
// =============================================================================

async function getProfile(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  profileId: string
): Promise<{ nickname: string | null; first_name: string | null; second_name: string | null } | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("nickname, first_name, second_name")
    .eq("id", profileId)
    .single();

  if (error) {
    logger.error("Error fetching profile", { error: error.message });
    return null;
  }
  return data;
}

async function isSuperAdmin(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  profileId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", profileId);

  if (error) {
    logger.error("Error checking superadmin status", { error: error.message });
    return false;
  }

  const roles = data?.map((r: { roles: { name: string } }) => r.roles?.name).filter(Boolean) || [];
  return roles.includes("superadmin");
}

// =============================================================================
// Message Formatting
// =============================================================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function formatAdminMessage(
  post: ForumPostPayload["record"]
): string {
  const postUrl = `${appUrl}/forum/${post.slug || post.id}`;
  const description =
    typeof post.forum_post_description === "string"
      ? stripHtml(post.forum_post_description)
      : "";
  const shortDesc = description.length > 150 ? description.substring(0, 150) + "..." : description;

  let message = `<b>New Forum Post!</b>\n\n`;
  message += `<b>${post.forum_post_name}</b>\n`;
  if (shortDesc) {
    message += `\n${shortDesc}\n`;
  }
  message += `\n<a href="${postUrl}">View on FoodShare</a>`;

  return message;
}

function formatChannelMessage(
  post: ForumPostPayload["record"]
): string {
  const postUrl = `${appUrl}/forum/${post.slug || post.id}`;
  const description =
    typeof post.forum_post_description === "string"
      ? stripHtml(post.forum_post_description)
      : "";
  const shortDesc = description.length > 300 ? description.substring(0, 300) + "..." : description;

  let message = `<b>${post.forum_post_name}</b>\n`;
  if (shortDesc) {
    message += `\n${shortDesc}\n`;
  }
  message += `\n<a href="${postUrl}">Read more on FoodShare</a>`;

  return message;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleNotifyForumPost(ctx: HandlerContext<ForumPostPayload>): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const post = body.record;

  logger.info("Processing forum post notification", {
    postId: post.id,
    postName: post.forum_post_name,
    requestId: requestCtx?.requestId,
  });

  // Skip unpublished posts
  if (post.forum_published === false) {
    logger.info("Post not published, skipping notification", { postId: post.id });
    return ok({ message: "Post not published, skipping notification" }, ctx);
  }

  // Send admin notification
  const adminMessage = formatAdminMessage(post);
  const adminSent = await sendTelegramMessage(adminChatId, adminMessage);
  logger.info("Admin notification sent", { success: adminSent, postId: post.id });

  // Check if author is superadmin and post to channel
  let channelSent = false;
  if (post.profile_id) {
    const superAdmin = await isSuperAdmin(supabase, post.profile_id);
    logger.info("Author superadmin check", { isSuperadmin: superAdmin, profileId: post.profile_id?.substring(0, 8) });

    if (superAdmin) {
      const channelMessage = formatChannelMessage(post);
      channelSent = await sendTelegramMessage(channelUsername, channelMessage, channelThreadId);
      logger.info("Channel notification sent", { success: channelSent, threadId: channelThreadId });
    }
  }

  const result: NotifyResponse = {
    adminNotification: adminSent,
    channelNotification: channelSent,
  };

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "notify-forum-post",
  version: "2.0.0",
  requireAuth: false, // Database webhook - no JWT auth
  routes: {
    POST: {
      schema: forumPostSchema,
      handler: handleNotifyForumPost,
    },
  },
});
