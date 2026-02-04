/**
 * Unified Listings API v1
 *
 * Enterprise-grade listing management consolidating ALL listing operations:
 * - Create: New listing with validation, moderation, notifications
 * - Update: Modify existing listing with ownership checks
 * - Delete: Soft delete with ownership validation
 * - Get: Fetch single listing with details
 *
 * Routes:
 * - GET    /health           - Health check
 * - POST   /                 - Create new listing
 * - PUT    /:id              - Update listing
 * - DELETE /:id              - Delete listing (soft delete)
 * - GET    /:id              - Get listing details
 *
 * @module api-v1-listings
 * @version 1.0.0
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { LISTING, ERROR_MESSAGES, sanitizeHtml } from "../_shared/validation-rules.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-listings";

// =============================================================================
// Request Schemas
// =============================================================================

const createListingSchema = z.object({
  title: z.string()
    .min(LISTING.title.minLength, ERROR_MESSAGES.titleTooShort(LISTING.title.minLength))
    .max(LISTING.title.maxLength, ERROR_MESSAGES.titleTooLong(LISTING.title.maxLength)),
  description: z.string()
    .max(LISTING.description.maxLength, ERROR_MESSAGES.descriptionTooLong(LISTING.description.maxLength))
    .nullable()
    .optional(),
  images: z.array(z.string().url("Invalid image URL")).min(1, "At least one image required"),
  postType: z.enum(["food", "non_food"]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pickupAddress: z.string().max(500).nullable().optional(),
  pickupTime: z.string().max(200).nullable().optional(),
  categoryId: z.number().int().positive().nullable().optional(),
});

const updateListingSchema = z.object({
  title: z.string().min(1).max(200).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  isActive: z.boolean().optional().nullable(),
  pickupAddress: z.string().max(500).optional().nullable(),
  pickupTime: z.string().max(200).optional().nullable(),
});

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400,
  code?: string,
  requestId?: string
): Response {
  return jsonResponse({ success: false, error, code, requestId }, corsHeaders, status);
}

// =============================================================================
// Route Parser
// =============================================================================

interface ParsedRoute {
  listingId: number | null;
  method: string;
}

function parseRoute(url: URL, method: string): ParsedRoute {
  const path = url.pathname
    .replace(/^\/api-v1-listings\/?/, "")
    .replace(/^\/*/, "");

  const segments = path.split("/").filter(Boolean);
  const listingId = segments[0] && /^\d+$/.test(segments[0]) ? parseInt(segments[0], 10) : null;

  return { listingId, method };
}

// =============================================================================
// Auth Helper
// =============================================================================

async function authenticateUser(
  req: Request,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<{ authenticated: boolean; userId?: string; error?: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { authenticated: false, error: "Missing authorization header" };
  }

  const token = authHeader.slice(7);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return { authenticated: false, error: "Invalid token" };
  }

  return { authenticated: true, userId: user.id };
}

// =============================================================================
// Service Client Factory
// =============================================================================

