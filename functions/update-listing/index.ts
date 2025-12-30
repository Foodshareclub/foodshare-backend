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
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { NotFoundError, ForbiddenError, ServerError } from "../_shared/errors.ts";

// =============================================================================
// Request Schema
// =============================================================================

const updateListingSchema = z.object({
  listingId: z.number().int().positive(),
  title: z.string().min(1).max(200).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  isActive: z.boolean().optional().nullable(),
  pickupAddress: z.string().max(500).optional().nullable(),
  pickupTime: z.string().max(200).optional().nullable(),
});

type UpdateListingRequest = z.infer<typeof updateListingSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UpdatedListing {
  id: number;
  title: string;
  description: string | null;
  isActive: boolean;
  pickupAddress: string | null;
  pickupTime: string | null;
  updatedAt: string;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleUpdateListing(ctx: HandlerContext<UpdateListingRequest>): Promise<Response> {
  const { supabase, userId, body, ctx: requestCtx } = ctx;

  logger.info("Updating listing", {
    listingId: body.listingId,
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  // Call transactional RPC
  const { data: result, error: rpcError } = await supabase.rpc(
    "update_listing_transactional",
    {
      p_listing_id: body.listingId,
      p_title: body.title,
      p_description: body.description,
      p_is_active: body.isActive,
      p_pickup_address: body.pickupAddress,
      p_pickup_time: body.pickupTime,
    }
  );

  if (rpcError) {
    logger.error("RPC error updating listing", {
      error: rpcError.message,
      listingId: body.listingId,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to update listing");
  }

  const rpcResult = typeof result === "string" ? JSON.parse(result) : result;

  if (!rpcResult.success) {
    const errorCode = rpcResult.error?.code;

    if (errorCode === "RESOURCE_NOT_FOUND") {
      throw new NotFoundError("Listing", body.listingId.toString());
    }

    if (errorCode === "AUTH_FORBIDDEN") {
      throw new ForbiddenError("You do not have permission to update this listing");
    }

    throw new ServerError(rpcResult.error?.message || "Failed to update listing");
  }

  const listing: UpdatedListing = {
    id: rpcResult.listing.id,
    title: rpcResult.listing.post_name,
    description: rpcResult.listing.post_description,
    isActive: rpcResult.listing.is_active,
    pickupAddress: rpcResult.listing.pickup_address,
    pickupTime: rpcResult.listing.pickup_time,
    updatedAt: rpcResult.listing.updated_at,
  };

  logger.info("Listing updated successfully", {
    listingId: body.listingId,
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  return ok({ listing }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "update-listing",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 updates per minute
    keyBy: "user",
  },
  routes: {
    PUT: {
      schema: updateListingSchema,
      handler: handleUpdateListing,
    },
    POST: {
      schema: updateListingSchema,
      handler: handleUpdateListing, // Also support POST for compatibility
    },
  },
});
