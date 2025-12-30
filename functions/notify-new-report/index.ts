/**
 * Notify New Report Edge Function
 *
 * Database webhook trigger that sends Telegram notifications
 * when content reports are submitted.
 *
 * Features:
 * - Post reports (food listings, fridges)
 * - Forum reports (posts and comments)
 * - General reports
 * - AI severity scoring display
 * - Image attachment support
 *
 * Trigger: Database INSERT on post_reports, forum_reports tables
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

// =============================================================================
// Request Schema (Database Webhook Payload)
// =============================================================================

const reportSchema = z.object({
  record: z.object({
    id: z.union([z.number(), z.string()]),
    reason: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    reporter_id: z.string().optional().nullable(),
    profile_id: z.string().optional().nullable(),
    reported_profile_id: z.string().optional().nullable(),
    post_id: z.number().optional().nullable(),
    forum_id: z.number().optional().nullable(),
    comment_id: z.number().optional().nullable(),
    ai_severity_score: z.number().optional().nullable(),
    ai_recommended_action: z.string().optional().nullable(),
  }).passthrough(),
  table: z.string().optional(),
}).passthrough();

type ReportPayload = z.infer<typeof reportSchema>;

// =============================================================================
// Types
// =============================================================================

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
  images: string[] | null;
  profiles: Profile | null;
}

interface ForumPost {
  id: number;
  forum_post_name: string | null;
  forum_post_description: string | null;
  forum_post_image: string | null;
  post_type: string | null;
  forum_published: boolean;
  slug: string | null;
  profiles: Profile | null;
}

interface Comment {
  id: number;
  comment: string | null;
  forum_id: number;
  profiles: Profile | null;
}

// =============================================================================
// Response Types
// =============================================================================

interface NotifyResponse {
  success: boolean;
  message: string;
  table: string;
  hasImage: boolean;
}

// =============================================================================
// Telegram API
// =============================================================================

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
      logger.error("Telegram sendPhoto error", { error: result });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("Error sending Telegram photo", { error });
    return false;
  }
}

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
// Data Fetching Helpers
// =============================================================================

type SupabaseClient = ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>;

async function getProfile(supabase: SupabaseClient, profileId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("nickname, first_name, second_name, email, avatar_url")
    .eq("id", profileId)
    .single();

  if (error) {
    logger.error("Error fetching profile", { error: error.message });
    return null;
  }
  return data;
}

async function getPost(supabase: SupabaseClient, postId: number): Promise<Post | null> {
  const { data, error } = await supabase
    .from("posts")
    .select(`
      id, post_name, post_type, post_address, post_description,
      is_active, images, profile_id,
      profiles:profile_id (nickname, first_name, second_name)
    `)
    .eq("id", postId)
    .single();

  if (error) {
    logger.error("Error fetching post", { error: error.message });
    return null;
  }
  return data as Post;
}

async function getForumPost(supabase: SupabaseClient, forumId: number): Promise<ForumPost | null> {
  const { data, error } = await supabase
    .from("forum")
    .select(`
      id, forum_post_name, forum_post_description, forum_post_image,
      post_type, forum_published, slug, profile_id,
      profiles:profile_id (nickname, first_name, second_name)
    `)
    .eq("id", forumId)
    .single();

  if (error) {
    logger.error("Error fetching forum post", { error: error.message });
    return null;
  }
  return data as ForumPost;
}

async function getComment(supabase: SupabaseClient, commentId: number): Promise<Comment | null> {
  const { data, error } = await supabase
    .from("comments")
    .select(`
      id, comment, forum_id, user_id,
      profiles:user_id (nickname, first_name, second_name)
    `)
    .eq("id", commentId)
    .single();

  if (error) {
    logger.error("Error fetching comment", { error: error.message });
    return null;
  }
  return data as Comment;
}

// =============================================================================
// Formatting Helpers
// =============================================================================

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

function getCanonicalUrl(
  type: "post" | "forum" | "comment",
  id: number | string,
  slug?: string | null
): string {
  switch (type) {
    case "post":
      return `${appUrl}/food/${id}`;
    case "forum":
      return slug ? `${appUrl}/forum/${slug}` : `${appUrl}/forum/${id}`;
    case "comment":
      return slug ? `${appUrl}/forum/${slug}#comment-${id}` : `${appUrl}/forum/${id}`;
    default:
      return appUrl;
  }
}

// =============================================================================
// Message Formatting
// =============================================================================

function formatPostReportMessage(
  report: ReportPayload["record"],
  reporter: Profile | null,
  post: Post | null
): { message: string; imageUrl: string | null } {
  const reason = report.reason;
  const emoji = reportReasonEmoji[reason || ""] || reportReasonEmoji.default;
  const reporterName = getProfileName(reporter);

  let message = `${emoji} <b>POST REPORTED</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Report details
  message += `<b>📋 Report Details</b>\n`;
  message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

  if (report.description && report.description !== "-") {
    message += `• Description: ${escapeHtml(truncateText(report.description, 150))}\n`;
  }

  if (report.ai_severity_score !== null && report.ai_severity_score !== undefined) {
    const severityIcon = report.ai_severity_score >= 70 ? "🔴" : report.ai_severity_score >= 40 ? "🟡" : "🟢";
    message += `• AI Severity: ${severityIcon} ${report.ai_severity_score}/100\n`;
  }

  if (report.ai_recommended_action) {
    message += `• AI Recommendation: ${report.ai_recommended_action.replace(/_/g, " ")}\n`;
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

function formatForumReportMessage(
  report: ReportPayload["record"],
  reporter: Profile | null,
  forumPost: ForumPost | null,
  comment: Comment | null
): { message: string; imageUrl: string | null } {
  const reason = report.reason;
  const emoji = reportReasonEmoji[reason || ""] || reportReasonEmoji.default;
  const reporterName = getProfileName(reporter);
  const isCommentReport = !!report.comment_id;

  let message = `${emoji} <b>${isCommentReport ? "COMMENT" : "FORUM POST"} REPORTED</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Report details
  message += `<b>📋 Report Details</b>\n`;
  message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

  if (report.description && report.description !== "-") {
    message += `• Description: ${escapeHtml(truncateText(report.description, 150))}\n`;
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
  if (report.reported_profile_id) {
    message += `\n<b>🎯 Reported User ID:</b> ${report.reported_profile_id}\n`;
  }

  // Reporter info
  message += `\n<b>👤 Reported by:</b> ${reporterName}`;
  if (reporter?.email && reporter.email !== "-") {
    message += ` (${reporter.email})`;
  }

  message += `\n\n🔧 <a href="${appUrl}/admin/forum/reports">Manage in Admin</a>`;

  return { message, imageUrl };
}

function formatGeneralReportMessage(
  report: ReportPayload["record"],
  reporter: Profile | null
): { message: string; imageUrl: string | null } {
  const reporterName = getProfileName(reporter);

  let message = `📢 <b>GENERAL REPORT</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (report.description && report.description !== "-") {
    message += `<b>Description:</b>\n${escapeHtml(truncateText(report.description, 400))}\n`;
  }

  if (report.notes && report.notes !== "-") {
    message += `\n<b>Notes:</b> ${escapeHtml(report.notes)}\n`;
  }

  message += `\n<b>👤 Reported by:</b> ${reporterName}`;
  if (reporter?.email && reporter.email !== "-") {
    message += ` (${reporter.email})`;
  }

  message += `\n\n🔧 <a href="${appUrl}/admin/reports">Manage in Admin</a>`;

  return { message, imageUrl: null };
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleNotifyNewReport(ctx: HandlerContext<ReportPayload>): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const report = body.record;
  const tableName = body.table || "unknown";

  logger.info("Processing report notification", {
    reportId: report.id,
    table: tableName,
    reason: report.reason,
    requestId: requestCtx?.requestId,
  });

  // Get reporter profile
  const reporterId = report.reporter_id || report.profile_id;
  const reporter = reporterId ? await getProfile(supabase, reporterId) : null;

  let message: string;
  let imageUrl: string | null = null;

  // Handle post_reports (food listings, fridges, etc.)
  if (tableName === "post_reports" || (report.post_id && report.reason)) {
    const post = report.post_id ? await getPost(supabase, report.post_id) : null;
    const result = formatPostReportMessage(report, reporter, post);
    message = result.message;
    imageUrl = result.imageUrl;
  }
  // Handle forum_reports (forum posts and comments)
  else if (tableName === "forum_reports" || report.forum_id !== undefined) {
    const forumPost = report.forum_id ? await getForumPost(supabase, report.forum_id) : null;
    const comment = report.comment_id ? await getComment(supabase, report.comment_id) : null;
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

  logger.info("Report notification sent", {
    success: sent,
    reportId: report.id,
    table: tableName,
    hasImage: !!imageUrl,
  });

  const result: NotifyResponse = {
    success: sent,
    message: sent ? "Report notification sent" : "Failed to send notification",
    table: tableName,
    hasImage: !!imageUrl,
  };

  return ok(result, ctx, sent ? 200 : 500);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "notify-new-report",
  version: "2.0.0",
  requireAuth: false, // Database webhook - no JWT auth
  routes: {
    POST: {
      schema: reportSchema,
      handler: handleNotifyNewReport,
    },
  },
});
