/**
 * Unified Notification Delivery System v2.0
 *
 * Handles multi-platform notification delivery (FCM, APNs, Web Push)
 * with priority calculation, batching, intelligent scheduling, and
 * enterprise-grade user preference management.
 *
 * Features:
 * - Category-based notification control
 * - Per-channel preferences (push/email/sms)
 * - Frequency control (instant/hourly/daily/weekly)
 * - Quiet hours with timezone support
 * - Do Not Disturb mode
 * - Digest batching
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeNotification } from "./delivery-router.ts";
import { calculatePriority } from "./priority-calculator.ts";
import { BatchSender } from "./batch-sender.ts";
import {
  shouldSendNotification as checkPreferences,
  mapTypeToCategory,
  shouldBypassPreferences,
  type NotificationCategory,
  type ShouldSendResult,
} from "../_shared/notification-preferences.ts";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Notification types
export type NotificationType =
  | "new_message"
  | "listing_favorited"
  | "listing_expired"
  | "arrangement_confirmed"
  | "arrangement_cancelled"
  | "arrangement_completed"
  | "challenge_complete"
  | "challenge_reminder"
  | "review_received"
  | "review_reminder"
  | "system_announcement"
  | "moderation_warning"
  | "account_security";

// Priority levels
export type PriorityLevel = "critical" | "high" | "normal" | "low";

// Notification payload
export interface NotificationPayload {
  id?: string;
  type: NotificationType;
  userId: string;
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
  priority?: PriorityLevel;
  sound?: string;
  badge?: number;
  ttl?: number; // Time to live in seconds
  collapseKey?: string;
  channelId?: string; // Android notification channel
  category?: string; // iOS notification category
  threadId?: string; // iOS thread for grouping
  scheduledFor?: string; // ISO timestamp for scheduled delivery
}

// Delivery result
export interface DeliveryResult {
  success: boolean;
  notificationId: string;
  deliveredTo: string[];
  failedDevices: string[];
  scheduledFor?: string;
  error?: string;
}

// Initialize batch sender
const batchSender = new BatchSender();

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.replace("/unified-notifications", "");

    // Route handling
    if (req.method === "POST" && path === "/send") {
      return await handleSendNotification(req, supabase);
    }

    if (req.method === "POST" && path === "/send-batch") {
      return await handleBatchSend(req, supabase);
    }

    if (req.method === "POST" && path === "/schedule") {
      return await handleScheduleNotification(req, supabase);
    }

    if (req.method === "GET" && path === "/status") {
      return await handleGetStatus(req, supabase);
    }

    if (req.method === "POST" && path === "/cancel") {
      return await handleCancelNotification(req, supabase);
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Notification error:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to process notification",
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Send single notification
async function handleSendNotification(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const payload: NotificationPayload = await req.json();

  // Validate payload
  const validation = validatePayload(payload);
  if (!validation.valid) {
    return new Response(
      JSON.stringify({ error: { code: "VALIDATION_ERROR", message: validation.error } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Map notification type to category
  const category = mapTypeToCategory(payload.type) as NotificationCategory;
  const bypassPreferences = shouldBypassPreferences(payload.type) || payload.priority === "critical";

  // Check notification preferences using enterprise system
  const preferenceCheck = await checkPreferences(supabase, payload.userId, {
    category,
    channel: "push",
    bypassPreferences,
  });

  // Log preference check result
  logger.info("Notification preference check", {
    userId: payload.userId,
    type: payload.type,
    category,
    result: preferenceCheck,
  });

  // Handle blocked notifications
  if (!preferenceCheck.send) {
    // If there's a schedule time (quiet hours), queue for later
    if (preferenceCheck.scheduleFor) {
      await scheduleNotification(supabase, payload, preferenceCheck.scheduleFor);

      return new Response(
        JSON.stringify({
          success: true,
          scheduled: true,
          scheduledFor: preferenceCheck.scheduleFor,
          reason: preferenceCheck.reason || "quiet_hours",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Notification blocked entirely
    return new Response(
      JSON.stringify({
        success: false,
        blocked: true,
        reason: preferenceCheck.reason || "blocked_by_preferences",
        notificationId: payload.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Handle non-instant frequencies (queue for digest)
  if (preferenceCheck.frequency && preferenceCheck.frequency !== "instant") {
    await queueForDigest(supabase, payload, preferenceCheck.frequency);

    return new Response(
      JSON.stringify({
        success: true,
        queued: true,
        frequency: preferenceCheck.frequency,
        reason: `queued_for_${preferenceCheck.frequency}_digest`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get user devices for immediate delivery
  const devices = await getUserDevices(supabase, payload.userId);

  // Calculate priority
  const priority = payload.priority ?? calculatePriority(payload, null);

  // Route to appropriate delivery channels
  const result = await routeNotification(
    { ...payload, priority },
    devices,
    null
  );

  // Log delivery
  await logDelivery(supabase, payload, result);

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Send batch notifications
async function handleBatchSend(
  req: Request,
  supabase: any
): Promise<Response> {
  const { notifications }: { notifications: NotificationPayload[] } = await req.json();

  if (!Array.isArray(notifications) || notifications.length === 0) {
    return new Response(
      JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Invalid batch" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (notifications.length > 1000) {
    return new Response(
      JSON.stringify({ error: { code: "BATCH_TOO_LARGE", message: "Max 1000 notifications per batch" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Process in batches
  const results = await batchSender.sendBatch(notifications, supabase);

  // Log batch delivery
  await logBatchDelivery(supabase, notifications.length, results);

  return new Response(
    JSON.stringify({
      success: true,
      total: notifications.length,
      delivered: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Schedule notification for later
async function handleScheduleNotification(
  req: Request,
  supabase: any
): Promise<Response> {
  const { notification, scheduledFor }: { notification: NotificationPayload; scheduledFor: string } =
    await req.json();

  // Validate scheduled time
  const scheduledTime = new Date(scheduledFor);
  if (isNaN(scheduledTime.getTime()) || scheduledTime <= new Date()) {
    return new Response(
      JSON.stringify({ error: { code: "INVALID_SCHEDULE_TIME", message: "Invalid or past schedule time" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const notificationId = await scheduleNotification(supabase, notification, scheduledFor);

  return new Response(
    JSON.stringify({
      success: true,
      notificationId,
      scheduledFor,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Get notification status
async function handleGetStatus(
  req: Request,
  supabase: any
): Promise<Response> {
  const url = new URL(req.url);
  const notificationId = url.searchParams.get("id");

  if (!notificationId) {
    return new Response(
      JSON.stringify({ error: { code: "MISSING_ID", message: "Notification ID required" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase
    .from("notification_delivery_log")
    .select("*")
    .eq("notification_id", notificationId)
    .single();

  if (error) {
    return new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: "Notification not found" } }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify(data),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Cancel scheduled notification
async function handleCancelNotification(
  req: Request,
  supabase: any
): Promise<Response> {
  const { notificationId }: { notificationId: string } = await req.json();

  const { error } = await supabase
    .from("scheduled_notifications")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("status", "pending");

  if (error) {
    return new Response(
      JSON.stringify({ error: { code: "CANCEL_FAILED", message: "Could not cancel notification" } }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, notificationId }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// Helper functions
function validatePayload(payload: NotificationPayload): { valid: boolean; error?: string } {
  if (!payload.userId) return { valid: false, error: "userId is required" };
  if (!payload.type) return { valid: false, error: "type is required" };
  if (!payload.title) return { valid: false, error: "title is required" };
  if (!payload.body) return { valid: false, error: "body is required" };
  return { valid: true };
}

async function getUserDevices(supabase: ReturnType<typeof createClient>, userId: string) {
  const { data } = await supabase
    .from("device_tokens")
    .select("*")
    .eq("profile_id", userId)
    .eq("is_active", true);

  return data ?? [];
}

/**
 * Queue notification for digest delivery (hourly/daily/weekly)
 */
