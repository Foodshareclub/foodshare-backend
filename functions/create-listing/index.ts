/**
 * create-listing Edge Function
 *
 * Orchestrates listing creation with:
 * 1. Authentication verification (via api-handler)
 * 2. Schema validation (via Zod)
 * 3. Content moderation (profanity/spam via RPC)
 * 4. Transactional creation (via RPC)
 * 5. Async notification to nearby users
 *
 * Usage from iOS/Android/Web:
 * POST /create-listing
 * Authorization: Bearer <jwt>
 * Body: { title, description?, images, postType, latitude, longitude, ... }
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, created, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { LISTING, ERROR_MESSAGES, sanitizeHtml } from "../_shared/validation-rules.ts";

// =============================================================================
// Request Schema (using shared validation constants from Swift FoodshareCore)
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

type CreateListingRequest = z.infer<typeof createListingSchema>;

// =============================================================================
// Service Client Factory (for RPC calls requiring service role)
// =============================================================================

function createServiceClient(userToken: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${userToken}` }, // Pass user's JWT for auth.uid()
    },
  });
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleCreateListing(ctx: HandlerContext<CreateListingRequest>): Promise<Response> {
  const { body, userId, request, corsHeaders } = ctx;

  // Get user token for service client
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "") || "";
  const supabaseService = createServiceClient(token);

  // -------------------------------------------------------------------------
  // 0. Sanitize user inputs to prevent XSS
  // -------------------------------------------------------------------------
  const sanitizedTitle = sanitizeHtml(body.title);
  const sanitizedDescription = body.description ? sanitizeHtml(body.description) : null;
  const sanitizedPickupAddress = body.pickupAddress ? sanitizeHtml(body.pickupAddress) : null;
  const sanitizedPickupTime = body.pickupTime ? sanitizeHtml(body.pickupTime) : null;

  // -------------------------------------------------------------------------
  // 1. Server-side content moderation via RPC
  // -------------------------------------------------------------------------
  const { data: validationResult, error: validationError } = await supabaseService.rpc(
    "validate_listing_content",
    {
      p_title: sanitizedTitle,
      p_description: sanitizedDescription,
    }
  );

  if (validationError) {
    logger.error("Content validation RPC error", new Error(validationError.message));
    // Fall through - don't block on validation service failure
  } else if (validationResult && !validationResult.valid) {
    const firstError = validationResult.errors?.[0];
    throw new ValidationError(
      firstError?.message || "Content validation failed",
      validationResult.errors?.map((e: { field?: string; message: string }) => ({
        field: e.field || "content",
        message: e.message,
      }))
    );
  }

  // -------------------------------------------------------------------------
  // 2. Call transactional RPC (validates + creates in one transaction)
  // -------------------------------------------------------------------------
  const { data: result, error: rpcError } = await supabaseService.rpc(
    "create_listing_transactional",
    {
      p_profile_id: userId,
      p_title: sanitizedTitle,
      p_description: sanitizedDescription,
      p_post_type: body.postType,
      p_images: body.images,
      p_latitude: body.latitude,
      p_longitude: body.longitude,
      p_pickup_address: sanitizedPickupAddress,
      p_pickup_time: sanitizedPickupTime,
      p_category_id: body.categoryId,
    }
  );

  if (rpcError) {
    logger.error("RPC error creating listing", new Error(rpcError.message));
    throw new Error("Failed to create listing");
  }

  // Parse RPC result (returns JSONB)
  const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

  if (!rpcResult.success) {
    throw new ValidationError(rpcResult.error?.message || "Failed to create listing");
  }

  const listing = rpcResult.listing;

  // -------------------------------------------------------------------------
  // 3. Trigger async notification to nearby users (fire and forget)
  // -------------------------------------------------------------------------
  EdgeRuntime.waitUntil(
    (async () => {
      try {
        await supabaseService.functions.invoke("notify-new-listing", {
          body: {
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

  // -------------------------------------------------------------------------
  // 4. Return created response
  // -------------------------------------------------------------------------
  return created({ listing }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "create-listing",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 10,
    windowMs: 60000, // 10 listings per minute
    keyBy: "user",
  },
  routes: {
    POST: {
      schema: createListingSchema,
      idempotent: true, // Support idempotency keys
      handler: handleCreateListing,
    },
  },
});
