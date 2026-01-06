/**
 * Cache Invalidation Edge Function
 *
 * Unified cache invalidation broadcast for Web, iOS, and Android.
 * Supports event creation, subscription management, and broadcast.
 *
 * Endpoints:
 *   POST /invalidate   - Create invalidation event and broadcast
 *   POST /subscribe    - Subscribe to invalidation events
 *   POST /unsubscribe  - Unsubscribe from events
 *   GET  /events       - Get recent invalidation events
 *   POST /cleanup      - Clean up expired events
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-platform",
};

// =============================================================================
// Types
// =============================================================================

interface InvalidateRequest {
  eventType: "create" | "update" | "delete" | "expire" | "refresh" | "bulk_update" | "relation_change" | "user_action";
  entityType: string;
  entityId?: string;
  cascadeInvalidation?: boolean;
  affectedKeys?: string[];
  metadata?: Record<string, unknown>;
}

interface SubscribeRequest {
  deviceId: string;
  platform: "ios" | "android" | "web";
  patterns: string[];
  entityTypes?: string[];
  pushToken?: string;
  websocketChannel?: string;
}

interface UnsubscribeRequest {
  deviceId: string;
  platform: "ios" | "android" | "web";
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.replace("/cache-invalidate", "");

    if (req.method === "POST" && path === "/invalidate") {
      return await handleInvalidate(req, supabase);
    }

    if (req.method === "POST" && path === "/subscribe") {
      return await handleSubscribe(req, supabase);
    }

    if (req.method === "POST" && path === "/unsubscribe") {
      return await handleUnsubscribe(req, supabase);
    }

    if (req.method === "GET" && path === "/events") {
      return await handleGetEvents(req, supabase);
    }

    if (req.method === "POST" && path === "/cleanup") {
      return await handleCleanup(supabase);
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "cache-invalidate" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Cache invalidation error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =============================================================================
// Handlers
// =============================================================================

async function handleInvalidate(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: InvalidateRequest = await req.json();
  const platform = req.headers.get("x-platform") || "server";

  if (!body.eventType || !body.entityType) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: eventType, entityType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Create invalidation event
  const { data, error } = await supabase.rpc("create_cache_invalidation_event", {
    p_event_type: body.eventType,
    p_entity_type: body.entityType,
    p_entity_id: body.entityId || null,
    p_cascade_invalidation: body.cascadeInvalidation ?? true,
    p_affected_keys: body.affectedKeys || [],
    p_source_platform: platform,
    p_metadata: body.metadata || {},
  });

  if (error) {
    console.error("Create invalidation error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0] || { event_id: null, patterns: [], subscriber_count: 0 };

  // Broadcast via Supabase Realtime
  if (result.patterns && result.patterns.length > 0) {
    await broadcastInvalidation(supabase, {
      eventId: result.event_id,
      eventType: body.eventType,
      entityType: body.entityType,
      entityId: body.entityId,
      patterns: result.patterns,
    });

    // Mark event as completed
    await supabase
      .from("cache_invalidation_events")
      .update({
        status: "completed",
        processed_at: new Date().toISOString(),
        broadcast_count: result.subscriber_count,
      })
      .eq("id", result.event_id);
  }

  return new Response(
    JSON.stringify({
      success: true,
      eventId: result.event_id,
      patterns: result.patterns,
      subscriberCount: result.subscriber_count,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleSubscribe(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: SubscribeRequest = await req.json();

  if (!body.deviceId || !body.platform || !body.patterns) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: deviceId, platform, patterns" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("subscribe_cache_invalidation", {
    p_device_id: body.deviceId,
    p_platform: body.platform,
    p_patterns: body.patterns,
    p_entity_types: body.entityTypes || [],
    p_push_token: body.pushToken || null,
    p_websocket_channel: body.websocketChannel || null,
  });

  if (error) {
    console.error("Subscribe error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      subscription: data,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleUnsubscribe(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: UnsubscribeRequest = await req.json();

  if (!body.deviceId || !body.platform) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: deviceId, platform" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { error } = await supabase.rpc("unsubscribe_cache_invalidation", {
    p_device_id: body.deviceId,
    p_platform: body.platform,
  });

  if (error) {
    console.error("Unsubscribe error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetEvents(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const deviceId = url.searchParams.get("deviceId");
  const platform = url.searchParams.get("platform");
  const since = url.searchParams.get("since");
  const limit = parseInt(url.searchParams.get("limit") ?? "100");

  if (!deviceId || !platform) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters: deviceId, platform" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("get_cache_invalidation_events", {
    p_device_id: deviceId,
    p_platform: platform,
    p_since: since || new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    p_limit: limit,
  });

  if (error) {
    console.error("Get events error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      events: data || [],
      count: data?.length || 0,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleCleanup(
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const { data, error } = await supabase.rpc("cleanup_cache_invalidation");

  if (error) {
    console.error("Cleanup error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0] || { events_deleted: 0, subscriptions_deactivated: 0 };

  return new Response(
    JSON.stringify({
      success: true,
      eventsDeleted: result.events_deleted,
      subscriptionsDeactivated: result.subscriptions_deactivated,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// Broadcast Helper
// =============================================================================

async function broadcastInvalidation(
  supabase: ReturnType<typeof createClient>,
  payload: {
    eventId: string;
    eventType: string;
    entityType: string;
    entityId?: string;
    patterns: string[];
  }
): Promise<void> {
  try {
    // Broadcast to Supabase Realtime channel
    const channel = supabase.channel("cache-invalidation");

    await channel.send({
      type: "broadcast",
      event: "invalidate",
      payload: {
        eventId: payload.eventId,
        eventType: payload.eventType,
        entityType: payload.entityType,
        entityId: payload.entityId,
        patterns: payload.patterns,
        timestamp: new Date().toISOString(),
      },
    });

    // Also broadcast entity-specific channels for targeted invalidation
    const entityChannel = supabase.channel(`cache:${payload.entityType}`);
    await entityChannel.send({
      type: "broadcast",
      event: "invalidate",
      payload: {
        eventId: payload.eventId,
        entityId: payload.entityId,
        patterns: payload.patterns.filter((p) => p.includes(payload.entityType)),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Broadcast error:", error);
  }
}
