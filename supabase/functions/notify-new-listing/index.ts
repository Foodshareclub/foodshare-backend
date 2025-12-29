import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface NewListingPayload {
  food_item_id: number;
  user_id: string;
  title: string;
  latitude: number;
  longitude: number;
  radius_km?: number;
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
    const payload: NewListingPayload = await req.json();
    const { food_item_id, user_id, title, latitude, longitude, radius_km = 10 } = payload;

    // Validate required fields
    if (!food_item_id || !user_id || !title || !latitude || !longitude) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Find users within radius who have notifications enabled
    const { data: nearbyUsers, error: usersError } = await supabase.rpc(
      "nearby_food_items",
      {
        user_lat: latitude,
        user_lng: longitude,
        radius_km: radius_km,
        limit_count: 100,
      }
    );

    if (usersError) {
      console.error("Error finding nearby users:", usersError);
      return new Response(
        JSON.stringify({ error: "Failed to find nearby users" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Get profiles with notification preferences
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles_foodshare")
      .select("id, email, notification_preferences")
      .neq("id", user_id)
      .eq("is_active", true);

    if (profilesError) {
      console.error("Error fetching profiles:", profilesError);
    }

    const notificationPromises = [];
    let notificationCount = 0;

    // Send notifications to users who have them enabled
    if (profiles && profiles.length > 0) {
      for (const profile of profiles) {
        const prefs = profile.notification_preferences as Record<string, boolean>;

        if (prefs?.new_listings === true) {
          // Here you would integrate with your notification service
          // For example: Firebase Cloud Messaging, OneSignal, etc.

          // For now, we'll log that a notification would be sent
          console.log(`Would send notification to user ${profile.id} about listing ${food_item_id}`);
          notificationCount++;

          // You can also create a notifications record in the database
          const notificationPromise = supabase
            .from("notifications")
            .insert({
              profile_id: profile.id,
              notification_title: "New food available nearby! 🍎",
              notification_text: `${title} is now available in your area`,
              parameter_data: JSON.stringify({ food_item_id }),
              initial_page_name: "FoodItemDetail",
              status: "sent",
              timestamp: new Date().toISOString(),
            });

          notificationPromises.push(notificationPromise);
        }
      }
    }

    // Wait for all notifications to be created
    await Promise.all(notificationPromises);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Notified ${notificationCount} nearby users`,
        food_item_id,
        notificationCount,
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
    console.error("Error in notify-new-listing:", error);
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
