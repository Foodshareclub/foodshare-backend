/**
 * Send Digest Notifications
 *
 * Processes queued digest notifications and sends batched summaries.
 * Supports hourly, daily, and weekly digest frequencies.
 *
 * Endpoints:
 * - POST / - Process digest notifications for a specific frequency
 * - GET /health - Health check
 *
 * Request body:
 * {
 *   "frequency": "hourly" | "daily" | "weekly",
 *   "limit": 100,  // Optional, max users to process
 *   "dryRun": false // Optional, preview without sending
 * }
 *
 * Called by cron jobs:
 * - Hourly: Every hour at :00
 * - Daily: Every day at 9am UTC
 * - Weekly: Every Monday at 9am UTC
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

const VERSION = "1.0.0";
const SERVICE = "send-digest-notifications";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface DigestRequest {
  frequency: "hourly" | "daily" | "weekly";
  limit?: number;
  dryRun?: boolean;
}

interface DigestItem {
  id: string;
  type: string;
  category: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: string;
}

interface UserDigest {
  user_id: string;
  items: DigestItem[];
  item_count: number;
}

interface DigestResult {
  success: boolean;
  frequency: string;
  usersProcessed: number;
  notificationsSent: number;
  notificationsFailed: number;
  emailsSent: number;
  emailsFailed: number;
  errors: string[];
  dryRun: boolean;
  durationMs: number;
}

function getServiceRoleClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Create a summary notification title based on digest contents
 */
function createDigestTitle(items: DigestItem[], frequency: string): string {
  const categoryNames: Record<string, string> = {
    posts: "listings",
    forum: "forum posts",
    challenges: "challenge updates",
    comments: "comments",
    chats: "messages",
    social: "social updates",
    system: "system alerts",
    marketing: "updates",
  };

  // Group by category
  const categoryCounts: Record<string, number> = {};
  for (const item of items) {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
  }

  const categories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);

  if (categories.length === 1) {
    const [category, count] = categories[0];
    const name = categoryNames[category] || "notifications";
    return `${count} new ${name}`;
  }

  const total = items.length;
  const frequencyLabel = frequency === "hourly" ? "this hour" : frequency === "daily" ? "today" : "this week";
  return `${total} notifications ${frequencyLabel}`;
}

/**
 * Create a summary notification body based on digest contents
 */
function createDigestBody(items: DigestItem[]): string {
  // Take first 3 items for preview
  const previews = items.slice(0, 3).map((item) => `• ${item.title}`);

  if (items.length > 3) {
    previews.push(`...and ${items.length - 3} more`);
  }

  return previews.join("\n");
}

/**
 * Send push notification via unified-notifications
 */
