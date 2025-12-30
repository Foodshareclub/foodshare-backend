/**
 * Notify New User Edge Function
 *
 * Database webhook trigger that sends Telegram notifications
 * when new users join the platform.
 *
 * Features:
 * - Rich user profile formatting
 * - Transportation and dietary info
 * - Social media links
 * - Verified status badges
 *
 * Trigger: Database INSERT on profiles table
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

// =============================================================================
// Request Schema (Database Webhook Payload)
// =============================================================================

const profileSchema = z.object({
  record: z.object({
    id: z.string(),
    nickname: z.string().optional().nullable(),
    first_name: z.string().optional().nullable(),
    second_name: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    about_me: z.string().optional().nullable(),
    bio: z.string().optional().nullable(),
    avatar_url: z.string().optional().nullable(),
    transportation: z.string().optional().nullable(),
    dietary_preferences: z.union([z.array(z.string()), z.record(z.unknown())]).optional().nullable(),
    search_radius_km: z.number().optional().nullable(),
    facebook: z.string().optional().nullable(),
    instagram: z.string().optional().nullable(),
    twitter: z.string().optional().nullable(),
    is_verified: z.boolean().optional().nullable(),
    is_active: z.boolean().optional().nullable(),
    created_time: z.string(),
    updated_at: z.string().optional().nullable(),
  }).passthrough(),
}).passthrough();

type ProfilePayload = z.infer<typeof profileSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface NotifyResponse {
  success: boolean;
  message: string;
  profile_id: string;
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
      logger.error("Telegram API error", { error: result.description || "Unknown error" });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("Error sending Telegram message", { error });
    return false;
  }
}

// =============================================================================
// Message Formatting
// =============================================================================

function formatUserMessage(profile: ProfilePayload["record"]): string {
  const fullName = [profile.first_name, profile.second_name].filter(Boolean).join(" ");
  const displayName = fullName || profile.nickname || "New user";
  const profileUrl = `${appUrl}/profile/${profile.id}`;

  let message = `🎉 <b>New user joined FoodShare!</b>\n\n`;

  // User identity
  message += `👤 <b>${displayName}</b>\n`;
  if (profile.nickname && profile.nickname !== displayName) {
    message += `🏷️ Username: @${profile.nickname}\n`;
  }

  // Contact info
  if (profile.email) {
    message += `📧 ${profile.email}\n`;
  }
  if (profile.phone && profile.phone.trim()) {
    message += `📱 ${profile.phone}\n`;
  }

  // Bio/About
  if (profile.about_me && profile.about_me.trim()) {
    const shortBio =
      profile.about_me.length > 100 ? profile.about_me.substring(0, 100) + "..." : profile.about_me;
    message += `\n💬 <i>"${shortBio}"</i>\n`;
  }

  // Transportation
  if (profile.transportation && profile.transportation.trim()) {
    const transportEmoji: Record<string, string> = {
      car: "🚗",
      bike: "🚲",
      walk: "🚶",
      walking: "🚶",
      public: "🚌",
      bus: "🚌",
      scooter: "🛴",
      motorcycle: "🏍️",
    };
    const emoji = transportEmoji[profile.transportation.toLowerCase()] || "🚶";
    message += `\n${emoji} Transport: ${profile.transportation}`;
  }

  // Dietary preferences
  if (profile.dietary_preferences) {
    let prefs: string[] = [];
    if (Array.isArray(profile.dietary_preferences)) {
      prefs = profile.dietary_preferences;
    } else if (typeof profile.dietary_preferences === "object") {
      prefs = Object.values(profile.dietary_preferences).filter(Boolean) as string[];
    }

    if (prefs.length > 0) {
      message += `\n🥗 Diet: ${prefs.join(", ")}`;
    }
  }

  // Search radius
  if (profile.search_radius_km) {
    message += `\n📍 Search radius: ${profile.search_radius_km}km`;
  }

  // Social media
  const socials: string[] = [];
  if (profile.facebook && profile.facebook.trim())
    socials.push(`<a href="${profile.facebook}">Facebook</a>`);
  if (profile.instagram && profile.instagram.trim())
    socials.push(`<a href="${profile.instagram}">Instagram</a>`);
  if (profile.twitter && profile.twitter.trim())
    socials.push(`<a href="${profile.twitter}">Twitter</a>`);
  if (socials.length > 0) {
    message += `\n🔗 ${socials.join(" • ")}`;
  }

  // Status badges
  const badges: string[] = [];
  if (profile.is_verified) badges.push("✅ Verified");
  if (badges.length > 0) {
    message += `\n\n${badges.join(" • ")}`;
  }

  // Join date with time
  const joinDate = new Date(profile.created_time);
  const dateStr = joinDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = joinDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  message += `\n\n📅 Joined: ${dateStr} at ${timeStr}`;

  // Profile link
  message += `\n\n🔗 <a href="${profileUrl}">View full profile</a>`;

  return message;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleNotifyNewUser(ctx: HandlerContext<ProfilePayload>): Promise<Response> {
  const { body, ctx: requestCtx } = ctx;
  const profile = body.record;

  logger.info("Processing new user notification", {
    profileId: profile.id.substring(0, 8),
    nickname: profile.nickname,
    requestId: requestCtx?.requestId,
  });

  // Format and send message
  const message = formatUserMessage(profile);
  const sent = await sendTelegramMessage(adminChatId, message);

  logger.info("Notification sent", {
    success: sent,
    profileId: profile.id.substring(0, 8),
  });

  const result: NotifyResponse = {
    success: sent,
    message: sent ? "Notification sent" : "Failed to send notification",
    profile_id: profile.id,
  };

  return ok(result, ctx, sent ? 200 : 500);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "notify-new-user",
  version: "2.0.0",
  requireAuth: false, // Database webhook - no JWT auth
  routes: {
    POST: {
      schema: profileSchema,
      handler: handleNotifyNewUser,
    },
  },
});
