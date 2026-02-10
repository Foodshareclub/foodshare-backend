/**
 * Notification Triggers Handler
 *
 * Consolidates all database webhook triggers for notifications:
 * - new-post: Telegram admin notification for new posts
 * - new-listing: Notify nearby users about food listings
 * - new-user: Telegram admin notification for new users
 * - new-report: Telegram admin notification for reports
 * - forum-post: Telegram admin notification for forum posts
 *
 * @module api-v1-notifications/handlers/triggers
 */

import type { NotificationContext } from "../types.ts";
import { logger } from "../../../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const botToken = Deno.env.get("BOT_TOKEN") || "";
const adminChatId = Deno.env.get("ADMIN_CHAT_ID") || "";
const channelUsername = "@foodshare_club";
const channelThreadId = Deno.env.get("CHANNEL_THREAD_ID");
const appUrl = Deno.env.get("APP_URL") || "https://foodshare.club";

// =============================================================================
// Emoji Mappings
// =============================================================================

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

// =============================================================================
// Telegram API Helpers
// =============================================================================

async function sendTelegram(
  chatId: string,
  text: string,
  threadId?: string,
): Promise<boolean> {
  if (!botToken || !chatId) {
    logger.warn("Telegram not configured", { hasBotToken: !!botToken, hasChatId: !!chatId });
    return false;
  }

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

    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    return data.ok === true;
  } catch (error) {
    logger.error("Telegram send failed", error as Error);
    return false;
  }
}

