// deno-lint-ignore-file ban-ts-comment
// @ts-nocheck
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Enhanced BFF (Backend-for-Frontend) with Mutation Support
 * Phase 2: Mutation support in Backend-for-Frontend layer
 *
 * Endpoints:
 * - POST /bff/listings - Create listing with auto-notification
 * - PATCH /bff/profile - Update profile with cascade
 * - POST /bff/batch - Batch multiple operations
 * - POST /bff/listing/:id/claim - Claim a listing
 * - POST /bff/listing/:id/review - Add review after claim
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ListingMutation {
  title: string;
  description: string;
  quantity: number;
  category: string;
  dietaryInfo?: string[];
  images?: string[];
  location?: { lat: number; lng: number };
  expiresAt?: string;
  notifyNearby?: boolean;
  scheduledAt?: string;
}

interface ProfileMutation {
  displayName?: string;
  bio?: string;
  location?: { lat: number; lng: number };
  avatarUrl?: string;
  propagateToListings?: boolean;
}

interface BatchOperation {
  type: "favorite" | "read" | "notification" | "listing";
  action: "add" | "remove" | "mark" | "dismiss" | "update";
  entityId?: string;
  entityIds?: string[];
  data?: Record<string, unknown>;
}

interface ClaimRequest {
  listingId: string;
  message?: string;
  scheduledPickupTime?: string;
}

interface ReviewRequest {
  listingId: string;
  revieweeId: string;
  rating: number;
  comment?: string;
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace("/bff", "");
    const method = req.method;

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get auth header for user context
    const authHeader = req.headers.get("Authorization");
    let userId: string | null = null;

