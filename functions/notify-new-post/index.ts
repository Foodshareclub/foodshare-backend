/**
 * Notify New Post Edge Function
 *
 * Database webhook trigger that sends Telegram notifications
 * when new posts are created (including volunteer applications).
 */

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
  volunteer: "🙌",
  thing: "🎁",
  borrow: "🔧",
  wanted: "🤲",
  business: "🏛️",
  challenge: "🏆",
  zerowaste: "♻️",
  vegan: "🌱",
  default: "📦",
};

async function sendTelegram(text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

function formatMessage(post: {
  id: string | number;
  post_name: string;
  post_type?: string | null;
  post_address?: string | null;
  post_description?: string | null;
}): string {
  const emoji = postTypeEmoji[post.post_type || "default"] || postTypeEmoji.default;
  const postUrl = `${appUrl}/food/${post.id}`;
  const isVolunteer = post.post_type === "volunteer";

  // Special formatting for volunteer applications
  if (isVolunteer) {
    let message = `${emoji} <b>NEW VOLUNTEER APPLICATION!</b>\n\n`;
    message += `<b>${post.post_name}</b>\n`;

    if (post.post_address) {
      message += `📍 ${post.post_address}\n`;
    }

    if (post.post_description) {
      const shortDesc = post.post_description.length > 200
        ? post.post_description.substring(0, 200) + "..."
        : post.post_description;
      message += `\n<i>${shortDesc}</i>\n`;
    }

    message += `\n⏳ <b>Status: Pending Approval</b>`;
    message += `\n\n🔗 <a href="${appUrl}/volunteers">View Volunteers</a>`;
    message += ` | <a href="${appUrl}/admin/listings">Admin Dashboard</a>`;

    return message;
  }

  // Standard post message
  let message = `${emoji} <b>New ${post.post_type || "food"} listing!</b>\n\n`;
  message += `<b>${post.post_name}</b>\n`;

  if (post.post_address) {
    message += `📍 ${post.post_address}\n`;
  }

  if (post.post_description) {
    const shortDesc = post.post_description.length > 150
      ? post.post_description.substring(0, 150) + "..."
      : post.post_description;
    message += `\n${shortDesc}\n`;
  }

  message += `\n🔗 <a href="${postUrl}">View on FoodShare</a>`;

  return message;
}

Deno.serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Health check
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ status: "healthy", service: "notify-new-post" }),
      { headers: corsHeaders }
    );
  }

  try {
    const { record } = await req.json();

    if (!record || !record.post_name) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing record or post_name" }),
        { headers: corsHeaders, status: 400 }
      );
    }

    const message = formatMessage(record);
    const sent = await sendTelegram(message);

    return new Response(
      JSON.stringify({
        success: sent,
        message: sent ? "Notification sent" : "Failed to send notification",
        postId: record.id,
      }),
      { headers: corsHeaders, status: sent ? 200 : 500 }
    );
  } catch (err) {
    console.error("Error processing request:", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { headers: corsHeaders, status: 400 }
    );
  }
});