async function sendTelegramPhoto(
  chatId: string,
  photoUrl: string,
  caption: string,
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption.length > 1024 ? caption.substring(0, 1021) + "..." : caption,
        parse_mode: "HTML",
      }),
    });

    const result = await response.json();
    return result.ok === true;
  } catch (error) {
    logger.error("Telegram photo send failed", error as Error);
    return false;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string | null | undefined, max: number): string {
  if (!text || text === "-") return "";
  return text.length > max ? text.substring(0, max) + "..." : text;
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

function getProfileName(
  profile:
    | { first_name?: string | null; second_name?: string | null; nickname?: string | null }
    | null,
): string {
  if (!profile) return "Unknown";
  const fullName = [profile.first_name, profile.second_name].filter(Boolean).join(" ");
  return fullName || profile.nickname || "Unknown";
}

// =============================================================================
// Trigger: New Post (Database Webhook)
// =============================================================================

export async function handleTriggerNewPost(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const payload = body as { record?: Record<string, unknown> };
  const record = payload.record;

  if (!record || !record.post_name) {
    return { success: false, error: "Missing record or post_name" };
  }

  const emoji = postTypeEmoji[(record.post_type as string) || "default"] || postTypeEmoji.default;
  const postUrl = `${appUrl}/food/${record.id}`;
  const isVolunteer = record.post_type === "volunteer";

  let message: string;
  if (isVolunteer) {
    message = `${emoji} <b>NEW VOLUNTEER APPLICATION!</b>\n\n`;
    message += `<b>${escapeHtml(record.post_name as string)}</b>\n`;
    if (record.post_address) message += `📍 ${escapeHtml(record.post_address as string)}\n`;
    if (record.post_description) {
      message += `\n<i>${escapeHtml(truncate(record.post_description as string, 200))}</i>\n`;
    }
    message += `\n⏳ <b>Status: Pending Approval</b>`;
    message += `\n\n🔗 <a href="${appUrl}/volunteers">View Volunteers</a>`;
    message += ` | <a href="${appUrl}/admin/listings">Admin Dashboard</a>`;
  } else {
    message = `${emoji} <b>New ${record.post_type || "food"} listing!</b>\n\n`;
    message += `<b>${escapeHtml(record.post_name as string)}</b>\n`;
    if (record.post_address) message += `📍 ${escapeHtml(record.post_address as string)}\n`;
    if (record.post_description) {
      message += `\n${escapeHtml(truncate(record.post_description as string, 150))}\n`;
    }
    message += `\n🔗 <a href="${postUrl}">View on FoodShare</a>`;
  }

  const sent = await sendTelegram(adminChatId, message);

  logger.info("New post trigger processed", {
    requestId: context.requestId,
    postId: record.id,
    sent,
  });

  return {
    success: sent,
    message: sent ? "Notification sent" : "Failed to send notification",
  };
}

// =============================================================================
// Trigger: New User (Database Webhook)
// =============================================================================

export async function handleTriggerNewUser(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; message?: string; error?: string }> {
  const payload = body as { record?: Record<string, unknown> };
  const record = payload.record;

  if (!record) {
    return { success: false, error: "Missing record" };
  }

  const name = [record.first_name, record.second_name].filter(Boolean).join(" ") ||
    record.nickname ||
    "New user";

  const message = `🎉 <b>New user joined FoodShare!</b>\n\n👤 <b>${
    escapeHtml(name as string)
  }</b>\n📧 ${escapeHtml((record.email as string) || "N/A")}\n📅 ${
    record.created_time || new Date().toISOString()
  }`;

  const sent = await sendTelegram(adminChatId, message);

  logger.info("New user trigger processed", {
    requestId: context.requestId,
    profileId: record.id,
    sent,
  });

  return {
    success: sent,
    message: sent ? "Notification sent" : "Failed to send notification",
  };
}

// =============================================================================
// Trigger: Forum Post (Database Webhook)
// =============================================================================

export async function handleTriggerForumPost(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; adminSent?: boolean; channelSent?: boolean; error?: string }> {
  const payload = body as { record?: Record<string, unknown> };
  const record = payload.record;

  if (!record || !record.forum_post_name) {
    return { success: false, error: "Missing record or forum_post_name" };
  }

  // Skip unpublished posts
  if (record.forum_published === false) {
    return { success: true, adminSent: false, channelSent: false };
  }

  const postUrl = `${appUrl}/forum/${record.slug || record.id}`;
  const description = stripHtml(record.forum_post_description as string);
  const shortDesc = truncate(description, 150);

  let adminMessage = `<b>New Forum Post!</b>\n\n`;
  adminMessage += `<b>${escapeHtml(record.forum_post_name as string)}</b>\n`;
  if (shortDesc) adminMessage += `\n${escapeHtml(shortDesc)}\n`;
  adminMessage += `\n<a href="${postUrl}">View on FoodShare</a>`;

  const adminSent = await sendTelegram(adminChatId, adminMessage);

  // Check if author is superadmin for channel posting
  let channelSent = false;
  if (record.profile_id && context.supabase) {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("roles!inner(name)")
      .eq("profile_id", record.profile_id);

    const isSuperAdmin = roles?.some(
      (r: { roles: { name: string } }) => r.roles?.name === "superadmin",
    );

    if (isSuperAdmin) {
      let channelMessage = `<b>${escapeHtml(record.forum_post_name as string)}</b>\n`;
      if (shortDesc) channelMessage += `\n${escapeHtml(truncate(description, 300))}\n`;
      channelMessage += `\n<a href="${postUrl}">Read more on FoodShare</a>`;

      channelSent = await sendTelegram(channelUsername, channelMessage, channelThreadId);
    }
  }

  logger.info("Forum post trigger processed", {
    requestId: context.requestId,
    postId: record.id,
    adminSent,
    channelSent,
  });

  return { success: adminSent || channelSent, adminSent, channelSent };
}

// =============================================================================
// Trigger: New Report (Database Webhook)
// =============================================================================

export async function handleTriggerNewReport(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; message?: string; hasImage?: boolean; error?: string }> {
  const payload = body as { record?: Record<string, unknown>; table?: string };
  const record = payload.record;
  const tableName = payload.table || "unknown";

  if (!record) {
    return { success: false, error: "Missing record" };
  }

  const reason = record.reason as string;
  const emoji = reportReasonEmoji[reason || ""] || reportReasonEmoji.default;

  // Get reporter profile
  const reporterId = (record.reporter_id || record.profile_id) as string | null;
  let reporter: {
    first_name?: string | null;
    second_name?: string | null;
    nickname?: string | null;
    email?: string | null;
  } | null = null;
  if (reporterId && context.supabase) {
    const { data } = await context.supabase
      .from("profiles")
      .select("nickname, first_name, second_name, email")
      .eq("id", reporterId)
      .single();
    reporter = data;
  }

  let message: string;
  let imageUrl: string | null = null;

  // Handle post reports
  if (tableName === "post_reports" || record.post_id) {
    let post: Record<string, unknown> | null = null;
    if (record.post_id && context.supabase) {
      const { data } = await context.supabase
        .from("posts")
        .select("id, post_name, post_type, post_address, post_description, is_active, images")
        .eq("id", record.post_id)
        .single();
      post = data;
    }

    message = `${emoji} <b>POST REPORTED</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `<b>📋 Report Details</b>\n`;
    message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

    if (record.description && record.description !== "-") {
      message += `• Description: ${escapeHtml(truncate(record.description as string, 150))}\n`;
    }

    if (record.ai_severity_score !== null && record.ai_severity_score !== undefined) {
      const score = record.ai_severity_score as number;
      const severityIcon = score >= 70 ? "🔴" : score >= 40 ? "🟡" : "🟢";
      message += `• AI Severity: ${severityIcon} ${score}/100\n`;
    }

    if (post) {
      const postEmoji = postTypeEmoji[(post.post_type as string) || ""] || postTypeEmoji.default;
      message += `\n<b>${postEmoji} Reported Post</b>\n`;
      message += `• Title: <b>${escapeHtml(post.post_name as string)}</b>\n`;
      message += `• Type: ${post.post_type || "Unknown"}\n`;
      message += `• Status: ${post.is_active ? "✅ Active" : "❌ Inactive"}\n`;

      if (post.images && (post.images as string[]).length > 0) {
        imageUrl = (post.images as string[])[0];
      }

      message += `\n🔗 <a href="${appUrl}/food/${post.id}">View Post</a>\n`;
    }

    message += `\n<b>👤 Reported by:</b> ${getProfileName(reporter)}`;
    message += `\n\n🔧 <a href="${appUrl}/admin/reports">Manage in Admin</a>`;
  } // Handle forum reports
  else if (tableName === "forum_reports" || record.forum_id !== undefined) {
    const isCommentReport = !!record.comment_id;

    message = `${emoji} <b>${isCommentReport ? "COMMENT" : "FORUM POST"} REPORTED</b>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `<b>📋 Report Details</b>\n`;
    message += `• Reason: <b>${(reason || "Not specified").replace(/_/g, " ")}</b>\n`;

    if (record.description && record.description !== "-") {
      message += `• Description: ${escapeHtml(truncate(record.description as string, 150))}\n`;
    }

    message += `\n<b>👤 Reported by:</b> ${getProfileName(reporter)}`;
    message += `\n\n🔧 <a href="${appUrl}/admin/forum/reports">Manage in Admin</a>`;
  } // General reports
  else {
    message = `📢 <b>GENERAL REPORT</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    if (record.description && record.description !== "-") {
      message += `<b>Description:</b>\n${
        escapeHtml(truncate(record.description as string, 400))
      }\n`;
    }
    message += `\n<b>👤 Reported by:</b> ${getProfileName(reporter)}`;
    message += `\n\n🔧 <a href="${appUrl}/admin/reports">Manage in Admin</a>`;
  }

  // Send with image if available
  let sent = false;
  if (imageUrl) {
    sent = await sendTelegramPhoto(adminChatId, imageUrl, message);
  }
  if (!sent) {
    sent = await sendTelegram(adminChatId, message);
  }

  logger.info("Report trigger processed", {
    requestId: context.requestId,
    reportId: record.id,
    table: tableName,
    sent,
    hasImage: !!imageUrl,
  });

  return {
    success: sent,
    message: sent ? "Report notification sent" : "Failed to send notification",
    hasImage: !!imageUrl,
  };
}

// =============================================================================
// Trigger: New Listing (Authenticated - Notify Nearby Users)
// =============================================================================

export async function handleTriggerNewListing(
  body: unknown,
  context: NotificationContext,
): Promise<{
  success: boolean;
  notificationCount?: number;
  queuedCount?: number;
  deferredCount?: number;
  error?: string;
}> {
  if (!context.userId) {
    return { success: false, error: "Authentication required" };
  }

  const request = body as {
    foodItemId: string;
    title: string;
    latitude: number;
    longitude: number;
    radiusKm?: number;
    useQueue?: boolean;
    bypassQuietHours?: boolean;
  };

  if (!request.foodItemId || !request.title || !request.latitude || !request.longitude) {
    return {
      success: false,
      error: "Missing required fields: foodItemId, title, latitude, longitude",
    };
  }

  const {
    foodItemId,
    title,
    latitude,
    longitude,
    radiusKm = 10,
    useQueue = true,
    bypassQuietHours = false,
  } = request;

  let notificationCount = 0;
  let queuedCount = 0;
  let deferredCount = 0;

  // Queue-based notification with consolidation
  if (useQueue) {
    const { data: queueResult, error: queueError } = await context.supabase.rpc(
      "queue_nearby_notifications",
      {
        p_food_item_id: foodItemId,
        p_sender_id: context.userId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_title: title,
        p_notification_type: "nearby_post",
        p_radius_km: radiusKm,
        p_consolidation_key: `nearby_post_${latitude.toFixed(2)}_${longitude.toFixed(2)}`,
        p_bypass_quiet_hours: bypassQuietHours,
      },
    );

    if (!queueError && queueResult) {
      queuedCount = queueResult.queued || 0;
      deferredCount = queueResult.deferred || 0;
      notificationCount = queueResult.immediate || 0;
    }
  }

  // Fallback to direct bulk notification
  if (!useQueue || (queuedCount === 0 && notificationCount === 0)) {
    const { data: directCount, error: rpcError } = await context.supabase.rpc(
      "notify_nearby_users_bulk",
      {
        p_food_item_id: foodItemId,
        p_sender_id: context.userId,
        p_latitude: latitude,
        p_longitude: longitude,
        p_title: title,
        p_notification_type: "new_listing",
        p_radius_km: radiusKm,
      },
    );

    if (rpcError) {
      return { success: false, error: "Failed to send notifications" };
    }

    notificationCount = directCount || 0;
  }

  logger.info("New listing trigger processed", {
    requestId: context.requestId,
    foodItemId,
    notificationCount,
    queuedCount,
    deferredCount,
  });

  return {
    success: true,
    notificationCount,
    queuedCount,
    deferredCount,
  };
}

// =============================================================================
// Main Trigger Router
// =============================================================================

export async function handleTrigger(
  triggerType: string,
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  logger.info("Processing trigger", {
    requestId: context.requestId,
    triggerType,
  });

  try {
    switch (triggerType) {
      case "new-post":
        return handleTriggerNewPost(body, context);

      case "new-user":
        return handleTriggerNewUser(body, context);

      case "forum-post":
        return handleTriggerForumPost(body, context);

      case "new-report":
        return handleTriggerNewReport(body, context);

      case "new-listing":
        return handleTriggerNewListing(body, context);

      default:
        return { success: false, error: `Unknown trigger type: ${triggerType}` };
    }
  } catch (error) {
    logger.error("Trigger processing failed", error as Error);
    return { success: false, error: (error as Error).message };
  }
}