    if (authHeader) {
      const { data: { user } } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", ""),
      );
      userId = user?.id ?? null;
    }

    // Route handling
    if (path === "/listings" && method === "POST") {
      return handleCreateListing(supabase, req, userId);
    }

    if (path === "/profile" && method === "PATCH") {
      return handleUpdateProfile(supabase, req, userId);
    }

    if (path === "/batch" && method === "POST") {
      return handleBatchOperations(supabase, req, userId);
    }

    if (path.match(/^\/listing\/[\w-]+\/claim$/) && method === "POST") {
      const listingId = path.split("/")[2];
      return handleClaimListing(supabase, req, userId, listingId);
    }

    if (path.match(/^\/listing\/[\w-]+\/review$/) && method === "POST") {
      const listingId = path.split("/")[2];
      return handleAddReview(supabase, req, userId, listingId);
    }

    // 404 for unknown routes
    return new Response(
      JSON.stringify({ error: "Not found", path }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("BFF Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

/**
 * Create a new listing with optional nearby notification
 */
async function handleCreateListing(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  userId: string | null,
): Promise<Response> {
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const body: ListingMutation = await req.json();

  // Validate required fields
  if (!body.title || !body.description || !body.quantity || !body.category) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields",
        required: ["title", "description", "quantity", "category"],
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Build listing object
  const listing = {
    user_id: userId,
    title: body.title.trim(),
    description: body.description.trim(),
    quantity: body.quantity,
    category: body.category,
    dietary_info: body.dietaryInfo || [],
    images: body.images || [],
    location: body.location ? `POINT(${body.location.lng} ${body.location.lat})` : null,
    expires_at: body.expiresAt || null,
    scheduled_at: body.scheduledAt || null,
    status: body.scheduledAt ? "scheduled" : "active",
    created_at: new Date().toISOString(),
  };

  // Insert listing
  const { data: newListing, error: insertError } = await supabase
    .from("posts")
    .insert(listing)
    .select()
    .single();

  if (insertError) {
    return new Response(
      JSON.stringify({ error: insertError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Notify nearby users if requested
  let notificationsSent = 0;
  if (body.notifyNearby && body.location) {
    notificationsSent = await notifyNearbyUsers(
      supabase,
      newListing.id,
      body.location,
      userId,
    );
  }

  // Update user stats
  await supabase.rpc("increment_user_stat", {
    p_user_id: userId,
    p_stat: "listings_created",
    p_amount: 1,
  });

  return new Response(
    JSON.stringify({
      success: true,
      listing: newListing,
      notificationsSent,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Update user profile with optional cascade to existing listings
 */
async function handleUpdateProfile(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  userId: string | null,
): Promise<Response> {
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const body: ProfileMutation = await req.json();

  // Build update object (only include provided fields)
  const updates: Record<string, unknown> = {};

  if (body.displayName !== undefined) {
    updates.display_name = body.displayName.trim();
  }
  if (body.bio !== undefined) {
    updates.bio = body.bio.trim();
  }
  if (body.location !== undefined) {
    updates.location = body.location ? `POINT(${body.location.lng} ${body.location.lat})` : null;
  }
  if (body.avatarUrl !== undefined) {
    updates.avatar_url = body.avatarUrl;
  }

  if (Object.keys(updates).length === 0) {
    return new Response(
      JSON.stringify({ error: "No updates provided" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  updates.updated_at = new Date().toISOString();

  // Update profile
  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select()
    .single();

  if (updateError) {
    return new Response(
      JSON.stringify({ error: updateError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Propagate changes to listings if requested
  let listingsUpdated = 0;
  if (body.propagateToListings && updates.display_name) {
    const { count } = await supabase
      .from("posts")
      .update({ author_name: updates.display_name })
      .eq("user_id", userId)
      .select("*", { count: "exact", head: true });

    listingsUpdated = count || 0;
  }

  return new Response(
    JSON.stringify({
      success: true,
      profile: updatedProfile,
      listingsUpdated,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Handle batch operations for better performance
 */
async function handleBatchOperations(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  userId: string | null,
): Promise<Response> {
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { operations }: { operations: BatchOperation[] } = await req.json();

  if (!Array.isArray(operations) || operations.length === 0) {
    return new Response(
      JSON.stringify({ error: "Operations array required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (operations.length > 50) {
    return new Response(
      JSON.stringify({ error: "Maximum 50 operations per batch" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const results: Array<{ operation: BatchOperation; success: boolean; error?: string }> = [];

  for (const op of operations) {
    try {
      const result = await executeBatchOperation(supabase, userId, op);
      results.push({ operation: op, success: true, ...result });
    } catch (error) {
      results.push({ operation: op, success: false, error: error.message });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.filter((r) => !r.success).length;

  return new Response(
    JSON.stringify({
      success: failureCount === 0,
      results,
      summary: { total: operations.length, succeeded: successCount, failed: failureCount },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Execute a single batch operation
 */
async function executeBatchOperation(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  op: BatchOperation,
): Promise<Record<string, unknown>> {
  switch (op.type) {
    case "favorite":
      if (op.action === "add") {
        await supabase.from("favorites").upsert({
          user_id: userId,
          listing_id: op.entityId,
          created_at: new Date().toISOString(),
        });
      } else if (op.action === "remove") {
        await supabase.from("favorites")
          .delete()
          .eq("user_id", userId)
          .eq("listing_id", op.entityId);
      }
      return {};

    case "read":
      if (op.action === "mark" && op.entityIds) {
        await supabase.from("chat_messages")
          .update({ read_at: new Date().toISOString() })
          .eq("receiver_id", userId)
          .in("id", op.entityIds);
      }
      return { markedCount: op.entityIds?.length || 0 };

    case "notification":
      if (op.action === "dismiss" && op.entityIds) {
        await supabase.from("notifications")
          .update({ dismissed_at: new Date().toISOString() })
          .eq("user_id", userId)
          .in("id", op.entityIds);
      }
      return { dismissedCount: op.entityIds?.length || 0 };

    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

/**
 * Claim a listing
 */
async function handleClaimListing(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  userId: string | null,
  listingId: string,
): Promise<Response> {
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const body: ClaimRequest = await req.json();

  // Check listing exists and is available
  const { data: listing, error: fetchError } = await supabase
    .from("posts")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return new Response(
      JSON.stringify({ error: "Listing not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (listing.status !== "active") {
    return new Response(
      JSON.stringify({ error: "Listing is not available" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (listing.user_id === userId) {
    return new Response(
      JSON.stringify({ error: "Cannot claim your own listing" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Create claim record
  const { data: claim, error: claimError } = await supabase
    .from("claims")
    .insert({
      listing_id: listingId,
      claimer_id: userId,
      owner_id: listing.user_id,
      message: body.message,
      scheduled_pickup_time: body.scheduledPickupTime,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (claimError) {
    return new Response(
      JSON.stringify({ error: claimError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Update listing status
  await supabase
    .from("posts")
    .update({ status: "claimed" })
    .eq("id", listingId);

  // Notify listing owner
  await supabase.from("notifications").insert({
    user_id: listing.user_id,
    type: "listing_claimed",
    title: "Your listing was claimed!",
    body: `Someone wants to pick up "${listing.title}"`,
    data: { listingId, claimId: claim.id, claimerId: userId },
    created_at: new Date().toISOString(),
  });

  // Create chat room for communication
  const { data: chatRoom } = await supabase
    .from("chat_rooms")
    .insert({
      listing_id: listingId,
      participant_ids: [userId, listing.user_id],
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  return new Response(
    JSON.stringify({
      success: true,
      claim,
      chatRoomId: chatRoom?.id,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Add review after claiming
 */
async function handleAddReview(
  supabase: ReturnType<typeof createClient>,
  req: Request,
  userId: string | null,
  listingId: string,
): Promise<Response> {
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const body: ReviewRequest = await req.json();

  // Validate rating
  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return new Response(
      JSON.stringify({ error: "Rating must be between 1 and 5" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Check claim exists and is completed
  const { data: claim } = await supabase
    .from("claims")
    .select("*")
    .eq("listing_id", listingId)
    .eq("claimer_id", userId)
    .single();

  if (!claim) {
    return new Response(
      JSON.stringify({ error: "No claim found for this listing" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Create review
  const { data: review, error: reviewError } = await supabase
    .from("reviews")
    .insert({
      reviewer_id: userId,
      reviewee_id: body.revieweeId,
      listing_id: listingId,
      rating: body.rating,
      comment: body.comment?.trim(),
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (reviewError) {
    return new Response(
      JSON.stringify({ error: reviewError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Update reviewee's average rating
  await supabase.rpc("recalculate_user_rating", { p_user_id: body.revieweeId });

  // Award points for leaving review
  await supabase.rpc("award_points", {
    p_user_id: userId,
    p_action: "review_submitted",
    p_points: 10,
  });

  // Notify reviewee
  await supabase.from("notifications").insert({
    user_id: body.revieweeId,
    type: "review_received",
    title: "You received a review!",
    body: `You received a ${body.rating}-star review`,
    data: { reviewId: review.id, rating: body.rating },
    created_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      success: true,
      review,
      pointsAwarded: 10,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Notify nearby users about a new listing
 */
async function notifyNearbyUsers(
  supabase: ReturnType<typeof createClient>,
  listingId: string,
  location: { lat: number; lng: number },
  excludeUserId: string,
): Promise<number> {
  // Find users within 10km radius
  const { data: nearbyUsers } = await supabase.rpc("get_users_near_location", {
    p_lat: location.lat,
    p_lng: location.lng,
    p_radius_km: 10,
    p_exclude_user_id: excludeUserId,
    p_limit: 100,
  });

  if (!nearbyUsers || nearbyUsers.length === 0) {
    return 0;
  }

  // Get listing details
  const { data: listing } = await supabase
    .from("posts")
    .select("title, category")
    .eq("id", listingId)
    .single();

  // Create notifications
  const notifications = nearbyUsers.map((user: { id: string }) => ({
    user_id: user.id,
    type: "nearby_listing",
    title: "New food available nearby!",
    body: `${listing?.title || "Food"} is available in your area`,
    data: { listingId, category: listing?.category },
    created_at: new Date().toISOString(),
  }));

  await supabase.from("notifications").insert(notifications);

  return nearbyUsers.length;
}