async function sendDigestPushNotification(
  userId: string,
  items: DigestItem[],
  frequency: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const title = createDigestTitle(items, frequency);
    const body = createDigestBody(items);

    // Call unified-notifications endpoint
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/unified-notifications/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          type: "digest",
          title,
          body,
          data: {
            type: "digest",
            frequency,
            itemCount: String(items.length),
            categories: [...new Set(items.map((i) => i.category))].join(","),
          },
          priority: "normal",
          collapseKey: `digest-${frequency}`,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send digest email via send-email-notification
 */
async function sendDigestEmail(
  userId: string,
  items: DigestItem[],
  frequency: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/send-email-notification/digest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          frequency,
          items: items.map((item) => ({
            type: item.type,
            category: item.category,
            title: item.title,
            body: item.body,
            data: item.data,
            created_at: item.created_at,
          })),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const result = await response.json();
    return { success: result.sent === true, error: result.error };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Process digest notifications for a given frequency
 */
async function processDigest(
  supabase: SupabaseClient,
  request: DigestRequest
): Promise<DigestResult> {
  const startTime = performance.now();
  const { frequency, limit = 100, dryRun = false } = request;

  const result: DigestResult = {
    success: true,
    frequency,
    usersProcessed: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    emailsSent: 0,
    emailsFailed: 0,
    errors: [],
    dryRun,
    durationMs: 0,
  };

  try {
    // Fetch pending digest notifications grouped by user
    const { data: userDigests, error: fetchError } = await supabase.rpc(
      "get_pending_digest_notifications",
      {
        p_frequency: frequency,
        p_limit: limit,
      }
    );

    if (fetchError) {
      result.success = false;
      result.errors.push(`Failed to fetch pending notifications: ${fetchError.message}`);
      result.durationMs = Math.round(performance.now() - startTime);
      return result;
    }

    if (!userDigests || userDigests.length === 0) {
      logger.info("No pending digest notifications", { frequency });
      result.durationMs = Math.round(performance.now() - startTime);
      return result;
    }

    logger.info("Processing digest notifications", {
      frequency,
      userCount: userDigests.length,
      dryRun,
    });

    // Process each user's digest
    const allNotificationIds: string[] = [];

    for (const userDigest of userDigests as UserDigest[]) {
      result.usersProcessed++;

      const items = userDigest.items as DigestItem[];
      const notificationIds = items.map((item) => item.id);
      allNotificationIds.push(...notificationIds);

      if (dryRun) {
        logger.info("Dry run: would send digest", {
          userId: userDigest.user_id,
          itemCount: items.length,
          title: createDigestTitle(items, frequency),
        });
        result.notificationsSent++;
        continue;
      }

      // Send push notification
      const sendResult = await sendDigestPushNotification(
        userDigest.user_id,
        items,
        frequency
      );

      if (sendResult.success) {
        result.notificationsSent++;
      } else {
        result.notificationsFailed++;
        result.errors.push(
          `Failed to send push digest to ${userDigest.user_id}: ${sendResult.error}`
        );
      }

      // Send email digest (for daily and weekly only, as hourly would be too frequent)
      if (frequency !== "hourly") {
        const emailResult = await sendDigestEmail(
          userDigest.user_id,
          items,
          frequency
        );

        if (emailResult.success) {
          result.emailsSent++;
        } else {
          result.emailsFailed++;
          // Don't add to errors as email is optional, just log
          logger.warn("Digest email failed", {
            userId: userDigest.user_id,
            error: emailResult.error,
          });
        }
      }
    }

    // Mark notifications as sent (unless dry run)
    if (!dryRun && allNotificationIds.length > 0) {
      const { error: markError } = await supabase.rpc(
        "mark_digest_notifications_sent",
        { p_notification_ids: allNotificationIds }
      );

      if (markError) {
        result.errors.push(`Failed to mark notifications as sent: ${markError.message}`);
      }
    }

    result.durationMs = Math.round(performance.now() - startTime);

    logger.info("Digest processing complete", {
      frequency,
      usersProcessed: result.usersProcessed,
      notificationsSent: result.notificationsSent,
      notificationsFailed: result.notificationsFailed,
      emailsSent: result.emailsSent,
      emailsFailed: result.emailsFailed,
      durationMs: result.durationMs,
    });

    return result;
  } catch (error) {
    result.success = false;
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.durationMs = Math.round(performance.now() - startTime);

    logger.error("Digest processing failed", error as Error);
    return result;
  }
}

/**
 * Handle digest request
 */
async function handleDigestRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  const startTime = performance.now();

  try {
    const body: DigestRequest = await req.json();

    // Validate frequency
    if (!body.frequency || !["hourly", "daily", "weekly"].includes(body.frequency)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid frequency. Must be: hourly, daily, or weekly",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = getServiceRoleClient();
    const result = await processDigest(supabase, body);

    return new Response(
      JSON.stringify({
        ...result,
        service: SERVICE,
        version: VERSION,
        timestamp: new Date().toISOString(),
      }),
      {
        status: result.success ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Digest request failed", err);

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        service: SERVICE,
        version: VERSION,
        durationMs: Math.round(performance.now() - startTime),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Handle health check
 */
function handleHealth(req: Request): Response {
  const corsHeaders = getCorsHeaders(req);

  return new Response(
    JSON.stringify({
      status: "healthy",
      service: SERVICE,
      version: VERSION,
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

/**
 * Main handler
 */
Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  // Health check
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    return handleHealth(req);
  }

  // Process digest (POST only)
  if (req.method === "POST") {
    return handleDigestRequest(req);
  }

  const corsHeaders = getCorsHeaders(req);
  return new Response(
    JSON.stringify({ error: "Method not allowed" }),
    {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
