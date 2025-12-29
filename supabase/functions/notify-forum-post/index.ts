import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;
const channelUsername = "@foodshare_club";
// Topic/thread ID for forum-enabled channels (optional - posts to General if not set)
const channelThreadId = Deno.env.get("CHANNEL_THREAD_ID");
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

const supabase = createClient(supabaseUrl, supabaseKey);

async function sendTelegramMessage(chatId: string, text: string, threadId?: string) {
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    };

    // Add thread ID for forum-enabled channels/groups
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

async function isSuperAdmin(profileId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", profileId);

  if (error) {
    console.error("Error checking superadmin status:", error);
    return false;
  }

  const roles = data?.map((r: { roles: { name: string } }) => r.roles?.name).filter(Boolean) || [];
  return roles.includes("superadmin");
}

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
  post: Record<string, unknown>,
  _profile: Record<string, string> | null
): string {
  const postUrl = `${appUrl}/forum/${post.slug || post.id}`;

  const description =
    typeof post.forum_post_description === "string" ? stripHtml(post.forum_post_description) : "";
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
  post: Record<string, unknown>,
  _profile: Record<string, string> | null
): string {
  const postUrl = `${appUrl}/forum/${post.slug || post.id}`;

  const description =
    typeof post.forum_post_description === "string" ? stripHtml(post.forum_post_description) : "";
  const shortDesc = description.length > 300 ? description.substring(0, 300) + "..." : description;

  let message = `<b>${post.forum_post_name}</b>\n`;
  if (shortDesc) {
    message += `\n${shortDesc}\n`;
  }
  message += `\n<a href="${postUrl}">Read more on FoodShare</a>`;

  return message;
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    console.log("Received forum webhook payload:", JSON.stringify(payload));

    const post = payload.record || payload;

    if (!post.id || !post.forum_post_name) {
      return new Response(JSON.stringify({ error: "Invalid forum post data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (post.forum_published === false) {
      return new Response(
        JSON.stringify({ message: "Post not published, skipping notification" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const profileId = post.profile_id as string;
    const profile = profileId ? await getProfile(profileId) : null;

    const adminMessage = formatAdminMessage(post, profile);
    const adminSent = await sendTelegramMessage(adminChatId, adminMessage);
    console.log("Admin notification sent:", adminSent);

    let channelSent = false;
    if (profileId) {
      const superAdmin = await isSuperAdmin(profileId);
      console.log("Author is superadmin:", superAdmin);

      if (superAdmin) {
        const channelMessage = formatChannelMessage(post, profile);
        channelSent = await sendTelegramMessage(channelUsername, channelMessage, channelThreadId);
        console.log("Channel notification sent:", channelSent, "threadId:", channelThreadId);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        adminNotification: adminSent,
        channelNotification: channelSent,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
