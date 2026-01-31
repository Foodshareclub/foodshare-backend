/**
 * Track Event Edge Function
 *
 * Records user behavior events for personalization and analytics.
 * Fire-and-forget design for minimal client impact.
 *
 * Endpoints:
 * - POST /track-event - Record a single event
 * - POST /track-event/batch - Record multiple events
 *
 * Event types:
 * - listing_view: User viewed a listing
 * - search: User performed a search
 * - share_complete: User completed sharing food
 * - message_sent: User sent a message
 * - feed_scroll: User scrolled through feed
 * - save: User saved a listing
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Valid Event Types
// =============================================================================

const VALID_EVENT_TYPES = [
  "listing_view",
  "search",
  "share_complete",
  "message_sent",
  "feed_scroll",
  "save",
  "profile_view",
  "category_browse",
  "notification_opened",
  "app_open",
  "app_background",
] as const;

// =============================================================================
// Request Schemas
// =============================================================================

const singleEventSchema = z.object({
  eventType: z.enum(VALID_EVENT_TYPES),
  data: z.record(z.unknown()).optional(),
  timestamp: z.string().datetime().optional(),
});

const batchEventSchema = z.object({
  events: z.array(z.object({
    eventType: z.string(), // Validate individually for better error handling
    data: z.record(z.unknown()).optional(),
    timestamp: z.string().datetime().optional(),
  })).max(50, "Maximum 50 events per batch"),
});

type SingleEventRequest = z.infer<typeof singleEventSchema>;
type BatchEventRequest = z.infer<typeof batchEventSchema>;

// =============================================================================
// Activity Type Mapping
// =============================================================================

function mapEventToActivityType(eventType: string): string {
  const mapping: Record<string, string> = {
    listing_view: "view",
    search: "search",
    share_complete: "share_complete",
    message_sent: "message",
    feed_scroll: "view",
    save: "save",
    profile_view: "view",
    category_browse: "view",
    notification_opened: "view",
    app_open: "view",
    app_background: "view",
  };

  return mapping[eventType] || "view";
}

// =============================================================================
// Insert User Event Helper
// =============================================================================

async function insertUserEvent(
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>,
  userId: string,
  eventType: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from("user_events").insert({
      user_id: userId,
      event_type: eventType,
      event_data: data || {},
      created_at: new Date().toISOString(),
    });
  } catch {
    // Ignore errors - user_events table might not exist yet
    // This is a non-critical operation
  }
}

// =============================================================================
// Route Detection
// =============================================================================

function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const idx = pathname.indexOf("/track-event");
  if (idx === -1) return "";
  const subPath = pathname.slice(idx + 12); // Remove "/track-event"
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleTrackEvent(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId, request, ctx: requestCtx } = ctx;
  const url = new URL(request.url);
  const subPath = getSubPath(url);

  // Route to batch handler if needed
  if (subPath === "batch" || subPath === "batch/") {
    return handleBatchEvents(ctx);
  }

  // Parse and validate single event
  let body: SingleEventRequest;
  try {
    const rawBody = await request.json();
    const parsed = singleEventSchema.safeParse(rawBody);

    if (!parsed.success) {
      // Fire-and-forget: return success even on validation error
      logger.warn("Invalid event data", {
        eventType: rawBody?.eventType,
        userId: userId?.substring(0, 8),
        requestId: requestCtx?.requestId,
      });
      return ok({ tracked: false, reason: "invalid_event_data" }, ctx);
    }
    body = parsed.data;
  } catch {
    return ok({ tracked: false, reason: "invalid_json" }, ctx);
  }

  // Map event type to activity type
  const activityType = mapEventToActivityType(body.eventType);

  // Call the database function for activity tracking
  const { error } = await supabase.rpc("track_user_activity", {
    p_user_id: userId,
    p_activity_type: activityType,
    p_data: body.data || {},
  });

  if (error) {
    logger.error("Failed to track activity", {
      error: error.message,
      eventType: body.eventType,
      userId: userId?.substring(0, 8),
      requestId: requestCtx?.requestId,
    });
    // Return success anyway - fire and forget
    return ok({ tracked: false, reason: "database_error" }, ctx);
  }

  // Also insert into user_events table for detailed analytics
  await insertUserEvent(supabase, userId!, body.eventType, body.data);

  logger.info("Event tracked", {
    eventType: body.eventType,
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  return ok({ tracked: true, eventType: body.eventType }, ctx);
}

async function handleBatchEvents(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId, request, ctx: requestCtx } = ctx;

  // Parse batch request
  let body: BatchEventRequest;
  try {
    const rawBody = await request.json();
    const parsed = batchEventSchema.safeParse(rawBody);

    if (!parsed.success) {
      return ok({ tracked: 0, total: 0, reason: "invalid_batch_data" }, ctx);
    }
    body = parsed.data;
  } catch {
    return ok({ tracked: 0, total: 0, reason: "invalid_json" }, ctx);
  }

  if (!body.events || body.events.length === 0) {
    return ok({ tracked: 0, total: 0 }, ctx);
  }

  let trackedCount = 0;
  const errors: string[] = [];

  for (const event of body.events) {
    // Validate event type
    if (!VALID_EVENT_TYPES.includes(event.eventType as typeof VALID_EVENT_TYPES[number])) {
      errors.push(`Invalid event type: ${event.eventType}`);
      continue;
    }

    const activityType = mapEventToActivityType(event.eventType);

    const { error } = await supabase.rpc("track_user_activity", {
      p_user_id: userId,
      p_activity_type: activityType,
      p_data: event.data || {},
    });

    if (!error) {
      trackedCount++;
      // Insert to user_events for analytics
      await insertUserEvent(supabase, userId!, event.eventType, event.data);
    } else {
      errors.push(`Failed to track ${event.eventType}: ${error.message}`);
    }
  }

  logger.info("Batch events tracked", {
    tracked: trackedCount,
    total: body.events.length,
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  return ok({
    tracked: trackedCount,
    total: body.events.length,
    skipped: body.events.length - trackedCount,
  }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "track-event",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 100,
    windowMs: 60000, // 100 events per minute per user
    keyBy: "user",
  },
  routes: {
    POST: {
      handler: handleTrackEvent,
    },
  },
});
