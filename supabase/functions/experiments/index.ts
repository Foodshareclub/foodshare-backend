/**
 * Experiments Edge Function
 *
 * A/B testing and feature flag management for Web, iOS, and Android.
 *
 * Endpoints:
 *   GET  /assignment  - Get experiment assignment
 *   GET  /all         - Get all active experiments
 *   POST /track       - Track experiment event
 *   GET  /flags       - Get feature flags
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-platform, x-app-version",
};

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
    const path = url.pathname.replace("/experiments", "");
    const deviceId = req.headers.get("x-device-id") || url.searchParams.get("deviceId") || "unknown";
    const platform = req.headers.get("x-platform") || url.searchParams.get("platform") || "web";
    const appVersion = req.headers.get("x-app-version") || url.searchParams.get("appVersion");

    // Get user ID if authenticated
    let userId: string | null = null;
    const authHeader = req.headers.get("authorization");
    if (authHeader) {
      const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
      userId = user?.id || null;
    }

    if (req.method === "GET" && path === "/assignment") {
      const experimentKey = url.searchParams.get("key");
      if (!experimentKey) {
        return jsonResponse({ error: "Missing key parameter" }, 400);
      }

      const { data, error } = await supabase.rpc("get_experiment_assignment", {
        p_experiment_key: experimentKey,
        p_device_id: deviceId,
        p_user_id: userId,
        p_platform: platform,
        p_app_version: appVersion,
      });

      if (error) return jsonResponse({ error: error.message }, 500);

      const result = data?.[0];
      if (!result) {
        return jsonResponse({ inExperiment: false });
      }

      return jsonResponse({
        inExperiment: true,
        experimentId: result.experiment_id,
        variantKey: result.variant_key,
        isNewExposure: result.is_new_exposure,
        config: result.experiment_config,
      });
    }

    if (req.method === "GET" && path === "/all") {
      const { data, error } = await supabase.rpc("get_active_experiments", {
        p_device_id: deviceId,
        p_user_id: userId,
        p_platform: platform,
        p_app_version: appVersion,
      });

      if (error) return jsonResponse({ error: error.message }, 500);

      const experiments = (data || []).reduce((acc: Record<string, unknown>, exp: Record<string, unknown>) => {
        acc[exp.experiment_key as string] = {
          variantKey: exp.variant_key,
          config: exp.config,
        };
        return acc;
      }, {});

      return jsonResponse({ experiments, count: Object.keys(experiments).length });
    }

    if (req.method === "POST" && path === "/track") {
      const body = await req.json();

      if (!body.experimentKey || !body.eventName) {
        return jsonResponse({ error: "Missing experimentKey or eventName" }, 400);
      }

      const { data, error } = await supabase.rpc("track_experiment_event", {
        p_experiment_key: body.experimentKey,
        p_event_name: body.eventName,
        p_device_id: deviceId,
        p_event_value: body.eventValue || null,
        p_user_id: userId,
        p_platform: platform,
        p_properties: body.properties || {},
      });

      if (error) return jsonResponse({ error: error.message }, 500);

      return jsonResponse({ success: data === true });
    }

    if (req.method === "GET" && path === "/flags") {
      const keys = url.searchParams.get("keys")?.split(",") || [];

      if (keys.length === 0) {
        // Get all enabled flags
        const { data, error } = await supabase
          .from("feature_flags")
          .select("key, value_type, default_value, platform_overrides")
          .eq("enabled", true);

        if (error) return jsonResponse({ error: error.message }, 500);

        const flags = (data || []).reduce((acc: Record<string, unknown>, flag) => {
          let value = flag.default_value;
          if (flag.platform_overrides?.[platform]) {
            value = flag.platform_overrides[platform];
          }
          acc[flag.key] = value;
          return acc;
        }, {});

        return jsonResponse({ flags });
      }

      // Get specific flags
      const flags: Record<string, unknown> = {};
      for (const key of keys) {
        const { data } = await supabase.rpc("get_feature_flag", {
          p_key: key,
          p_user_id: userId,
          p_platform: platform,
        });
        flags[key] = data;
      }

      return jsonResponse({ flags });
    }

    if (req.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok", service: "experiments" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Experiments error:", error);
    return jsonResponse({ error: error.message }, 500);
  }
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
