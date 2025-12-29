import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const botToken = Deno.env.get("BOT_TOKEN")!;
const adminChatId = Deno.env.get("ADMIN_CHAT_ID")!;
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

const supabase = createClient(supabaseUrl, supabaseKey);

// Types
interface Profile {
  nickname: string | null;
  first_name: string | null;
  second_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface Post {
  id: number;
  post_name: string | null;
  post_type: string | null;
  post_address: string | null;
  post_description: string | null;
  is_active: boolean;
  created_at: string;
  images: string[] | null;
  profile_id: string;
  profiles: Profile | null;
}

interface ForumPost {
  id: number;
  forum_post_name: string | null;
  forum_post_description: string | null;
  forum_post_image: string | null;
  post_type: string | null;
  forum_published: boolean;
  forum_post_created_at: string;
  slug: string | null;
  profile_id: string;
  profiles: Profile | null;
}

interface Comment {
  id: number;
  comment: string | null;
  comment_created_at: string;
  forum_id: number;
  user_id: string;
  profiles: Profile | null;
}

interface _Challenge {
  id: number;
  challenge_title: string | null;
  challenge_description: string | null;
  challenge_image: string | null;
  challenge_difficulty: string | null;
  challenge_published: boolean;
  challenge_created_at: string;
  profile_id: string;
  profiles: Profile | null;
}

const reportReasonEmoji: Record<string, string> = {
  spam: "🚫",
  inappropriate: "⚠️",
  misleading: "🎭",
  expired: "⏰",
  wrong_location: "📍",
  safety_concern: "🛡️",
  duplicate: "📋",
  harassment: "😠",
  hate_speech: "🚨",
  misinformation: "❌",
  off_topic: "📌",
  other: "❓",
  default: "📢",
};

const postTypeEmoji: Record<string, string> = {
  food: "🍎",
  things: "📦",
  borrow: "🔄",
  wanted: "🙋",
  fridge: "🧊",
  foodbank: "🏦",
  business: "🏢",
  volunteer: "🤝",
  challenge: "🏆",
  zerowaste: "♻️",
  vegan: "🌱",
  community: "👥",
  default: "📝",
};

/**
 * Get canonical URL for SEO-friendly links with OG tags
 */
function getCanonicalUrl(
  type: "post" | "forum" | "challenge" | "comment",
  id: number | string,
  slug?: string | null
): string {
  switch (type) {
    case "post":
      return `${appUrl}/food/${id}`;
    case "forum":
      return slug ? `${appUrl}/forum/${slug}` : `${appUrl}/forum/${id}`;
    case "challenge":
      return `${appUrl}/challenge/${id}`;
    case "comment":
      return slug ? `${appUrl}/forum/${slug}#comment-${id}` : `${appUrl}/forum/${id}`;
    default:
      return appUrl;
  }
}

/**
 * Send photo with caption to Telegram
 */
async function sendTelegramPhoto(
  chatId: string,
  photoUrl: string,
  caption: string
): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
      }),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error("Telegram sendPhoto error:", result);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error sending Telegram photo:", error);
    return false;
  }
}

/**
 * Send text message to Telegram
 */
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
      console.error("Telegram API error:", result);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    return false;
  }
}

async function getProfile(profileId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("nickname, first_name, second_name, email, avatar_url")
    .eq("id", profileId)
    .single();

  if (error) {
    console.error("Error fetching profile:", error);
    return null;
  }
  return data;
}

async function getPost(postId: number): Promise<Post | null> {
  const { data, error } = await supabase
    .from("posts")
    .select(
      `
      id, post_name, post_type, post_address, post_description,
      is_active, created_at, images, profile_id,
      profiles:profile_id (nickname, first_name, second_name)
    `
    )
    .eq("id", postId)
    .single();

  if (error) {
    console.error("Error fetching post:", error);
    return null;
  }
  return data as Post;
}

async function getForumPost(forumId: number): Promise<ForumPost | null> {
  const { data, error } = await supabase
    .from("forum")
    .select(
      `
      id, forum_post_name, forum_post_description, forum_post_image,
      post_type, forum_published, forum_post_created_at, slug, profile_id,
      profiles:profile_id (nickname, first_name, second_name)
    `
    )
    .eq("id", forumId)
    .single();

  if (error) {
    console.error("Error fetching forum post:", error);
    return null;
  }
  return data as ForumPost;
}

async function getComment(commentId: number): Promise<Comment | null> {
  const { data, error } = await supabase
    .from("comments")
    .select(
      `
      id, comment, comment_created_at, forum_id, user_id,
      profiles:user_id (nickname, first_name, second_name)
    `
    )
    .eq("id", commentId)
    .single();

  if (error) {
    console.error("Error fetching comment:", error);
    return null;
  }
  return data as Comment;
}

