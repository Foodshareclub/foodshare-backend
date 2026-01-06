/**
 * BFF Listing Detail Handler
 *
 * Aggregates complete listing detail data:
 * - Listing with all fields and images
 * - Seller profile with stats and reviews
 * - Related listings (same category/nearby)
 * - User's interaction state (favorited, can contact)
 *
 * Reduces client round-trips from 4-5 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { NotFoundError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";
import type {
  ListingDetailResponse,
  ListingSummary,
  ReviewSummary,
  UserSummary,
  ImageInfo,
  GeoLocation,
  CategoryInfo,
} from "../_types/bff-responses.ts";

// =============================================================================
// Request Schema
// =============================================================================

const listingDetailParamsSchema = z.object({
  id: z.string().uuid(),
});

const listingDetailQuerySchema = z.object({
  lat: z.string().transform(Number).pipe(z.number().min(-90).max(90)).optional(),
  lng: z.string().transform(Number).pipe(z.number().min(-180).max(180)).optional(),
  relatedLimit: z.string().transform(Number).pipe(z.number().int().min(0).max(10)).optional(),
  reviewsLimit: z.string().transform(Number).pipe(z.number().int().min(0).max(5)).optional(),
});

type ListingDetailQuery = z.infer<typeof listingDetailQuerySchema>;

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetListingDetail(
  ctx: HandlerContext<unknown, ListingDetailQuery>
): Promise<Response> {
  const { supabase, userId, query, request, ctx: requestCtx } = ctx;

  // Extract listing ID from URL path
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const listingId = pathParts[pathParts.length - 1];

  if (!listingId || !z.string().uuid().safeParse(listingId).success) {
    throw new NotFoundError("Listing", listingId || "unknown");
  }

  const userLat = query.lat;
  const userLng = query.lng;
  const relatedLimit = query.relatedLimit ?? 6;
  const reviewsLimit = query.reviewsLimit ?? 3;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC that returns all listing detail data
  const { data, error } = await supabase.rpc("get_bff_listing_detail", {
    p_listing_id: listingId,
    p_user_id: userId,
    p_user_lat: userLat || null,
    p_user_lng: userLng || null,
    p_related_limit: relatedLimit,
    p_reviews_limit: reviewsLimit,
  });

  if (error) {
    logger.error("Failed to fetch listing detail", new Error(error.message));
    throw new Error("Failed to fetch listing detail");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  if (!result.listing) {
    throw new NotFoundError("Listing", listingId);
  }

  // Transform listing data
  const listing = result.listing;
  const seller = result.seller;

  // Build user summary for seller
  const sellerSummary: UserSummary & {
    bio?: string;
    totalShares: number;
    responseRate: number;
    responseTimeMinutes: number;
  } = {
    id: seller.id,
    displayName: seller.display_name,
    avatarUrl: seller.avatar_url,
    rating: seller.rating_average || 0,
    reviewCount: seller.rating_count || 0,
    isVerified: seller.is_verified || false,
    memberSince: seller.created_at,
    bio: seller.bio,
    totalShares: seller.total_shares || 0,
    responseRate: seller.response_rate || 0,
    responseTimeMinutes: seller.response_time_minutes || 60,
  };

  // Transform images
  const images: ImageInfo[] = (listing.images || []).map((url: string, index: number) => ({
    url,
    thumbnailUrl: url.replace("/public/", "/public/thumbnails/"),
    blurhash: listing.blurhashes?.[index],
  }));

  // Build location
  const location: GeoLocation = {
    latitude: listing.latitude,
    longitude: listing.longitude,
    address: listing.pickup_address,
    city: listing.city,
    distanceKm: listing.distance_km,
  };

  // Build category
  const category: CategoryInfo | null = listing.category_id
    ? {
        id: listing.category_id,
        name: listing.category_name,
        icon: listing.category_icon,
        color: listing.category_color || "#808080",
      }
    : null;

  // Build listing summary for main listing
  const listingSummary: ListingSummary & {
    fullDescription: string;
    pickupInstructions?: string;
    dietaryTags: string[];
    allergens: string[];
    viewCount: number;
  } = {
    id: listing.id,
    title: listing.post_name,
    description: listing.post_description?.substring(0, 200) || "",
    fullDescription: listing.post_description || "",
    quantity: listing.quantity || 1,
    unit: listing.unit || "item",
    category: category!,
    images,
    location,
    expiresAt: listing.expires_at,
    status: listing.is_active
      ? "available"
      : listing.is_claimed
      ? "claimed"
      : "expired",
    createdAt: listing.created_at,
    user: {
      id: seller.id,
      displayName: seller.display_name,
      avatarUrl: seller.avatar_url,
      rating: seller.rating_average || 0,
      reviewCount: seller.rating_count || 0,
      isVerified: seller.is_verified || false,
      memberSince: seller.created_at,
    },
    isFavorited: result.is_favorited || false,
    favoriteCount: listing.favorite_count || 0,
    pickupInstructions: listing.pickup_instructions,
    dietaryTags: listing.dietary_tags || [],
    allergens: listing.allergens || [],
    viewCount: listing.view_count || 0,
  };

  // Transform related listings
  const relatedListings: ListingSummary[] = (result.related_listings || []).map(
    (item: Record<string, unknown>) => ({
      id: item.id as string,
      title: item.post_name as string,
      description: (item.post_description as string)?.substring(0, 100) || "",
      quantity: (item.quantity as number) || 1,
      unit: (item.unit as string) || "item",
      category: item.category_id
        ? {
            id: item.category_id as number,
            name: item.category_name as string,
            icon: item.category_icon as string,
            color: (item.category_color as string) || "#808080",
          }
        : null,
      images: ((item.images as string[]) || []).map((url) => ({ url })),
      location: {
        latitude: item.latitude as number,
        longitude: item.longitude as number,
        distanceKm: item.distance_km as number,
      },
      expiresAt: item.expires_at as string,
      status: "available" as const,
      createdAt: item.created_at as string,
      user: {
        id: item.owner_id as string,
        displayName: item.owner_name as string,
        avatarUrl: item.owner_avatar as string | undefined,
        rating: (item.owner_rating as number) || 0,
        reviewCount: 0,
        isVerified: false,
        memberSince: "",
      },
      isFavorited: false,
      favoriteCount: (item.favorite_count as number) || 0,
    })
  );

  // Transform recent reviews
  const recentReviews: ReviewSummary[] = (result.recent_reviews || []).map(
    (review: Record<string, unknown>) => ({
      id: review.id as string,
      rating: review.rating as number,
      comment: review.comment as string | undefined,
      createdAt: review.created_at as string,
      reviewer: {
        id: review.reviewer_id as string,
        displayName: review.reviewer_name as string,
        avatarUrl: review.reviewer_avatar as string | undefined,
        rating: 0,
        reviewCount: 0,
        isVerified: false,
        memberSince: "",
      },
      listingTitle: review.listing_title as string | undefined,
    })
  );

  // Build response
  const response: ListingDetailResponse = {
    listing: listingSummary,
    seller: sellerSummary,
    relatedListings,
    recentReviews,
    canContact: result.can_contact ?? (userId !== seller.id),
    canFavorite: result.can_favorite ?? (userId !== seller.id),
    canReport: result.can_report ?? (userId !== seller.id),
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(response, platform, {
    resourceType: "listing-detail",
    imageUseCase: "detail",
    includeCapabilities: true,
  });

  // Increment view count asynchronously (fire and forget)
  supabase
    .rpc("increment_listing_view", { p_listing_id: listingId, p_user_id: userId })
    .then(() => {})
    .catch((err) => logger.warn("Failed to increment view count", { error: err.message }));

  logger.info("Listing detail fetched", {
    listingId,
    userId,
    platform,
    relatedCount: relatedListings.length,
    reviewsCount: recentReviews.length,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-listing-detail",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: listingDetailQuerySchema,
      handler: handleGetListingDetail,
    },
  },
});
