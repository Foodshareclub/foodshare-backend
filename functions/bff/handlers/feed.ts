/**
 * BFF Feed Handler
 *
 * Aggregates feed data for the home screen:
 * - Nearby listings with owner profiles
 * - Unread notifications count
 * - Unread messages count
 * - User preferences for filtering
 * - Translations (if locale parameter provided)
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
  radiusKm: z.string().transform(Number).pipe(z.number().min(1).max(805)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  cursor: z.string().optional(),
  postType: z.enum(["food", "non_food", "all"]).optional(),
  categoryId: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
  locale: z.string().optional(), // User's locale for translations (e.g., "ru", "es")
});

type FeedQuery = z.infer<typeof feedQuerySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface FeedListing {
  id: string;
  title: string;
  description: string | null;
  titleTranslated?: string | null;
  descriptionTranslated?: string | null;
  translationLocale?: string | null;
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
  const locale = query.locale; // User's locale for translations

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

  const transformedListings: FeedListing[] = listings.map((item) => {
    const id = String(item.id);

    return {
      id,
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
    };
  });

  // Fetch translations if locale is provided and not English
  if (locale && locale !== "en" && transformedListings.length > 0) {
    try {
      const contentIds = transformedListings.map(l => l.id);
      
      // Call localization service to get translations
      const translationResponse = await supabase.functions.invoke(
        "localization/get-translations",
        {
          body: {
            contentType: "post",
            contentIds,
            locale,
            fields: ["title", "description"],
          },
        }
      );

      if (translationResponse.data?.success && translationResponse.data?.translations) {
        const translations = translationResponse.data.translations as Record<string, Record<string, string | null>>;
        
        // Merge translations into listings
        for (const listing of transformedListings) {
          const trans = translations[listing.id];
          if (trans) {
            listing.titleTranslated = trans.title || null;
            listing.descriptionTranslated = trans.description || null;
            listing.translationLocale = locale;
          }
        }

        logger.info("Translations fetched", {
          locale,
          listingsCount: transformedListings.length,
          fromRedis: translationResponse.data.fromRedis || 0,
          fromDatabase: translationResponse.data.fromDatabase || 0,
          onDemand: translationResponse.data.onDemand || 0,
        });
      }
    } catch (translationError) {
      // Log but don't fail - translations are optional
      logger.warn("Failed to fetch translations", {
        error: (translationError as Error).message,
        locale,
      });
    }
  }

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

// Body schema for POST requests (same params as query)
const feedBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusKm: z.number().min(1).max(805).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().optional(),
  postType: z.enum(["food", "non_food", "all"]).optional(),
  categoryId: z.number().int().positive().optional(),
  locale: z.string().optional(), // User's locale for translations
});

// Handler for POST requests (used by iOS via functions.invoke)
async function handlePostFeed(ctx: HandlerContext<z.infer<typeof feedBodySchema>>): Promise<Response> {
  const { body } = ctx;
  // Convert body to query format and reuse GET handler logic
  const query: FeedQuery = {
    lat: body.lat,
    lng: body.lng,
    radiusKm: body.radiusKm,
    limit: body.limit,
    cursor: body.cursor,
    postType: body.postType,
    categoryId: body.categoryId,
    locale: body.locale,
  };
  // Create new context with query params
  return handleGetFeed({ ...ctx, query } as HandlerContext<unknown, FeedQuery>);
}

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
    POST: {
      bodySchema: feedBodySchema,
      handler: handlePostFeed,
    },
  },
});
