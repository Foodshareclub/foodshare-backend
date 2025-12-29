/**
 * update-listing Edge Function
 *
 * Handles listing updates with:
 * 1. Authentication verification
 * 2. Ownership validation
 * 3. Server-side validation
 * 4. Transactional update
 *
 * Usage from iOS/Android/Web:
 * PUT /update-listing
 * Authorization: Bearer <jwt>
 * {
 *   "listingId": 123,
 *   "title": "Updated Title",
 *   "description": "Updated description",
 *   "isActive": true,
 *   "pickupAddress": "456 New St",
 *   "pickupTime": "After 5pm"
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// Types
// =============================================================================

interface UpdateListingRequest {
  listingId: number;
  title?: string | null;
  description?: string | null;
  isActive?: boolean | null;
  pickupAddress?: string | null;
  pickupTime?: string | null;
}

interface APIError {
  code: string;
  message: string;
  details?: unknown;
}

interface UpdateListingResponse {
  success: boolean;
  listing?: Record<string, unknown>;
  error?: APIError;
}

// =============================================================================
// CORS Headers
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, POST, OPTIONS",
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

  if (req.method !== "PUT" && req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "Use PUT or POST" },
      } satisfies UpdateListingResponse),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "SERVER_CONFIG_ERROR", message: "Server misconfigured" },
        } satisfies UpdateListingResponse),
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
        } satisfies UpdateListingResponse),
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
        } satisfies UpdateListingResponse),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 2. Parse request body
    // =========================================================================
    const payload: UpdateListingRequest = await req.json();

    if (!payload.listingId || typeof payload.listingId !== "number") {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "listingId is required" },
        } satisfies UpdateListingResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // =========================================================================
    // 3. Call transactional RPC
    // =========================================================================
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const { data: result, error: rpcError } = await supabaseService.rpc(
      "update_listing_transactional",
      {
        p_listing_id: payload.listingId,
        p_title: payload.title,
        p_description: payload.description,
        p_is_active: payload.isActive,
        p_pickup_address: payload.pickupAddress,
        p_pickup_time: payload.pickupTime,
      }
    );

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: "Failed to update listing",
            details: rpcError.message,
          },
        } satisfies UpdateListingResponse),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

    if (!rpcResult.success) {
      const statusCode = rpcResult.error?.code === "RESOURCE_NOT_FOUND" ? 404 :
                         rpcResult.error?.code === "AUTH_FORBIDDEN" ? 403 : 400;
      return new Response(
        JSON.stringify({
          success: false,
          error: rpcResult.error,
        } satisfies UpdateListingResponse),
        {
          status: statusCode,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        listing: rpcResult.listing,
        error: undefined,
      } satisfies UpdateListingResponse),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in update-listing:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "SERVER_ERROR",
          message: error instanceof Error ? error.message : "Internal server error",
        },
      } satisfies UpdateListingResponse),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
