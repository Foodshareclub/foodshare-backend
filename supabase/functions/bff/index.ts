import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-version, x-platform, x-app-version",
};

// BFF Response wrapper for consistent API responses
interface BFFResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: {
    api_version: string;
    request_id: string;
    cached: boolean;
    cache_ttl?: number;
  };
}

function createResponse<T>(data: T, meta?: Partial<BFFResponse<T>["meta"]>): Response {
  const response: BFFResponse<T> = {
    success: true,
    data,
    meta: {
      api_version: "v2",
      request_id: crypto.randomUUID(),
      cached: false,
      ...meta,
    },
  };
  return new Response(JSON.stringify(response), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createErrorResponse(code: string, message: string, status: number = 400): Response {
  const response: BFFResponse<null> = {
    success: false,
    error: { code, message },
    meta: {
      api_version: "v2",
      request_id: crypto.randomUUID(),
      cached: false,
    },
  };
  return new Response(JSON.stringify(response), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const pathParts = url.pathname.split("/").filter(Boolean);
    const endpoint = pathParts[pathParts.length - 1];

    // Extract headers
    const platform = req.headers.get("x-platform") || "web";
    const appVersion = req.headers.get("x-app-version") || "1.0.0";
    const authHeader = req.headers.get("Authorization");

    // Helper to get authenticated user
    const getUser = async () => {
      if (!authHeader) return null;
      const { data: { user } } = await supabaseClient.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      return user;
    };

    // =====================================================
    // BFF-FEED: Optimized feed endpoint
    // =====================================================
    if (endpoint === "feed" && req.method === "GET") {
      const user = await getUser();
      const cursor = url.searchParams.get("cursor");
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const category = url.searchParams.get("category");
      const lat = parseFloat(url.searchParams.get("lat") || "0");
      const lng = parseFloat(url.searchParams.get("lng") || "0");
      const radiusKm = parseFloat(url.searchParams.get("radius") || "25");

      let query = supabaseClient
        .from("posts")
        .select(`
          id, title, description, category, quantity, quantity_unit,
          pickup_location, latitude, longitude,
          expiry_date, status, created_at, updated_at,
          photos,
          user_id,
          profiles!posts_user_id_fkey(id, display_name, avatar_url, rating)
        `)
        .eq("status", "available")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (category) {
        query = query.eq("category", category);
      }

      if (cursor) {
        query = query.lt("created_at", cursor);
      }

      // If location provided, filter by distance
      if (lat !== 0 && lng !== 0) {
        // Use PostGIS for distance filtering
        const { data: nearbyIds } = await supabaseClient.rpc("get_listings_within_radius", {
          p_lat: lat,
          p_lng: lng,
          p_radius_km: radiusKm,
        });

        if (nearbyIds && nearbyIds.length > 0) {
          query = query.in("id", nearbyIds.map((r: { id: string }) => r.id));
        }
      }

      const { data: listings, error } = await query;
      if (error) throw error;

      // Get user's favorites if authenticated
      let favoriteIds: string[] = [];
      if (user) {
        const { data: favorites } = await supabaseClient
          .from("favorites")
          .select("listing_id")
          .eq("user_id", user.id);
        favoriteIds = favorites?.map((f) => f.listing_id) || [];
      }

      // Transform response
      const feedItems = listings?.map((listing) => ({
        ...listing,
        is_favorited: favoriteIds.includes(listing.id),
        distance_km: lat && lng && listing.latitude && listing.longitude
          ? calculateDistance(lat, lng, listing.latitude, listing.longitude)
          : null,
      }));

      const nextCursor = listings && listings.length === limit
        ? listings[listings.length - 1].created_at
        : null;

      return createResponse({
        listings: feedItems,
        next_cursor: nextCursor,
        has_more: nextCursor !== null,
      });
    }

    // =====================================================
    // BFF-PROFILE: Optimized profile endpoint
    // =====================================================
    if (endpoint === "profile" && req.method === "GET") {
      const userId = url.searchParams.get("user_id");
      const user = await getUser();

      const targetUserId = userId || user?.id;
      if (!targetUserId) {
        return createErrorResponse("UNAUTHORIZED", "Authentication required", 401);
      }

      // Fetch profile with aggregated data
      const { data: profile, error: profileError } = await supabaseClient
        .from("profiles")
        .select("*")
        .eq("id", targetUserId)
        .single();

      if (profileError) throw profileError;

      // Get rating aggregates
      const { data: ratingData } = await supabaseClient
        .from("rating_aggregates")
        .select("*")
        .eq("target_user_id", targetUserId)
        .single();

      // Get listing counts
      const { count: activeListings } = await supabaseClient
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", targetUserId)
        .eq("status", "available");

      const { count: completedListings } = await supabaseClient
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", targetUserId)
        .eq("status", "completed");

      // Check if viewing own profile
      const isOwnProfile = user?.id === targetUserId;

      return createResponse({
        profile: {
          ...profile,
          rating: ratingData?.avg_rating || 0,
          review_count: ratingData?.review_count || 0,
          rating_distribution: ratingData?.rating_distribution || {},
          active_listings: activeListings || 0,
          completed_listings: completedListings || 0,
          is_own_profile: isOwnProfile,
        },
      });
    }

    // =====================================================
    // BFF-LISTING: Single listing with full details
    // =====================================================
    if (endpoint === "listing" && req.method === "GET") {
      const listingId = url.searchParams.get("id");
      if (!listingId) {
        return createErrorResponse("INVALID_REQUEST", "Listing ID required", 400);
      }

      const user = await getUser();

      const { data: listing, error } = await supabaseClient
        .from("posts")
        .select(`
          *,
          profiles!posts_user_id_fkey(
            id, display_name, avatar_url, rating, bio, created_at
          )
        `)
        .eq("id", listingId)
        .single();

      if (error) throw error;

      // Check if favorited
      let isFavorited = false;
      if (user) {
        const { data: favorite } = await supabaseClient
          .from("favorites")
          .select("id")
          .eq("user_id", user.id)
          .eq("listing_id", listingId)
          .single();
        isFavorited = !!favorite;
      }

      // Get similar listings
      const { data: similar } = await supabaseClient
        .from("posts")
        .select("id, title, photos, category")
        .eq("category", listing.category)
        .neq("id", listingId)
        .eq("status", "available")
        .limit(5);

      return createResponse({
        listing: {
          ...listing,
          is_favorited: isFavorited,
          is_own_listing: user?.id === listing.user_id,
        },
        similar_listings: similar || [],
      });
    }

    // =====================================================
    // BFF-MESSAGES: Optimized messaging endpoint
    // =====================================================
    if (endpoint === "messages" && req.method === "GET") {
      const user = await getUser();
      if (!user) {
        return createErrorResponse("UNAUTHORIZED", "Authentication required", 401);
      }

      const roomId = url.searchParams.get("room_id");

      if (roomId) {
        // Get messages for specific room
        const cursor = url.searchParams.get("cursor");
        const limit = parseInt(url.searchParams.get("limit") || "50");

        let query = supabaseClient
          .from("messages")
          .select(`
            id, content, sender_id, created_at, read_at, message_type,
            profiles!messages_sender_id_fkey(id, display_name, avatar_url)
          `)
          .eq("room_id", roomId)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (cursor) {
          query = query.lt("created_at", cursor);
        }

        const { data: messages, error } = await query;
        if (error) throw error;

        // Mark messages as read
        await supabaseClient
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("room_id", roomId)
          .neq("sender_id", user.id)
          .is("read_at", null);

        return createResponse({
          messages: messages?.reverse() || [],
          next_cursor: messages && messages.length === limit
            ? messages[messages.length - 1].created_at
            : null,
        });
      } else {
        // Get all chat rooms
        const { data: rooms, error } = await supabaseClient
          .from("chat_rooms")
          .select(`
            id, created_at, updated_at,
            listing_id,
            posts!chat_rooms_listing_id_fkey(id, title, photos),
            chat_room_participants!inner(user_id),
            messages(id, content, sender_id, created_at, read_at)
          `)
          .contains("chat_room_participants", [{ user_id: user.id }])
          .order("updated_at", { ascending: false });

        if (error) throw error;

        // Transform rooms with unread counts
        const transformedRooms = rooms?.map((room) => {
          const otherParticipant = room.chat_room_participants?.find(
            (p: { user_id: string }) => p.user_id !== user.id
          );
          const unreadCount = room.messages?.filter(
            (m: { sender_id: string; read_at: string | null }) =>
              m.sender_id !== user.id && !m.read_at
          ).length || 0;
          const lastMessage = room.messages?.[0];

          return {
            id: room.id,
            listing: room.posts,
            other_user_id: otherParticipant?.user_id,
            last_message: lastMessage,
            unread_count: unreadCount,
            updated_at: room.updated_at,
          };
        });

        return createResponse({ rooms: transformedRooms });
      }
    }

    // =====================================================
    // BFF-SEARCH: Optimized search with suggestions
    // =====================================================
    if (endpoint === "search" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const type = url.searchParams.get("type") || "listings"; // listings, users, suggestions
      const limit = parseInt(url.searchParams.get("limit") || "20");

      if (type === "suggestions") {
        // Get search suggestions
        const { data: suggestions, error } = await supabaseClient.rpc("get_search_suggestions", {
          p_query: query,
          p_limit: limit,
        });

        if (error) throw error;

        return createResponse({ suggestions: suggestions || [] });
      }

      if (type === "users") {
        // Search users
        const { data: users, error } = await supabaseClient
          .from("profiles")
          .select("id, display_name, avatar_url, rating, bio")
          .ilike("display_name", `%${query}%`)
          .limit(limit);

        if (error) throw error;

        return createResponse({ users: users || [] });
      }

      // Search listings (default)
      const user = await getUser();
      const category = url.searchParams.get("category");
      const lat = parseFloat(url.searchParams.get("lat") || "0");
      const lng = parseFloat(url.searchParams.get("lng") || "0");

      let listingQuery = supabaseClient
        .from("posts")
        .select(`
          id, title, description, category, photos, latitude, longitude,
          created_at, status,
          profiles!posts_user_id_fkey(id, display_name, avatar_url)
        `)
        .eq("status", "available")
        .or(`title.ilike.%${query}%,description.ilike.%${query}%`)
        .limit(limit);

      if (category) {
        listingQuery = listingQuery.eq("category", category);
      }

      const { data: listings, error } = await listingQuery;
      if (error) throw error;

      // Record search history if authenticated
      if (user) {
        await supabaseClient.from("search_history").insert({
          user_id: user.id,
          query,
          query_normalized: query.toLowerCase().trim(),
          platform,
          result_count: listings?.length || 0,
          filters: { category, lat, lng },
        });
      }

      return createResponse({
        listings: listings || [],
        query,
        result_count: listings?.length || 0,
      });
    }

    // =====================================================
    // BFF-REVIEWS: Reviews with ratings
    // =====================================================
    if (endpoint === "reviews" && req.method === "GET") {
      const userId = url.searchParams.get("user_id");
      if (!userId) {
        return createErrorResponse("INVALID_REQUEST", "User ID required", 400);
      }

      const limit = parseInt(url.searchParams.get("limit") || "20");
      const cursor = url.searchParams.get("cursor");

      let query = supabaseClient
        .from("reviews")
        .select(`
          id, rating, comment, created_at,
          author_id,
          profiles!reviews_author_id_fkey(id, display_name, avatar_url)
        `)
        .eq("target_user_id", userId)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (cursor) {
        query = query.lt("created_at", cursor);
      }

      const { data: reviews, error } = await query;
      if (error) throw error;

      // Get rating aggregates
      const { data: aggregates } = await supabaseClient
        .from("rating_aggregates")
        .select("*")
        .eq("target_user_id", userId)
        .single();

      return createResponse({
        reviews: reviews || [],
        aggregates: aggregates || {
          avg_rating: 0,
          review_count: 0,
          rating_distribution: {},
        },
        next_cursor: reviews && reviews.length === limit
          ? reviews[reviews.length - 1].created_at
          : null,
      });
    }

    // =====================================================
    // BFF-TRANSLATIONS: Get translations for locale
    // =====================================================
    if (endpoint === "translations" && req.method === "GET") {
      const locale = url.searchParams.get("locale") || "en";
      const namespace = url.searchParams.get("namespace") || "common";

      const { data, error } = await supabaseClient.rpc("get_translations", {
        p_locale: locale,
        p_namespace: namespace,
      });

      if (error) throw error;

      return createResponse({
        locale,
        namespace,
        translations: data || {},
      }, { cached: true, cache_ttl: 3600 });
    }

    // =====================================================
    // BFF-VERSION: Get API version info
    // =====================================================
    if (endpoint === "version" && req.method === "GET") {
      const { data: version, error } = await supabaseClient.rpc("get_api_version", {
        p_platform: platform,
        p_app_version: appVersion,
      });

      if (error) throw error;

      return createResponse({
        api_version: version?.version || "v2",
        features: version?.features || {},
        min_app_version: platform === "ios"
          ? version?.min_app_version_ios
          : version?.min_app_version_android,
      });
    }

    return createErrorResponse("NOT_FOUND", "Endpoint not found", 404);
  } catch (error) {
    console.error("BFF Error:", error);
    return createErrorResponse("INTERNAL_ERROR", error.message, 500);
  }
});

// Haversine distance calculation
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
