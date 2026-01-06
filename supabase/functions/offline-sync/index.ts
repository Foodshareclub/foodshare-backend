import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EnqueueRequest {
  operation_type: string;
  entity_type: string;
  entity_id?: string;
  payload: Record<string, unknown>;
  device_id: string;
  depends_on?: string[];
  priority?: number;
}

interface OptimisticRequest {
  entity_type: string;
  entity_id: string;
  previous_state: Record<string, unknown>;
  optimistic_state: Record<string, unknown>;
  device_id: string;
}

interface RealtimeSubscribeRequest {
  channel_name: string;
  channel_type: "chat" | "notifications" | "listings" | "presence" | "broadcast";
  device_id: string;
  platform: "ios" | "android" | "web";
  filter_params?: Record<string, unknown>;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();

    // =====================================================
    // OFFLINE QUEUE OPERATIONS (Phase 9)
    // =====================================================

    // POST /offline-sync/enqueue - Add operation to offline queue
    if (path === "enqueue" && req.method === "POST") {
      const body: EnqueueRequest = await req.json();

      const { data, error } = await supabaseClient.rpc("enqueue_operation", {
        p_operation_type: body.operation_type,
        p_entity_type: body.entity_type,
        p_payload: body.payload,
        p_device_id: body.device_id,
        p_entity_id: body.entity_id,
        p_depends_on: body.depends_on,
        p_priority: body.priority || 0,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ operation_id: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /offline-sync/pending - Get pending operations
    if (path === "pending" && req.method === "GET") {
      const deviceId = url.searchParams.get("device_id") || "";
      const limit = parseInt(url.searchParams.get("limit") || "50");

      const { data, error } = await supabaseClient.rpc("get_pending_operations", {
        p_device_id: deviceId,
        p_limit: limit,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ operations: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/complete - Mark operation completed
    if (path === "complete" && req.method === "POST") {
      const body = await req.json();
      const { operation_id, result } = body;

      const { data, error } = await supabaseClient.rpc("complete_operation", {
        p_operation_id: operation_id,
        p_result: result,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/replay - Replay all pending operations
    if (path === "replay" && req.method === "POST") {
      const body = await req.json();
      const { device_id } = body;

      const { data, error } = await supabaseClient.rpc("replay_operations", {
        p_device_id: device_id,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ operations: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/process - Process queued operations
    if (path === "process" && req.method === "POST") {
      const body = await req.json();
      const { device_id } = body;

      // Get pending operations
      const { data: operations, error: fetchError } = await supabaseClient.rpc("get_pending_operations", {
        p_device_id: device_id,
        p_limit: 20,
      });

      if (fetchError) throw fetchError;

      const results: Array<{ operation_id: string; success: boolean; error?: string }> = [];

      for (const op of operations || []) {
        try {
          await processOperation(supabaseClient, user.id, op);
          await supabaseClient.rpc("complete_operation", {
            p_operation_id: op.id,
            p_result: { processed_at: new Date().toISOString() },
          });
          results.push({ operation_id: op.id, success: true });
        } catch (error) {
          results.push({ operation_id: op.id, success: false, error: error.message });
        }
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =====================================================
    // OPTIMISTIC UPDATE OPERATIONS (Phase 10)
    // =====================================================

    // POST /offline-sync/optimistic/create - Create optimistic update
    if (path === "optimistic-create" && req.method === "POST") {
      const body: OptimisticRequest = await req.json();

      const { data, error } = await supabaseClient.rpc("create_optimistic_update", {
        p_entity_type: body.entity_type,
        p_entity_id: body.entity_id,
        p_previous_state: body.previous_state,
        p_optimistic_state: body.optimistic_state,
        p_device_id: body.device_id,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ update_id: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/optimistic/commit - Commit optimistic update
    if (path === "optimistic-commit" && req.method === "POST") {
      const body = await req.json();
      const { update_id, committed_state } = body;

      const { data, error } = await supabaseClient.rpc("commit_optimistic_update", {
        p_update_id: update_id,
        p_committed_state: committed_state,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/optimistic/rollback - Rollback optimistic update
    if (path === "optimistic-rollback" && req.method === "POST") {
      const body = await req.json();
      const { update_id } = body;

      const { data, error } = await supabaseClient.rpc("rollback_optimistic_update", {
        p_update_id: update_id,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ previous_state: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /offline-sync/optimistic/pending - Get pending optimistic updates
    if (path === "optimistic-pending" && req.method === "GET") {
      const { data, error } = await supabaseClient
        .from("optimistic_updates")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      if (error) throw error;

      return new Response(JSON.stringify({ updates: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =====================================================
    // REALTIME SUBSCRIPTION OPERATIONS (Phase 11)
    // =====================================================

    // POST /offline-sync/realtime/subscribe - Subscribe to channel
    if (path === "realtime-subscribe" && req.method === "POST") {
      const body: RealtimeSubscribeRequest = await req.json();

      const { data, error } = await supabaseClient.rpc("subscribe_realtime_channel", {
        p_channel_name: body.channel_name,
        p_channel_type: body.channel_type,
        p_device_id: body.device_id,
        p_platform: body.platform,
        p_filter_params: body.filter_params || {},
      });

      if (error) throw error;

      return new Response(JSON.stringify({ subscription: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/realtime/unsubscribe - Unsubscribe from channel
    if (path === "realtime-unsubscribe" && req.method === "POST") {
      const body = await req.json();
      const { channel_name, device_id } = body;

      const { error } = await supabaseClient
        .from("realtime_subscriptions")
        .update({ status: "inactive", updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("device_id", device_id)
        .eq("channel_name", channel_name);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/realtime/check-duplicate - Check message duplicate
    if (path === "realtime-check-duplicate" && req.method === "POST") {
      const body = await req.json();
      const { message_id, channel_name, message_type, payload_hash } = body;

      const { data, error } = await supabaseClient.rpc("check_message_duplicate", {
        p_message_id: message_id,
        p_channel_name: channel_name,
        p_message_type: message_type,
        p_payload_hash: payload_hash,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ is_duplicate: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /offline-sync/realtime/missed - Get missed messages
    if (path === "realtime-missed" && req.method === "GET") {
      const channelName = url.searchParams.get("channel") || "";
      const lastMessageId = url.searchParams.get("last_message_id") || "";
      const deviceId = url.searchParams.get("device_id") || "";

      const { data, error } = await supabaseClient.rpc("get_missed_messages", {
        p_channel_name: channelName,
        p_last_message_id: lastMessageId,
        p_device_id: deviceId,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ messages: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /offline-sync/realtime/ping - Update subscription heartbeat
    if (path === "realtime-ping" && req.method === "POST") {
      const body = await req.json();
      const { device_id, channels } = body;

      const { error } = await supabaseClient
        .from("realtime_subscriptions")
        .update({ last_ping_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("device_id", device_id)
        .in("channel_name", channels);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /offline-sync/realtime/subscriptions - Get active subscriptions
    if (path === "realtime-subscriptions" && req.method === "GET") {
      const deviceId = url.searchParams.get("device_id");

      let query = supabaseClient
        .from("realtime_subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "active");

      if (deviceId) {
        query = query.eq("device_id", deviceId);
      }

      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) throw error;

      return new Response(JSON.stringify({ subscriptions: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Process individual operation
async function processOperation(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  operation: {
    id: string;
    operation_type: string;
    entity_type: string;
    entity_id?: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  const { operation_type, entity_type, entity_id, payload } = operation;

  switch (operation_type) {
    case "create_listing":
      await supabase.from("posts").insert({ ...payload, user_id: userId });
      break;

    case "update_listing":
      await supabase.from("posts").update(payload).eq("id", entity_id).eq("user_id", userId);
      break;

    case "delete_listing":
      await supabase.from("posts").delete().eq("id", entity_id).eq("user_id", userId);
      break;

    case "send_message":
      await supabase.from("messages").insert({ ...payload, sender_id: userId });
      break;

    case "update_profile":
      await supabase.from("profiles").update(payload).eq("id", userId);
      break;

    case "create_review":
      await supabase.from("reviews").insert({ ...payload, author_id: userId });
      break;

    case "toggle_favorite":
      const { listing_id, is_favorite } = payload as { listing_id: string; is_favorite: boolean };
      if (is_favorite) {
        await supabase.from("favorites").insert({ user_id: userId, listing_id });
      } else {
        await supabase.from("favorites").delete().eq("user_id", userId).eq("listing_id", listing_id);
      }
      break;

    case "create_forum_post":
      await supabase.from("forum_posts").insert({ ...payload, author_id: userId });
      break;

    case "create_forum_comment":
      await supabase.from("forum_comments").insert({ ...payload, author_id: userId });
      break;

    default:
      throw new Error(`Unknown operation type: ${operation_type}`);
  }
}
