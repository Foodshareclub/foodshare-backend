/**
 * create-listing Edge Function
 *
 * Orchestrates listing creation with:
 * 1. Authentication verification
 * 2. Content moderation (profanity/spam)
 * 3. Server-side validation
 * 4. Transactional creation
 * 5. Async notification to nearby users
 *
 * Usage from iOS/Android/Web:
 * POST /create-listing
 * Authorization: Bearer <jwt>
 * {
 *   "title": "Fresh Apples",
 *   "description": "Organic apples...",
 *   "images": ["url1", "url2"],
 *   "postType": "food",
 *   "latitude": 51.5074,
 *   "longitude": -0.1278,
 *   "pickupAddress": "123 Main St",
 *   "pickupTime": "Anytime today",
 *   "categoryId": 1
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "listing": { id, postName, ... },
 *   "error": null
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// Types
// =============================================================================

interface CreateListingRequest {
  title: string;
  description?: string | null;
  images: string[];
  postType: string;
  latitude: number;
  longitude: number;
  pickupAddress?: string | null;
  pickupTime?: string | null;
  categoryId?: number | null;
}

interface APIError {
  code: string;
  message: string;
  details?: unknown;
}

interface CreateListingResponse {
  success: boolean;
  listing?: Record<string, unknown>;
  error?: APIError;
}

// =============================================================================
// Content Moderation (same as validate-listing)
// =============================================================================

const SPAM_PATTERNS: RegExp[] = [
  /(https?:\/\/[^\s]+\s*){2,}/i,
  /\b(click here|limited time|act now|free money|earn \$|make \$\d+)\b/i,
  /\b(crypto|bitcoin|ethereum|nft|airdrop)\b/i,
  /https?:\/\/(?!.*supabase\.co)/i,
];

function containsSpam(text: string): boolean {
  return SPAM_PATTERNS.some((pattern) => pattern.test(text));
}

// =============================================================================
// CORS Headers
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" },
      } satisfies CreateListingResponse),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    // Initialize Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      console.error("Missing Supabase configuration");
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "SERVER_CONFIG_ERROR", message: "Server misconfigured" },
        } satisfies CreateListingResponse),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 1. Authenticate user
    // =========================================================================
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "AUTH_MISSING", message: "Authorization required" },
        } satisfies CreateListingResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "AUTH_INVALID", message: "Invalid or expired token" },
        } satisfies CreateListingResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 2. Parse and validate request body
    // =========================================================================
    const payload: CreateListingRequest = await req.json();

    // Quick content moderation check
    if (payload.title && containsSpam(payload.title)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "VALIDATION_SPAM",
            message: "Title contains suspicious content",
          },
        } satisfies CreateListingResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (payload.description && containsSpam(payload.description)) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "VALIDATION_SPAM",
            message: "Description contains suspicious content",
          },
        } satisfies CreateListingResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 3. Call transactional RPC (validates + creates in one transaction)
    // =========================================================================
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`, // Pass user's JWT for auth.uid()
        },
      },
    });

    const { data: result, error: rpcError } = await supabaseService.rpc(
      "create_listing_transactional",
      {
        p_profile_id: user.id,
        p_title: payload.title,
        p_description: payload.description,
        p_post_type: payload.postType,
        p_images: payload.images,
        p_latitude: payload.latitude,
        p_longitude: payload.longitude,
        p_pickup_address: payload.pickupAddress,
        p_pickup_time: payload.pickupTime,
        p_category_id: payload.categoryId,
      }
    );

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: "Failed to create listing",
            details: rpcError.message,
          },
        } satisfies CreateListingResponse),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Parse RPC result (returns JSONB)
    const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

    if (!rpcResult.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: rpcResult.error,
        } satisfies CreateListingResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 4. Trigger async notification to nearby users (fire and forget)
    // =========================================================================
    const listing = rpcResult.listing;

    EdgeRuntime.waitUntil(
      (async () => {
        try {
          await supabaseService.functions.invoke("notify-new-listing", {
            body: {
              food_item_id: listing.id,
              user_id: user.id,
              latitude: listing.latitude,
              longitude: listing.longitude,
              post_name: listing.postName,
              post_type: listing.postType,
            },
          });
        } catch (error) {
          console.error("Failed to trigger notification:", error);
          // Don't fail the request if notification fails
        }
      })()
    );

    // =========================================================================
    // 5. Return success response
    // =========================================================================
    return new Response(
      JSON.stringify({
        success: true,
        listing: listing,
        error: undefined,
      } satisfies CreateListingResponse),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in create-listing:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "SERVER_ERROR",
          message: error instanceof Error ? error.message : "Internal server error",
        },
      } satisfies CreateListingResponse),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