function createServiceClient(userToken: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${userToken}` },
    },
  });
}

// =============================================================================
// Handlers
// =============================================================================

async function handleCreateListing(
  body: unknown,
  userId: string,
  userToken: string,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = createListingSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", "),
      corsHeaders,
      400,
      "VALIDATION_ERROR",
      requestId
    );
  }

  const data = parsed.data;
  const supabaseService = createServiceClient(userToken);

  // Sanitize inputs
  const sanitizedTitle = sanitizeHtml(data.title);
  const sanitizedDescription = data.description ? sanitizeHtml(data.description) : null;
  const sanitizedPickupAddress = data.pickupAddress ? sanitizeHtml(data.pickupAddress) : null;
  const sanitizedPickupTime = data.pickupTime ? sanitizeHtml(data.pickupTime) : null;

  // Content moderation
  const { data: validationResult, error: validationError } = await supabaseService.rpc(
    "validate_listing_content",
    {
      p_title: sanitizedTitle,
      p_description: sanitizedDescription,
    }
  );

  if (!validationError && validationResult && !validationResult.valid) {
    const firstError = validationResult.errors?.[0];
    return errorResponse(
      firstError?.message || "Content validation failed",
      corsHeaders,
      400,
      "CONTENT_VALIDATION_FAILED",
      requestId
    );
  }

  // Create listing via RPC
  const { data: result, error: rpcError } = await supabaseService.rpc(
    "create_listing_transactional",
    {
      p_profile_id: userId,
      p_title: sanitizedTitle,
      p_description: sanitizedDescription,
      p_post_type: data.postType,
      p_images: data.images,
      p_latitude: data.latitude,
      p_longitude: data.longitude,
      p_pickup_address: sanitizedPickupAddress,
      p_pickup_time: sanitizedPickupTime,
      p_category_id: data.categoryId,
    }
  );

  if (rpcError) {
    logger.error("RPC error creating listing", new Error(rpcError.message));
    return errorResponse("Failed to create listing", corsHeaders, 500, "CREATE_FAILED", requestId);
  }

  const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

  if (!rpcResult.success) {
    return errorResponse(
      rpcResult.error?.message || "Failed to create listing",
      corsHeaders,
      400,
      rpcResult.error?.code || "CREATE_FAILED",
      requestId
    );
  }

  const listing = rpcResult.listing;

  // Trigger notification (fire and forget)
  EdgeRuntime.waitUntil(
    (async () => {
      try {
        await supabaseService.functions.invoke("api-v1-notifications", {
          body: {
            route: "trigger/new-listing",
            food_item_id: listing.id,
            user_id: userId,
            latitude: listing.latitude,
            longitude: listing.longitude,
            post_name: listing.postName,
            post_type: listing.postType,
          },
        });
      } catch (error) {
        logger.warn("Failed to trigger notification", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })()
  );

  logger.info("Listing created", {
    listingId: listing.id,
    userId: userId.substring(0, 8),
    requestId,
  });

  return jsonResponse({
    success: true,
    listing,
    requestId,
  }, corsHeaders, 201);
}

async function handleUpdateListing(
  listingId: number,
  body: unknown,
  userId: string,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = updateListingSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      parsed.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join(", "),
      corsHeaders,
      400,
      "VALIDATION_ERROR",
      requestId
    );
  }

  const data = parsed.data;
  const supabase = getSupabaseClient();

  logger.info("Updating listing", {
    listingId,
    userId: userId.substring(0, 8),
    requestId,
  });

  const { data: result, error: rpcError } = await supabase.rpc(
    "update_listing_transactional",
    {
      p_listing_id: listingId,
      p_title: data.title,
      p_description: data.description,
      p_is_active: data.isActive,
      p_pickup_address: data.pickupAddress,
      p_pickup_time: data.pickupTime,
    }
  );

  if (rpcError) {
    logger.error("RPC error updating listing", { error: rpcError.message, listingId, requestId });
    return errorResponse("Failed to update listing", corsHeaders, 500, "UPDATE_FAILED", requestId);
  }

  const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

  if (!rpcResult.success) {
    const errorCode = rpcResult.error?.code;

    if (errorCode === "RESOURCE_NOT_FOUND") {
      return errorResponse("Listing not found", corsHeaders, 404, "NOT_FOUND", requestId);
    }

    if (errorCode === "AUTH_FORBIDDEN") {
      return errorResponse("Permission denied", corsHeaders, 403, "FORBIDDEN", requestId);
    }

    return errorResponse(
      rpcResult.error?.message || "Failed to update listing",
      corsHeaders,
      400,
      errorCode || "UPDATE_FAILED",
      requestId
    );
  }

  const listing = {
    id: rpcResult.listing.id,
    title: rpcResult.listing.post_name,
    description: rpcResult.listing.post_description,
    isActive: rpcResult.listing.is_active,
    pickupAddress: rpcResult.listing.pickup_address,
    pickupTime: rpcResult.listing.pickup_time,
    updatedAt: rpcResult.listing.updated_at,
  };

  logger.info("Listing updated", { listingId, userId: userId.substring(0, 8), requestId });

  return jsonResponse({ success: true, listing, requestId }, corsHeaders);
}

async function handleDeleteListing(
  listingId: number,
  userId: string,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const supabase = getSupabaseClient();

  logger.info("Deleting listing", { listingId, userId: userId.substring(0, 8), requestId });

  // Verify ownership first
  const { data: listing, error: fetchError } = await supabase
    .from("posts")
    .select("id, profile_id")
    .eq("id", listingId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !listing) {
    return errorResponse("Listing not found", corsHeaders, 404, "NOT_FOUND", requestId);
  }

  if (listing.profile_id !== userId) {
    return errorResponse("Permission denied", corsHeaders, 403, "FORBIDDEN", requestId);
  }

  // Soft delete
  const { error: deleteError } = await supabase
    .from("posts")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", listingId);

  if (deleteError) {
    logger.error("Error deleting listing", { error: deleteError.message, listingId, requestId });
    return errorResponse("Failed to delete listing", corsHeaders, 500, "DELETE_FAILED", requestId);
  }

  logger.info("Listing deleted", { listingId, userId: userId.substring(0, 8), requestId });

  return new Response(null, { status: 204, headers: corsHeaders });
}

async function handleGetListing(
  listingId: number,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const supabase = getSupabaseClient();

  const { data: listing, error } = await supabase
    .from("posts")
    .select(`
      id,
      post_name,
      post_description,
      post_type,
      is_active,
      created_at,
      updated_at,
      profile_id,
      post_views,
      post_like_counter,
      images,
      pickup_time,
      post_address,
      profiles:profile_id (
        id,
        first_name,
        second_name,
        nickname
      )
    `)
    .eq("id", listingId)
    .is("deleted_at", null)
    .single();

  if (error || !listing) {
    return errorResponse("Listing not found", corsHeaders, 404, "NOT_FOUND", requestId);
  }

  return jsonResponse({
    success: true,
    listing: {
      id: listing.id,
      title: listing.post_name,
      description: listing.post_description,
      postType: listing.post_type,
      isActive: listing.is_active,
      createdAt: listing.created_at,
      updatedAt: listing.updated_at,
      views: listing.post_views,
      likes: listing.post_like_counter,
      images: listing.images,
      pickupTime: listing.pickup_time,
      address: listing.post_address,
      owner: listing.profiles,
    },
    requestId,
  }, corsHeaders);
}

// =============================================================================
// Main Router
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const requestId = crypto.randomUUID();
  const corsHeaders = getCorsHeaders(req);
  const url = new URL(req.url);
  const route = parseRoute(url, req.method);

  try {
    // Health check (no auth)
    const path = url.pathname.replace(/^\/api-v1-listings\/?/, "").replace(/^\/*/, "");
    if (path === "health" || path === "") {
      if (req.method === "GET" && !route.listingId) {
        return jsonResponse({
          status: "healthy",
          version: VERSION,
          service: SERVICE,
          timestamp: new Date().toISOString(),
          endpoints: ["POST /", "PUT /:id", "DELETE /:id", "GET /:id"],
        }, corsHeaders);
      }
    }

    // Authenticate for all other routes
    const supabase = getSupabaseClient();
    const auth = await authenticateUser(req, supabase);

    // GET /:id - Public (no auth required)
    if (req.method === "GET" && route.listingId) {
      return handleGetListing(route.listingId, corsHeaders, requestId);
    }

    // All other routes require auth
    if (!auth.authenticated) {
      return errorResponse(auth.error || "Unauthorized", corsHeaders, 401, "UNAUTHORIZED", requestId);
    }

    const userId = auth.userId!;
    const authHeader = req.headers.get("Authorization");
    const userToken = authHeader?.slice(7) || "";

    // Parse body for POST/PUT
    let body: unknown = null;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      body = await req.json().catch(() => ({}));
    }

    // POST / - Create listing
    if (req.method === "POST" && !route.listingId) {
      return handleCreateListing(body, userId, userToken, corsHeaders, requestId);
    }

    // PUT /:id - Update listing
    if ((req.method === "PUT" || req.method === "PATCH") && route.listingId) {
      return handleUpdateListing(route.listingId, body, userId, corsHeaders, requestId);
    }

    // DELETE /:id - Delete listing
    if (req.method === "DELETE" && route.listingId) {
      return handleDeleteListing(route.listingId, userId, corsHeaders, requestId);
    }

    return errorResponse("Not found", corsHeaders, 404, "NOT_FOUND", requestId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Listings request failed", err, { requestId, path: url.pathname });

    return jsonResponse({
      success: false,
      error: err.message,
      requestId,
    }, corsHeaders, 500);
  }
});