function getProfileName(profile: Profile | null): string {
  if (!profile) return "Unknown";
  const fullName = [profile.first_name, profile.second_name].filter(Boolean).join(" ");
  return fullName || profile.nickname || "Unknown";
}

function truncateText(text: string | null | undefined, maxLength: number): string {
  if (!text || text === "-") return "";
  return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

// Format post report with full post details
function formatPostReportMessage(
  report: Record<string, unknown>,
  reporter: Profile | null,
  post: Post | null
): { message: string; imageUrl: string | null } {
  const reason = report.reason as string | undefined;
  const emoji = reportReasonEmoji[reason || ""] || reportReasonEmoji.default;
  const reporterName = getProfileName(reporter);

  let message = `${emoji} <b>POST REPORTED</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Report details
  message += `<b>📋 Report Details</b>\n`;
  message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

  const description = report.description as string | undefined;
  if (description && description !== "-") {
    message += `• Description: ${escapeHtml(truncateText(description, 150))}\n`;
  }

  const aiSeverity = report.ai_severity_score as number | null | undefined;
  if (aiSeverity !== null && aiSeverity !== undefined) {
    const severityIcon = aiSeverity >= 70 ? "🔴" : aiSeverity >= 40 ? "🟡" : "🟢";
    message += `• AI Severity: ${severityIcon} ${aiSeverity}/100\n`;
  }

  const aiAction = report.ai_recommended_action as string | undefined;
  if (aiAction) {
    message += `• AI Recommendation: ${aiAction.replace(/_/g, " ")}\n`;
  }

  let imageUrl: string | null = null;

  // Reported post details
  if (post) {
    const postEmoji = postTypeEmoji[post.post_type || ""] || postTypeEmoji.default;
    const postAuthor = getProfileName(post.profiles);
    const canonicalUrl = getCanonicalUrl("post", post.id);

    message += `\n<b>${postEmoji} Reported Post</b>\n`;
    message += `• Title: <b>${escapeHtml(post.post_name || "Untitled")}</b>\n`;
    message += `• Type: ${post.post_type || "Unknown"}\n`;
    message += `• Author: ${postAuthor}\n`;
    message += `• Status: ${post.is_active ? "✅ Active" : "❌ Inactive"}\n`;

    if (post.post_address && post.post_address !== "-") {
      message += `• Location: 📍 ${escapeHtml(truncateText(post.post_address, 50))}\n`;
    }

    if (post.post_description && post.post_description !== "-") {
      message += `\n<b>Post Content:</b>\n<i>${escapeHtml(truncateText(post.post_description, 200))}</i>\n`;
    }

    message += `\n🔗 <a href="${canonicalUrl}">View Post</a>\n`;

    if (post.images && post.images.length > 0) {
      imageUrl = post.images[0];
    }
  }

  // Reporter info
  message += `\n<b>👤 Reported by:</b> ${reporterName}`;
  if (reporter?.email && reporter.email !== "-") {
    message += ` (${reporter.email})`;
  }

  message += `\n\n🔧 <a href="${appUrl}/admin/reports">Manage in Admin</a>`;

  return { message, imageUrl };
}

// Format forum report with full forum post/comment details
function formatForumReportMessage(
  report: Record<string, unknown>,
  reporter: Profile | null,
  forumPost: ForumPost | null,
  comment: Comment | null
): { message: string; imageUrl: string | null } {
  const reason = report.reason as string | undefined;
  const emoji = reportReasonEmoji[reason || ""] || reportReasonEmoji.default;
  const reporterName = getProfileName(reporter);
  const isCommentReport = !!report.comment_id;

  let message = `${emoji} <b>${isCommentReport ? "COMMENT" : "FORUM POST"} REPORTED</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Report details
  message += `<b>📋 Report Details</b>\n`;
  message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

  const description = report.description as string | undefined;
  if (description && description !== "-") {
    message += `• Description: ${escapeHtml(truncateText(description, 150))}\n`;
  }

  let imageUrl: string | null = null;

  // Reported comment
  if (isCommentReport && comment) {
    const commentAuthor = getProfileName(comment.profiles);
    message += `\n<b>💬 Reported Comment</b>\n`;
    message += `• Author: ${commentAuthor}\n`;
    message += `• Content:\n<i>${escapeHtml(truncateText(comment.comment, 200))}</i>\n`;
  }

  // Forum post context
  if (forumPost) {
    const postAuthor = getProfileName(forumPost.profiles);
    const canonicalUrl =
      isCommentReport && comment
        ? getCanonicalUrl("comment", comment.id, forumPost.slug)
        : getCanonicalUrl("forum", forumPost.id, forumPost.slug);

    message += `\n<b>📝 ${isCommentReport ? "Parent Forum Post" : "Reported Forum Post"}</b>\n`;
    message += `• Title: <b>${escapeHtml(forumPost.forum_post_name || "Untitled")}</b>\n`;
    message += `• Type: ${forumPost.post_type || "discussion"}\n`;
    message += `• Author: ${postAuthor}\n`;
    message += `• Status: ${forumPost.forum_published ? "✅ Published" : "❌ Unpublished"}\n`;

    if (!isCommentReport && forumPost.forum_post_description) {
      const plainText = stripHtml(forumPost.forum_post_description);
      message += `\n<b>Content:</b>\n<i>${escapeHtml(truncateText(plainText, 200))}</i>\n`;
    }

    message += `\n🔗 <a href="${canonicalUrl}">View Forum Post</a>\n`;

    if (forumPost.forum_post_image) {
      imageUrl = forumPost.forum_post_image;
    }
  }

  // Reported user info
  const reportedProfileId = report.reported_profile_id as string | undefined;
  if (reportedProfileId) {
    message += `\n<b>🎯 Reported User ID:</b> ${reportedProfileId}\n`;
  }

  // Reporter info
  message += `\n<b>👤 Reported by:</b> ${reporterName}`;
  if (reporter?.email && reporter.email !== "-") {
    message += ` (${reporter.email})`;
  }

  message += `\n\n🔧 <a href="${appUrl}/admin/forum/reports">Manage in Admin</a>`;

  return { message, imageUrl };
}

// Format general report
function formatGeneralReportMessage(
  report: Record<string, unknown>,
  reporter: Profile | null
): { message: string; imageUrl: string | null } {
  const reporterName = getProfileName(reporter);

  let message = `📢 <b>GENERAL REPORT</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  const description = report.description as string | undefined;
  if (description && description !== "-") {
    message += `<b>Description:</b>\n${escapeHtml(truncateText(description, 400))}\n`;
  }

  const notes = report.notes as string | undefined;
  if (notes && notes !== "-") {
    message += `\n<b>Notes:</b> ${escapeHtml(notes)}\n`;
  }

  message += `\n<b>👤 Reported by:</b> ${reporterName}`;
  if (reporter?.email && reporter.email !== "-") {
    message += ` (${reporter.email})`;
  }

  message += `\n\n🔧 <a href="${appUrl}/admin/reports">Manage in Admin</a>`;

  return { message, imageUrl: null };
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    console.log("Received webhook payload:", JSON.stringify(payload));

    const report = (payload.record || payload) as Record<string, unknown>;
    const tableName = (payload.table || "unknown") as string;

    if (!report.id) {
      return new Response(JSON.stringify({ error: "Invalid report data" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get reporter profile
    const reporterId = (report.reporter_id || report.profile_id) as string | undefined;
    const reporter = reporterId ? await getProfile(reporterId) : null;

    let message: string;
    let imageUrl: string | null = null;

    // Handle post_reports (food listings, fridges, etc.)
    if (tableName === "post_reports" || (report.post_id && report.reason)) {
      const postId = report.post_id as number;
      const post = postId ? await getPost(postId) : null;
      const result = formatPostReportMessage(report, reporter, post);
      message = result.message;
      imageUrl = result.imageUrl;
    }
    // Handle forum_reports (forum posts and comments)
    else if (tableName === "forum_reports" || report.forum_id !== undefined) {
      const forumId = report.forum_id as number | undefined;
      const commentId = report.comment_id as number | undefined;
      const forumPost = forumId ? await getForumPost(forumId) : null;
      const comment = commentId ? await getComment(commentId) : null;
      const result = formatForumReportMessage(report, reporter, forumPost, comment);
      message = result.message;
      imageUrl = result.imageUrl;
    }
    // Handle general reports
    else {
      const result = formatGeneralReportMessage(report, reporter);
      message = result.message;
      imageUrl = result.imageUrl;
    }

    // Try to send photo first, fall back to text message
    let sent = false;
    if (imageUrl) {
      const caption = message.length > 1024 ? message.substring(0, 1021) + "..." : message;
      sent = await sendTelegramPhoto(adminChatId, imageUrl, caption);
    }

    if (!sent) {
      sent = await sendTelegramMessage(adminChatId, message);
    }

    return new Response(
      JSON.stringify({
        success: sent,
        message: sent ? "Report notification sent" : "Failed to send notification",
        table: tableName,
        hasImage: !!imageUrl,
      }),
      { status: sent ? 200 : 500, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Edge function error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
