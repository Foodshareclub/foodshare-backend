/**
 * Notify New Post Edge Function
 *
 * Database webhook trigger that sends Telegram notifications
 * when new food listings are created.
 *
 * Features:
 * - Admin notification with post details
 * - Post type emoji mapping
 * - Author profile lookup
 *
 * Trigger: Database INSERT on posts table
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

const postTypeEmoji: Record<string, string> = {
  food: "🍎",
  request: "🙋",
  fridge: "🧊",
  foodbank: "🏦",
  restaurant: "🍽️",
  farm: "🌾",
  garden: "🌱",
  default: "📦",
};

// =============================================================================
// Request Schema (Database Webhook Payload)
// =============================================================================

const postSchema = z.object({
  record: z.object({
    id: z.union([z.number(), z.string()]),
    post_name: z.string(),
    post_type: z.string().optional().nullable(),
    post_address: z.string().optional().nullable(),
    post_description: z.string().optional().nullable(),
    profile_id: z.string().optional().nullable(),
  }).passthrough(),
}).passthrough();

type PostPayload = z.infer<typeof postSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface NotifyResponse {
  success: boolean;
  message: string;
}

// =============================================================================
// Telegram API
// =============================================================================

async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
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
// Profile Helper
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

// =============================================================================
// Message Formatting
// =============================================================================

function formatPostMessage(
  post: PostPayload["record"],
  profile: { nickname: string | null; first_name: string | null; second_name: string | null } | null
): string {
  const emoji = postTypeEmoji[post.post_type || "default"] || postTypeEmoji.default;
  const fullName = profile
    ? [profile.first_name, profile.second_name].filter(Boolean).join(" ")
    : "";
  const userName = fullName || profile?.nickname || "Someone";
  const postUrl = `${appUrl}/product/${post.id}`;

  let message = `${emoji} <b>New ${post.post_type || "food"} listing!</b>\n\n`;
  message += `<b>${post.post_name}</b>\n`;

  if (post.post_address) {
    message += `📍 ${post.post_address}\n`;
  }

  if (post.post_description) {
    const shortDesc =
      post.post_description.length > 150
        ? post.post_description.substring(0, 150) + "..."
        : post.post_description;
    message += `\n${shortDesc}\n`;
  }

  message += `\n👤 Posted by ${userName}`;
  message += `\n\n🔗 <a href="${postUrl}">View on FoodShare</a>`;

  return message;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleNotifyNewPost(ctx: HandlerContext<PostPayload>): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const post = body.record;

  logger.info("Processing new post notification", {
    postId: post.id,
    postName: post.post_name,
    postType: post.post_type,
    requestId: requestCtx?.requestId,
  });

  // Get author profile
  const profile = post.profile_id ? await getProfile(supabase, post.profile_id) : null;

  // Format and send message
  const message = formatPostMessage(post, profile);
  const sent = await sendTelegramMessage(adminChatId, message);

  logger.info("Notification sent", { success: sent, postId: post.id });

  const result: NotifyResponse = {
    success: sent,
    message: sent ? "Notification sent" : "Failed to send notification",
  };

  return ok(result, ctx, sent ? 200 : 500);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "notify-new-post",
  version: "2.0.0",
  requireAuth: false, // Database webhook - no JWT auth
  routes: {
    POST: {
      schema: postSchema,
      handler: handleNotifyNewPost,
    },
  },
});
