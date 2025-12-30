/**
 * BFF Feed Handler
 *
 * Aggregates feed data for the home screen:
 * - Nearby listings with owner profiles
 * - Unread notifications count
 * - Unread messages count
 * - User preferences for filtering
 *
 * Reduces client round-trips from 3-4 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";

// =============================================================================
// Request Schema
// =============================================================================

const feedQuerySchema = z.object({
  lat: z.string().transform(Number).pipe(z.number().min(-90).max(90)),
  lng: z.string().transform(Number).pipe(z.number().min(-180).max(180)),
  radiusKm: z.string().transform(Number).pipe(z.number().min(1).max(100)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  cursor: z.string().optional(),
  postType: z.enum(["food", "non_food", "all"]).optional(),
  categoryId: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
});

type FeedQuery = z.infer<typeof feedQuerySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface FeedListing {
  id: string;
  title: string;
  description: string | null;
  images: string[];
  postType: string;
  location: {
    lat: number;
    lng: number;
    distanceKm: number;
    address: string | null;
  };
  pickupTime: string | null;
  category: {
    id: number;
    name: string;
    icon: string;
  } | null;
  owner: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    rating: number | null;
  };
  createdAt: string;
  expiresAt: string | null;
}

interface FeedResponse {
  listings: FeedListing[];
  counts: {
    unreadNotifications: number;
    unreadMessages: number;
  };
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
  };
  meta: {
    location: { lat: number; lng: number };
    radiusKm: number;
  };
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetFeed(ctx: HandlerContext<unknown, FeedQuery>): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const lat = query.lat;
  const lng = query.lng;
  const radiusKm = query.radiusKm ?? 10;
  const limit = query.limit ?? 20;
  const cursor = query.cursor;
  const postType = query.postType === "all" ? null : query.postType;
  const categoryId = query.categoryId;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC that returns all feed data in one query
  const { data, error } = await supabase.rpc("get_bff_feed_data", {
    p_user_id: userId,
    p_lat: lat,
    p_lng: lng,
    p_radius_km: radiusKm,
    p_limit: limit + 1, // Fetch one extra for pagination
    p_cursor: cursor || null,
    p_post_type: postType,
    p_category_id: categoryId || null,
  });

  if (error) {
    logger.error("Failed to fetch feed data", new Error(error.message));
    throw new Error("Failed to fetch feed");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Transform listings
  const allListings = (result.listings || []) as Array<Record<string, unknown>>;
  const hasMore = allListings.length > limit;
  const listings = hasMore ? allListings.slice(0, -1) : allListings;

  const transformedListings: FeedListing[] = listings.map((item) => ({
    id: item.id as string,
    title: item.post_name as string,
    description: item.post_description as string | null,
    images: item.images as string[],
    postType: item.post_type as string,
    location: {
      lat: item.latitude as number,
      lng: item.longitude as number,
      distanceKm: Number(item.distance_km) || 0,
      address: item.pickup_address as string | null,
    },
    pickupTime: item.pickup_time as string | null,
    category: item.category_id
      ? {
          id: item.category_id as number,
          name: item.category_name as string,
          icon: item.category_icon as string,
        }
      : null,
    owner: {
      id: item.profile_id as string,
      displayName: item.owner_name as string,
      avatarUrl: item.owner_avatar as string | null,
      rating: item.owner_rating as number | null,
    },
    createdAt: item.created_at as string,
    expiresAt: item.expires_at as string | null,
  }));

  // Build response
  const feedResponse: FeedResponse = {
    listings: transformedListings,
    counts: {
      unreadNotifications: result.unread_notifications || 0,
      unreadMessages: result.unread_messages || 0,
    },
    pagination: {
      nextCursor: hasMore && listings.length > 0
        ? listings[listings.length - 1].created_at as string
        : null,
      hasMore,
      total: result.total_count || listings.length,
    },
    meta: {
      location: { lat, lng },
      radiusKm,
    },
  };

  // Apply platform-specific transforms with feed-specific options
  const platformResponse = transformForPlatform(feedResponse, platform, {
    resourceType: "feed",
    imageUseCase: "card",
    includeCapabilities: false, // Feed doesn't need capabilities
  });

  logger.info("Feed fetched", {
    userId,
    listingsCount: listings.length,
    platform,
    radiusKm,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-feed",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: feedQuerySchema,
      handler: handleGetFeed,
    },
  },
});
