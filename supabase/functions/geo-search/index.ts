import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GeoSearchRequest {
  latitude: number;
  longitude: number;
  radius_km?: number;
  category?: string;
  limit?: number;
  offset?: number;
}

interface GeoFenceCheckRequest {
  user_id: string;
  latitude: number;
  longitude: number;
}

interface ClusterRequest {
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  zoom_level: number;
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

    // GET /geo-search/nearby - Search listings near location
    if (path === "nearby" && req.method === "GET") {
      const lat = parseFloat(url.searchParams.get("lat") || "0");
      const lng = parseFloat(url.searchParams.get("lng") || "0");
      const radius = parseFloat(url.searchParams.get("radius") || "10");
      const category = url.searchParams.get("category");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const { data, error } = await supabaseClient.rpc("geo_search_listings", {
        p_latitude: lat,
        p_longitude: lng,
        p_radius_km: radius,
        p_category: category,
        p_limit: limit,
        p_offset: offset,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ listings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /geo-search/search - Advanced geo search
    if (path === "search" && req.method === "POST") {
      const body: GeoSearchRequest = await req.json();

      const { data, error } = await supabaseClient.rpc("geo_search_listings", {
        p_latitude: body.latitude,
        p_longitude: body.longitude,
        p_radius_km: body.radius_km || 10,
        p_category: body.category,
        p_limit: body.limit || 50,
        p_offset: body.offset || 0,
      });

      if (error) throw error;

      return new Response(JSON.stringify({ listings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /geo-search/clusters - Get clustered markers for map
    if (path === "clusters" && req.method === "POST") {
      const body: ClusterRequest = await req.json();
      const { bounds, zoom_level } = body;

      // Calculate grid size based on zoom level
      const gridSize = Math.pow(2, 20 - zoom_level) * 0.0001;

      const { data, error } = await supabaseClient.rpc("get_listing_clusters", {
        p_north: bounds.north,
        p_south: bounds.south,
        p_east: bounds.east,
        p_west: bounds.west,
        p_grid_size: gridSize,
      });

      if (error) {
        // Fallback to simple bounding box query if clustering function not available
        const { data: listings, error: listError } = await supabaseClient
          .from("posts")
          .select("id, title, latitude, longitude, category")
          .gte("latitude", bounds.south)
          .lte("latitude", bounds.north)
          .gte("longitude", bounds.west)
          .lte("longitude", bounds.east)
          .eq("status", "available")
          .limit(200);

        if (listError) throw listError;

        // Simple client-side clustering
        const clusters = clusterMarkers(listings || [], gridSize);
        return new Response(JSON.stringify({ clusters }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ clusters: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /geo-search/fence-check - Check geo-fence triggers
    if (path === "fence-check" && req.method === "POST") {
      const body: GeoFenceCheckRequest = await req.json();

      const { data, error } = await supabaseClient.rpc("check_geo_fence_triggers", {
        p_user_id: body.user_id,
        p_latitude: body.latitude,
        p_longitude: body.longitude,
      });

      if (error) throw error;

      // If fences triggered, send notifications
      if (data && data.length > 0) {
        for (const fence of data) {
          await supabaseClient.from("notifications").insert({
            user_id: body.user_id,
            type: "geo_fence_triggered",
            title: `Near ${fence.name}`,
            body: `You're near your saved location. Check for nearby food!`,
            data: { fence_id: fence.id, latitude: body.latitude, longitude: body.longitude },
          });
        }
      }

      return new Response(JSON.stringify({ triggered_fences: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /geo-search/fence - Create geo-fence
    if (path === "fence" && req.method === "POST") {
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
      const { name, latitude, longitude, radius_meters, notify_on_enter } = body;

      const { data, error } = await supabaseClient
        .from("geo_fences")
        .insert({
          user_id: user.id,
          name,
          center_point: `POINT(${longitude} ${latitude})`,
          radius_meters: radius_meters || 500,
          notify_on_enter: notify_on_enter ?? true,
        })
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ fence: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /geo-search/fences - Get user's geo-fences
    if (path === "fences" && req.method === "GET") {
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

      const { data, error } = await supabaseClient
        .from("geo_fences")
        .select("*")
        .eq("user_id", user.id)
        .eq("enabled", true)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return new Response(JSON.stringify({ fences: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // DELETE /geo-search/fence/:id - Delete geo-fence
    if (path?.startsWith("fence-") && req.method === "DELETE") {
      const fenceId = path.replace("fence-", "");
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
        .from("geo_fences")
        .delete()
        .eq("id", fenceId)
        .eq("user_id", user.id);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
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

// Simple marker clustering helper
function clusterMarkers(
  markers: Array<{ id: string; latitude: number; longitude: number; title: string; category: string }>,
  gridSize: number
): Array<{ lat: number; lng: number; count: number; items: string[] }> {
  const clusters: Map<string, { lat: number; lng: number; items: string[]; sumLat: number; sumLng: number }> = new Map();

  for (const marker of markers) {
    const gridX = Math.floor(marker.longitude / gridSize);
    const gridY = Math.floor(marker.latitude / gridSize);
    const key = `${gridX},${gridY}`;

    if (clusters.has(key)) {
      const cluster = clusters.get(key)!;
      cluster.items.push(marker.id);
      cluster.sumLat += marker.latitude;
      cluster.sumLng += marker.longitude;
    } else {
      clusters.set(key, {
        lat: marker.latitude,
        lng: marker.longitude,
        items: [marker.id],
        sumLat: marker.latitude,
        sumLng: marker.longitude,
      });
    }
  }

  return Array.from(clusters.values()).map((c) => ({
    lat: c.sumLat / c.items.length,
    lng: c.sumLng / c.items.length,
    count: c.items.length,
    items: c.items,
  }));
}