async function queueForDigest(
  supabase: ReturnType<typeof createClient>,
  payload: NotificationPayload,
  frequency: string
): Promise<void> {
  const now = new Date();
  let scheduledFor: Date;

  switch (frequency) {
    case "hourly":
      // Next hour
      scheduledFor = new Date(now);
      scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);
      break;
    case "daily":
      // Tomorrow at 9am UTC
      scheduledFor = new Date(now);
      scheduledFor.setDate(scheduledFor.getDate() + 1);
      scheduledFor.setHours(9, 0, 0, 0);
      break;
    case "weekly":
      // Next Monday at 9am UTC
      scheduledFor = new Date(now);
      const daysUntilMonday = (8 - scheduledFor.getDay()) % 7 || 7;
      scheduledFor.setDate(scheduledFor.getDate() + daysUntilMonday);
      scheduledFor.setHours(9, 0, 0, 0);
      break;
    default:
      scheduledFor = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour default
  }

  await supabase.from("notification_digest_queue").insert({
    user_id: payload.userId,
    notification_type: payload.type,
    category: mapTypeToCategory(payload.type),
    title: payload.title,
    body: payload.body,
    data: payload.data || {},
    frequency,
    scheduled_for: scheduledFor.toISOString(),
    created_at: now.toISOString(),
  });

  logger.info("Notification queued for digest", {
    userId: payload.userId,
    type: payload.type,
    frequency,
    scheduledFor: scheduledFor.toISOString(),
  });
}

async function scheduleNotification(
  supabase: any,
  payload: NotificationPayload,
  scheduledFor: string
): Promise<string> {
  const { data, error } = await supabase
    .from("scheduled_notifications")
    .insert({
      payload: payload,
      scheduled_for: scheduledFor,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

async function logDelivery(
  supabase: any,
  payload: NotificationPayload,
  result: DeliveryResult
): Promise<void> {
  await supabase.from("notification_delivery_log").insert({
    notification_id: payload.id ?? crypto.randomUUID(),
    user_id: payload.userId,
    type: payload.type,
    title: payload.title,
    status: result.success ? "delivered" : "failed",
    delivered_to: result.deliveredTo,
    failed_devices: result.failedDevices,
    error: result.error,
    delivered_at: result.success ? new Date().toISOString() : null,
  });
}

async function logBatchDelivery(
  supabase: any,
  totalCount: number,
  results: DeliveryResult[]
): Promise<void> {
  await supabase.from("notification_batch_log").insert({
    total_count: totalCount,
    delivered_count: results.filter((r) => r.success).length,
    failed_count: results.filter((r) => !r.success).length,
    processed_at: new Date().toISOString(),
  });
}

export { NotificationPayload, DeliveryResult, NotificationType, PriorityLevel };
