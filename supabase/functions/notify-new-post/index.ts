import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!; // Your personal Telegram chat ID
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

const supabase = createClient(supabaseUrl, supabaseKey);

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

async function sendTelegramMessage(chatId: string, text: string) {
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
      console.error("Telegram API error:", result);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    return false;
  }
}

async function getProfile(profileId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("nickname, first_name, second_name")
    .eq("id", profileId)
    .single();

  if (error) {
    console.error("Error fetching profile:", error);
    return null;
  }
  return data;
}

function formatPostMessage(post: any, profile: any) {
  const emoji = postTypeEmoji[post.post_type] || postTypeEmoji.default;
  const fullName = profile
    ? [profile.first_name, profile.second_name].filter(Boolean).join(" ")
    : "";
  const userName = fullName || profile?.nickname || "Someone";
  const postUrl = `${appUrl}/product/${post.id}`;

  let message = `${emoji} <b>New ${post.post_type} listing!</b>\n\n`;
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

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    console.log("Received webhook payload:", JSON.stringify(payload));

    const post = payload.record || payload;

    if (!post.id || !post.post_name) {
      return new Response(JSON.stringify({ error: "Invalid post data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const profile = post.profile_id ? await getProfile(post.profile_id) : null;
    const message = formatPostMessage(post, profile);
    const sent = await sendTelegramMessage(adminChatId, message);

    return new Response(
      JSON.stringify({
        success: sent,
        message: sent ? "Notification sent" : "Failed to send notification",
      }),
      {
        status: sent ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
