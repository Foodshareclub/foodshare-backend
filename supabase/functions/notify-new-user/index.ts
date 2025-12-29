// ============================================================================
// NEW USER NOTIFICATION v6 - Modern Stack
// Built with: Deno 2, TypeScript strict mode
// Features: Enhanced user data, smart formatting, error handling
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const VERSION = "6.0.0";
const botToken = Deno.env.get("BOT_TOKEN");
const adminChatId = Deno.env.get("ADMIN_CHAT_ID");
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

interface ProfileData {
  id: string;
  nickname?: string;
  first_name?: string;
  second_name?: string;
  email?: string;
  phone?: string;
  about_me?: string;
  bio?: string;
  avatar_url?: string;
  transportation?: string;
  dietary_preferences?: string[] | Record<string, unknown>;
  search_radius_km?: number;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  is_verified?: boolean;
  is_active?: boolean;
  created_time: string;
  updated_at?: string;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });

    const result = (await response.json()) as TelegramResponse;
    if (!result.ok) {
      console.error("Telegram API error:", result.description || "Unknown error");
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    return false;
  }
}

function formatUserMessage(profile: ProfileData): string {
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
    const transportEmoji =
      {
        car: "🚗",
        bike: "🚲",
        walk: "🚶",
        walking: "🚶",
        public: "🚌",
        bus: "🚌",
        scooter: "🛴",
        motorcycle: "🏍️",
      }[profile.transportation.toLowerCase()] || "🚶";
    message += `\n${transportEmoji} Transport: ${profile.transportation}`;
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
  const socials = [];
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
  const badges = [];
  if (profile.is_verified) badges.push("✅ Verified");
  // Note: Role info now comes from user_roles table, not shown in new user notification
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

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  try {
    console.log(`[${requestId}] New user notification request received`);

    const payload = await req.json();
    console.log(`[${requestId}] Payload:`, JSON.stringify(payload));

    const profile = payload.record || payload;

    if (!profile?.id) {
      console.error(`[${requestId}] Invalid profile data - missing ID`);
      return new Response(
        JSON.stringify({
          error: "Invalid profile data",
          version: VERSION,
          requestId,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": requestId,
            "X-Version": VERSION,
          },
        }
      );
    }

    const message = formatUserMessage(profile as ProfileData);
    const sent = await sendTelegramMessage(adminChatId!, message);

    const duration = Date.now() - startTime;
    console.log(`[${requestId}] Notification ${sent ? "sent" : "failed"} in ${duration}ms`);

    return new Response(
      JSON.stringify({
        success: sent,
        message: sent ? "Notification sent" : "Failed to send notification",
        profile_id: profile.id,
        version: VERSION,
        requestId,
        duration_ms: duration,
      }),
      {
        status: sent ? 200 : 500,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-Version": VERSION,
          "X-Duration-Ms": duration.toString(),
        },
      }
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Edge function error:`, error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
        version: VERSION,
        requestId,
        duration_ms: duration,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-Version": VERSION,
          "X-Duration-Ms": duration.toString(),
        },
      }
    );
  }
});
