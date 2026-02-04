/**
 * Handlers Export
 *
 * Centralized export for all notification API handlers.
 *
 * @module api-v1-notifications/handlers
 */

export * from "./send.ts";

// Export placeholder implementations for other handlers
// These can be expanded as needed

import type { NotificationContext } from "../types.ts";
import { logger } from "../../../_shared/logger.ts";

/**
 * GET /health - Health check
 */
export async function handleHealth(
  context: NotificationContext
): Promise<{ status: string; version: string; timestamp: string }> {
  return {
    status: "healthy",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  };
}

/**
 * GET /stats - Statistics
 */
export async function handleStats(
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const { data, error } = await context.supabase
      .from("notification_delivery_log")
      .select("status", { count: "exact" })
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      data: {
        last24Hours: {
          total: data?.length || 0,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * GET /preferences - Get user preferences
 */
export async function handleGetPreferences(
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  if (!context.userId) {
    return { success: false, error: "User ID required" };
  }

  try {
    const { data, error } = await context.supabase.rpc("get_notification_preferences", {
      p_user_id: context.userId,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * PUT /preferences - Update user preferences
 */
export async function handleUpdatePreferences(
  body: unknown,
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  if (!context.userId) {
    return { success: false, error: "User ID required" };
  }

  try {
    const { data, error } = await context.supabase.rpc("update_notification_settings", {
      p_user_id: context.userId,
      p_settings: body,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * POST /preferences/dnd - Enable Do Not Disturb
 */
export async function handleEnableDnd(
  body: unknown,
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  if (!context.userId) {
    return { success: false, error: "User ID required" };
  }

  try {
    const { duration_hours = 8 } = (body as { duration_hours?: number }) || {};
    const until = new Date(Date.now() + duration_hours * 60 * 60 * 1000);

    const { data, error } = await context.supabase.rpc("update_notification_settings", {
      p_user_id: context.userId,
      p_settings: {
        dnd: {
          enabled: true,
          until: until.toISOString(),
        },
      },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: { dnd_enabled: true, dnd_until: until.toISOString() } };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * DELETE /preferences/dnd - Disable Do Not Disturb
 */
export async function handleDisableDnd(
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  if (!context.userId) {
    return { success: false, error: "User ID required" };
  }

  try {
    const { data, error } = await context.supabase.rpc("update_notification_settings", {
      p_user_id: context.userId,
      p_settings: {
        dnd: {
          enabled: false,
          until: null,
        },
      },
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: { dnd_enabled: false } };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * POST /webhook/:provider - Handle provider webhook
 */
export async function handleWebhook(
  provider: string,
  body: unknown,
  context: NotificationContext
): Promise<{
  success: boolean;
  message?: string;
}> {
  logger.info("Webhook received", {
    requestId: context.requestId,
    provider,
  });

  // TODO: Process webhook events (delivery status, bounces, etc.)
  // This would update notification_delivery_log with delivery status

  return {
    success: true,
    message: "Webhook processed",
  };
}

/**
 * POST /digest/process - Process digest notifications (cron)
 */
export async function handleDigestProcess(
  body: unknown,
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  const startTime = performance.now();

  try {
    const { frequency = "daily", limit = 100, dryRun = false } = (body as {
      frequency?: string;
      limit?: number;
      dryRun?: boolean;
    }) || {};

    logger.info("Processing digest notifications", {
      requestId: context.requestId,
      frequency,
      limit,
      dryRun,
    });

    // Fetch pending digest notifications grouped by user
    const { data: userDigests, error: fetchError } = await context.supabase.rpc(
      "get_pending_digest_notifications",
      {
        p_frequency: frequency,
        p_limit: limit,
      }
    );

    if (fetchError) {
      logger.error("Failed to fetch digest notifications", new Error(fetchError.message));
      return {
        success: false,
        error: `Failed to fetch pending notifications: ${fetchError.message}`,
      };
    }

    if (!userDigests || userDigests.length === 0) {
      logger.info("No pending digest notifications", { frequency });
      return {
        success: true,
        data: {
          frequency,
          usersProcessed: 0,
          notificationsSent: 0,
          emailsSent: 0,
          pushSent: 0,
          dryRun,
          durationMs: Math.round(performance.now() - startTime),
        },
      };
    }

    let usersProcessed = 0;
    let emailsSent = 0;
    let emailsFailed = 0;
    let pushSent = 0;
    let pushFailed = 0;
    const allNotificationIds: string[] = [];
    const errors: string[] = [];

    // Process each user's digest
    for (const userDigest of userDigests) {
      usersProcessed++;
      const items = userDigest.items || [];
      const notificationIds = items.map((item: { id: string }) => item.id);
      allNotificationIds.push(...notificationIds);

      if (dryRun) {
        logger.info("Dry run: would send digest", {
          userId: userDigest.user_id,
          itemCount: items.length,
        });
        continue;
      }

      // Send email digest (for daily and weekly only)
      if (frequency !== "hourly") {
        try {
          const { sendToChannel } = await import("../orchestrator.ts");
          const emailResult = await sendToChannel("email", {
            userId: userDigest.user_id,
            type: "digest",
            title: createDigestTitle(items, frequency),
            body: createDigestBody(items),
            data: {
              frequency,
              itemCount: String(items.length),
            },
          }, context);

          if (emailResult.success) {
            emailsSent++;
          } else {
            emailsFailed++;
          }
        } catch (e) {
          emailsFailed++;
          errors.push(`Email failed for ${userDigest.user_id}: ${(e as Error).message}`);
        }
      }

      // Send push notification
      try {
        const { sendToChannel } = await import("../orchestrator.ts");
        const pushResult = await sendToChannel("push", {
          userId: userDigest.user_id,
          type: "digest",
          title: createDigestTitle(items, frequency),
          body: createDigestBody(items),
          data: {
            type: "digest",
            frequency,
            itemCount: String(items.length),
          },
          collapseKey: `digest-${frequency}`,
        }, context);

        if (pushResult.success) {
          pushSent++;
        } else {
          pushFailed++;
        }
      } catch (e) {
        pushFailed++;
      }
    }

    // Mark notifications as sent (unless dry run)
    if (!dryRun && allNotificationIds.length > 0) {
      const { error: markError } = await context.supabase.rpc(
        "mark_digest_notifications_sent",
        { p_notification_ids: allNotificationIds }
      );

      if (markError) {
        errors.push(`Failed to mark notifications as sent: ${markError.message}`);
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    logger.info("Digest processing complete", {
      frequency,
      usersProcessed,
      emailsSent,
      emailsFailed,
      pushSent,
      pushFailed,
      durationMs,
    });

    return {
      success: true,
      data: {
        frequency,
        usersProcessed,
        notificationsSent: emailsSent + pushSent,
        emailsSent,
        emailsFailed,
        pushSent,
        pushFailed,
        errors: errors.length > 0 ? errors : undefined,
        dryRun,
        durationMs,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

// Helper functions for digest
function createDigestTitle(items: Array<{ category?: string }>, frequency: string): string {
  const categoryNames: Record<string, string> = {
    posts: "listings",
    forum: "forum posts",
    challenges: "challenge updates",
    comments: "comments",
    chats: "messages",
    social: "social updates",
    system: "system alerts",
  };

  const categoryCounts: Record<string, number> = {};
  for (const item of items) {
    const cat = item.category || "notifications";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
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

function createDigestBody(items: Array<{ title?: string }>): string {
  const previews = items.slice(0, 3).map((item) => `• ${item.title || "New notification"}`);
  if (items.length > 3) {
    previews.push(`...and ${items.length - 3} more`);
  }
  return previews.join("\n");
}

/**
 * GET /dashboard - Dashboard statistics
 */
export async function handleDashboard(
  context: NotificationContext
): Promise<{
  success: boolean;
  data?: unknown;
  error?: string;
}> {
  try {
    // Get last 24h statistics
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await context.supabase
      .from("notification_delivery_log")
      .select("status, channels")
      .gte("created_at", since);

    if (error) {
      return { success: false, error: error.message };
    }

    const stats = {
      period: "24h",
      total: data?.length || 0,
      delivered: data?.filter((d) => d.status === "delivered").length || 0,
      failed: data?.filter((d) => d.status === "failed").length || 0,
    };

    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
