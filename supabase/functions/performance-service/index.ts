import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface MetricBatch {
  metrics: Array<{
    name: string;
    type: "timing" | "count" | "gauge" | "histogram";
    value: number;
    unit?: string;
    screen_name?: string;
    tags?: Record<string, string>;
  }>;
  platform: "ios" | "android" | "web";
  app_version: string;
  device_type?: string;
}

interface NavigationEvent {
  from_screen: string;
  to_screen: string;
  time_ms?: number;
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

    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();

    // =====================================================
    // PERFORMANCE METRICS (Phase 15)
    // =====================================================

    // POST /performance-service/ingest - Batch ingest metrics
    if (path === "ingest" && req.method === "POST") {
      const body: MetricBatch = await req.json();
      const { metrics, platform, app_version, device_type } = body;

      const results: Array<{ name: string; success: boolean; alert?: string }> = [];

      for (const metric of metrics) {
        try {
          const { data, error } = await supabaseClient.rpc("ingest_performance_metric", {
            p_metric_name: metric.name,
            p_metric_type: metric.type,
            p_value: metric.value,
            p_platform: platform,
            p_app_version: app_version,
            p_screen_name: metric.screen_name,
            p_device_type: device_type,
            p_tags: metric.tags || {},
          });

          if (error) throw error;

          results.push({ name: metric.name, success: true });
        } catch (error) {
          results.push({ name: metric.name, success: false });
        }
      }

      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /performance-service/budgets - Get performance budgets
    if (path === "budgets" && req.method === "GET") {
      const platform = url.searchParams.get("platform");
      const screenName = url.searchParams.get("screen");

      let query = supabaseClient
        .from("performance_budgets")
        .select("*")
        .eq("enabled", true);

      if (platform) {
        query = query.or(`platform.is.null,platform.eq.${platform}`);
      }
      if (screenName) {
        query = query.or(`screen_name.is.null,screen_name.eq.${screenName}`);
      }

      const { data, error } = await query;
      if (error) throw error;

      return new Response(JSON.stringify({ budgets: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /performance-service/alerts - Get unacknowledged alerts
    if (path === "alerts" && req.method === "GET") {
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

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || !["admin", "moderator"].includes(profile.role)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data, error } = await supabaseClient
        .from("performance_alerts")
        .select("*")
        .eq("acknowledged", false)
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;

      return new Response(JSON.stringify({ alerts: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /performance-service/alerts/:id/acknowledge - Acknowledge alert
    if (path?.startsWith("acknowledge-") && req.method === "POST") {
      const alertId = path.replace("acknowledge-", "");
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

      const { error } = await supabaseClient
        .from("performance_alerts")
        .update({
          acknowledged: true,
          acknowledged_by: user.id,
          acknowledged_at: new Date().toISOString(),
        })
        .eq("id", alertId);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =====================================================
    // NAVIGATION & PREFETCH (Phase 14)
    // =====================================================

    // POST /performance-service/navigation - Record navigation
    if (path === "navigation" && req.method === "POST") {
      const body: NavigationEvent = await req.json();

      const { error } = await supabaseClient.rpc("record_navigation", {
        p_from_screen: body.from_screen,
        p_to_screen: body.to_screen,
        p_time_ms: body.time_ms,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /performance-service/prefetch-hints - Get prefetch hints
    if (path === "prefetch-hints" && req.method === "GET") {
      const screenName = url.searchParams.get("screen") || "";
      const platform = url.searchParams.get("platform") || "web";

      const { data, error } = await supabaseClient.rpc("get_prefetch_hints", {
        p_screen_name: screenName,
        p_platform: platform,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ hints: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // =====================================================
    // PAGINATION (Phase 13)
    // =====================================================

    // POST /performance-service/cursor - Create/update pagination cursor
    if (path === "cursor" && req.method === "POST") {
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

      const body = await req.json();
      const { device_id, resource_type, cursor_value, filter_hash, window_start, window_size, total_count } = body;

      const { data, error } = await supabaseClient
        .from("pagination_cursors")
        .upsert({
          user_id: user.id,
          device_id,
          resource_type,
          cursor_value,
          filter_hash,
          window_start: window_start || 0,
          window_size: window_size || 20,
          total_count,
          last_used_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
        }, {
          onConflict: "user_id,device_id,resource_type",
        })
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ cursor: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /performance-service/cursor - Get pagination cursor
    if (path === "cursor" && req.method === "GET") {
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

      const deviceId = url.searchParams.get("device_id") || "";
      const resourceType = url.searchParams.get("resource_type") || "";

      const { data, error } = await supabaseClient
        .from("pagination_cursors")
        .select("*")
        .eq("user_id", user.id)
        .eq("device_id", deviceId)
        .eq("resource_type", resourceType)
        .gt("expires_at", new Date().toISOString())
        .single();

      if (error && error.code !== "PGRST116") throw error;

      return new Response(JSON.stringify({ cursor: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /performance-service/summary - Get performance summary
    if (path === "summary" && req.method === "GET") {
      const platform = url.searchParams.get("platform");
      const days = parseInt(url.searchParams.get("days") || "7");
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      // Get key metrics
      const metrics = ["screen_load_time", "api_latency", "app_start_time", "memory_usage"];

      const summaries: Record<string, { avg: number; p50: number; p95: number; count: number }> = {};

      for (const metricName of metrics) {
        let query = supabaseClient
          .from("performance_metrics")
          .select("value")
          .eq("metric_name", metricName)
          .gte("recorded_at", startDate);

        if (platform) {
          query = query.eq("platform", platform);
        }

        const { data } = await query.limit(10000);

        if (data && data.length > 0) {
          const values = data.map((d) => d.value).sort((a, b) => a - b);
          const sum = values.reduce((a, b) => a + b, 0);
          const p50Index = Math.floor(values.length * 0.5);
          const p95Index = Math.floor(values.length * 0.95);

          summaries[metricName] = {
            avg: sum / values.length,
            p50: values[p50Index],
            p95: values[p95Index],
            count: values.length,
          };
        }
      }

      return new Response(JSON.stringify({ summaries, period_days: days }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /performance-service/budgets - Create performance budget (admin)
    if (path === "budgets" && req.method === "POST") {
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

      // Check admin role
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      if (!profile || profile.role !== "admin") {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await req.json();
      const { metric_name, screen_name, platform, warning_threshold, error_threshold, unit } = body;

      const { data, error } = await supabaseClient
        .from("performance_budgets")
        .upsert({
          metric_name,
          screen_name,
          platform,
          warning_threshold,
          error_threshold,
          unit,
        }, {
          onConflict: "metric_name,screen_name,platform",
        })
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ budget: data }), {
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
