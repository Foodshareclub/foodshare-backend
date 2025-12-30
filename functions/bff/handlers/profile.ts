/**
 * BFF Profile Handler
 *
 * Aggregates profile data for user profile screens:
 * - User profile with stats
 * - User's listings (active and completed)
 * - Reviews received
 * - Impact metrics
 * - Badges earned
 *
 * Reduces client round-trips from 5-6 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { NotFoundError } from "../../_shared/errors.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";

// =============================================================================
// Request Schema
// =============================================================================

const profileQuerySchema = z.object({
  profileId: z.string().uuid().optional(), // If not provided, returns current user's profile
  includeListings: z.string().transform((v) => v === "true").optional(),
  includeReviews: z.string().transform((v) => v === "true").optional(),
  listingsLimit: z.string().transform(Number).pipe(z.number().int().min(1).max(20)).optional(),
  reviewsLimit: z.string().transform(Number).pipe(z.number().int().min(1).max(20)).optional(),
});

type ProfileQuery = z.infer<typeof profileQuerySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  location: {
    city: string | null;
    approximate: boolean;
  };
  isVerified: boolean;
  createdAt: string;
  isOwnProfile: boolean;
}

interface ProfileStats {
  itemsShared: number;
  itemsReceived: number;
  activeListings: number;
  rating: number | null;
  ratingCount: number;
  completedTransactions: number;
  responseRate: number | null;
  responseTimeMinutes: number | null;
}

interface ImpactMetrics {
  foodSavedKg: number;
  co2SavedKg: number;
  mealsProvided: number;
  monthlyRank: number | null;
}

interface ProfileListing {
  id: string;
  title: string;
  image: string | null;
  status: "active" | "completed" | "expired";
  viewCount: number;
  createdAt: string;
  expiresAt: string | null;
}

interface ProfileReview {
  id: string;
  rating: number;
  comment: string | null;
  reviewer: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  };
  transactionType: "shared" | "received";
  createdAt: string;
}

interface ProfileResponse {
  profile: UserProfile;
  stats: ProfileStats;
  impact: ImpactMetrics;
  badges: string[];
  listings: ProfileListing[];
  reviews: ProfileReview[];
  hasMoreListings: boolean;
  hasMoreReviews: boolean;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetProfile(ctx: HandlerContext<unknown, ProfileQuery>): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const targetProfileId = query.profileId || userId;
  const isOwnProfile = targetProfileId === userId;
  const includeListings = query.includeListings ?? true;
  const includeReviews = query.includeReviews ?? true;
  const listingsLimit = query.listingsLimit ?? 6;
  const reviewsLimit = query.reviewsLimit ?? 5;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC that returns all profile data
  const { data, error } = await supabase.rpc("get_bff_profile_data", {
    p_profile_id: targetProfileId,
    p_viewer_id: userId,
    p_include_listings: includeListings,
    p_include_reviews: includeReviews,
    p_listings_limit: listingsLimit + 1, // +1 for pagination check
    p_reviews_limit: reviewsLimit + 1,
  });

  if (error) {
    logger.error("Failed to fetch profile data", new Error(error.message));
    throw new Error("Failed to fetch profile");
  }

  if (!data || !data.profile) {
    throw new NotFoundError("Profile", targetProfileId || "current user");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Check pagination
  const listings = result.listings || [];
  const reviews = result.reviews || [];
  const hasMoreListings = listings.length > listingsLimit;
  const hasMoreReviews = reviews.length > reviewsLimit;

  // Transform to response format
  const profileResponse: ProfileResponse = {
    profile: {
      id: result.profile.id,
      displayName: result.profile.display_name,
      avatarUrl: result.profile.avatar_url,
      bio: result.profile.bio,
      location: {
        city: result.profile.city,
        approximate: !isOwnProfile, // Hide exact location for other users
      },
      isVerified: result.profile.is_verified || false,
      createdAt: result.profile.created_at,
      isOwnProfile,
    },
    stats: {
      itemsShared: result.stats?.items_shared || 0,
      itemsReceived: result.stats?.items_received || 0,
      activeListings: result.stats?.active_listings || 0,
      rating: result.stats?.rating_average,
      ratingCount: result.stats?.rating_count || 0,
      completedTransactions: result.stats?.completed_transactions || 0,
      responseRate: result.stats?.response_rate,
      responseTimeMinutes: result.stats?.response_time_minutes,
    },
    impact: {
      foodSavedKg: result.impact?.food_saved_kg || 0,
      co2SavedKg: result.impact?.co2_saved_kg || 0,
      mealsProvided: result.impact?.meals_provided || 0,
      monthlyRank: result.impact?.monthly_rank,
    },
    badges: result.badges || [],
    listings: (hasMoreListings ? listings.slice(0, -1) : listings).map(
      (listing: Record<string, unknown>) => ({
        id: listing.id,
        title: listing.post_name,
        image: Array.isArray(listing.images) ? listing.images[0] : null,
        status: listing.is_active
          ? "active"
          : listing.expires_at && new Date(listing.expires_at as string) < new Date()
            ? "expired"
            : "completed",
        viewCount: listing.view_count || 0,
        createdAt: listing.created_at,
        expiresAt: listing.expires_at,
      })
    ),
    reviews: (hasMoreReviews ? reviews.slice(0, -1) : reviews).map(
      (review: Record<string, unknown>) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        reviewer: {
          id: review.reviewer_id,
          displayName: review.reviewer_name,
          avatarUrl: review.reviewer_avatar,
        },
        transactionType: review.transaction_type || "shared",
        createdAt: review.created_at,
      })
    ),
    hasMoreListings,
    hasMoreReviews,
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(profileResponse, platform);

  logger.info("Profile fetched", {
    targetProfileId,
    isOwnProfile,
    platform,
    includeListings,
    includeReviews,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-profile",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: profileQuerySchema,
      handler: handleGetProfile,
    },
  },
});
