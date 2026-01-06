/**
 * Unified Notification Delivery System
 *
 * Handles multi-platform notification delivery (FCM, APNs, Web Push)
 * with priority calculation, batching, and intelligent scheduling.
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeNotification } from "./delivery-router.ts";
import { calculatePriority } from "./priority-calculator.ts";
import { BatchSender } from "./batch-sender.ts";

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
  supabase: any
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

  // Get user preferences and devices
  const [preferences, devices] = await Promise.all([
    getUserPreferences(supabase, payload.userId),
    getUserDevices(supabase, payload.userId),
  ]);

  // Check if notification should be sent
  if (!shouldSendNotification(payload, preferences)) {
    return new Response(
      JSON.stringify({
        success: false,
        reason: "blocked_by_preferences",
        notificationId: payload.id,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Calculate priority
  const priority = payload.priority ?? calculatePriority(payload, preferences);

  // Check quiet hours
  const quietHoursCheck = checkQuietHours(preferences);
  if (quietHoursCheck.isInQuietHours && priority !== "critical") {
    // Schedule for after quiet hours
    const scheduledFor = quietHoursCheck.endsAt;
    await scheduleNotification(supabase, { ...payload, priority }, scheduledFor);

    return new Response(
      JSON.stringify({
        success: true,
        scheduled: true,
        scheduledFor,
        reason: "quiet_hours",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Route to appropriate delivery channels
  const result = await routeNotification(
    { ...payload, priority },
    devices,
    preferences
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

async function getUserPreferences(supabase: any, userId: string) {
  const { data } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .single();

  return data ?? getDefaultPreferences();
}

function getDefaultPreferences() {
  return {
    push_enabled: true,
    email_enabled: true,
    sms_enabled: false,
    quiet_hours_enabled: false,
    quiet_hours_start: "22:00",
    quiet_hours_end: "08:00",
    enabled_types: [
      "new_message",
      "arrangement_confirmed",
      "arrangement_cancelled",
      "challenge_complete",
      "review_received",
      "system_announcement",
      "account_security",
    ],
  };
}

async function getUserDevices(supabase: any, userId: string) {
  const { data } = await supabase
    .from("user_devices")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true);

  return data ?? [];
}

function shouldSendNotification(
  payload: NotificationPayload,
  preferences: any
): boolean {
  // Always send critical notifications
  if (payload.priority === "critical") return true;

  // Check if push is enabled
  if (!preferences.push_enabled) return false;

  // Check if notification type is enabled
  if (
    preferences.enabled_types &&
    !preferences.enabled_types.includes(payload.type)
  ) {
    return false;
  }

  return true;
}

function checkQuietHours(preferences: any): { isInQuietHours: boolean; endsAt?: string } {
  if (!preferences.quiet_hours_enabled) {
    return { isInQuietHours: false };
  }

  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2, "0")}:${now
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;

  const start = preferences.quiet_hours_start;
  const end = preferences.quiet_hours_end;

  // Handle overnight quiet hours (e.g., 22:00 - 08:00)
  let isInQuietHours: boolean;
  if (start > end) {
    isInQuietHours = currentTime >= start || currentTime < end;
  } else {
    isInQuietHours = currentTime >= start && currentTime < end;
  }

  if (isInQuietHours) {
    // Calculate when quiet hours end
    const endsAt = new Date();
    const [endHour, endMin] = end.split(":").map(Number);
    endsAt.setHours(endHour, endMin, 0, 0);
    if (endsAt <= now) {
      endsAt.setDate(endsAt.getDate() + 1);
    }
    return { isInQuietHours: true, endsAt: endsAt.toISOString() };
  }

  return { isInQuietHours: false };
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
