import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface MatchUsersPayload {
  user_id: string;
  latitude: number;
  longitude: number;
  dietary_preferences?: string[];
  radius_km?: number;
}

interface UserMatch {
  user_id: string;
  distance_km: number;
  compatibility_score: number;
  shared_items_count: number;
  rating_average: number;
  common_preferences: string[];
}

Deno.serve(async (req: Request) => {
  try {
    // CORS headers
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Parse request body
    const payload: MatchUsersPayload = await req.json();
    const { user_id, latitude, longitude, dietary_preferences = [], radius_km = 10 } = payload;

    // Validate required fields
    if (!user_id || !latitude || !longitude) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get current user's profile
    const { data: currentUser, error: userError } = await supabase
      .from("profiles_foodshare")
      .select("*")
      .eq("id", user_id)
      .single();

    if (userError || !currentUser) {
      return new Response(
        JSON.stringify({ error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Find nearby food items
    const { data: nearbyItems, error: itemsError } = await supabase.rpc(
      "nearby_food_items",
      {
        user_lat: latitude,
        user_lng: longitude,
        radius_km: radius_km,
        dietary_filter: dietary_preferences.length > 0 ? dietary_preferences : null,
        limit_count: 100,
      }
    );

    if (itemsError) {
      console.error("Error finding nearby items:", itemsError);
      return new Response(
        JSON.stringify({ error: "Failed to find nearby items" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!nearbyItems || nearbyItems.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          matches: [],
          message: "No nearby users found",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Get unique user IDs from nearby items
    const nearbyUserIds = [...new Set(nearbyItems.map((item: any) => item.user_id))];

    // Get profiles for nearby users
    const { data: nearbyProfiles, error: profilesError } = await supabase
      .from("profiles_foodshare")
      .select("*")
      .in("id", nearbyUserIds)
      .eq("is_active", true);

    if (profilesError) {
      console.error("Error fetching nearby profiles:", profilesError);
    }

    // Calculate compatibility scores
    const matches: UserMatch[] = [];

    if (nearbyProfiles) {
      for (const profile of nearbyProfiles) {
        // Skip current user
        if (profile.id === user_id) continue;

        // Find items from this user
        const userItems = nearbyItems.filter((item: any) => item.user_id === profile.id);
        const avgDistance = userItems.reduce((sum: number, item: any) => sum + item.distance_km, 0) / userItems.length;

        // Calculate dietary preferences overlap
        const userPrefs = profile.dietary_preferences as string[] || [];
        const commonPrefs = dietary_preferences.filter(pref => userPrefs.includes(pref));
        const prefsScore = dietary_preferences.length > 0
          ? (commonPrefs.length / dietary_preferences.length) * 30
          : 0;

        // Rating score (0-30 points)
        const ratingScore = (profile.rating_average / 5) * 30;

        // Activity score based on items shared (0-20 points)
        const activityScore = Math.min((profile.items_shared / 10) * 20, 20);

        // Distance score (0-20 points, closer is better)
        const distanceScore = Math.max(0, 20 - (avgDistance * 2));

        // Calculate total compatibility score (0-100)
        const compatibilityScore = Math.round(
          prefsScore + ratingScore + activityScore + distanceScore
        );

        matches.push({
          user_id: profile.id,
          distance_km: Math.round(avgDistance * 100) / 100,
          compatibility_score: compatibilityScore,
          shared_items_count: userItems.length,
          rating_average: profile.rating_average,
          common_preferences: commonPrefs,
        });
      }
    }

    // Sort by compatibility score
    matches.sort((a, b) => b.compatibility_score - a.compatibility_score);

    // Return top 20 matches
    const topMatches = matches.slice(0, 20);

    return new Response(
      JSON.stringify({
        success: true,
        matches: topMatches,
        total_matches: matches.length,
        user_location: { latitude, longitude },
        radius_km,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error in match-users:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
