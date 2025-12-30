/**
 * BFF Dashboard Handler
 *
 * Aggregates dashboard data for the user:
 * - User profile and stats
 * - Unread counts (notifications, messages)
 * - Recent activity
 * - Impact metrics (food shared, CO2 saved, etc.)
 *
 * Reduces client round-trips from 4-5 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";

// =============================================================================
// Request Schema
// =============================================================================

const dashboardQuerySchema = z.object({
  includeListings: z.string().transform((v) => v === "true").optional(),
  listingsLimit: z.string().transform(Number).pipe(z.number().int().min(1).max(10)).optional(),
});

type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UserProfile {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  bio: string | null;
  location: {
    lat: number | null;
    lng: number | null;
    city: string | null;
  };
  createdAt: string;
  isVerified: boolean;
}

interface UserStats {
  itemsShared: number;
  itemsReceived: number;
  activeListings: number;
  rating: number | null;
  ratingCount: number;
  completedTransactions: number;
}

interface ImpactMetrics {
  foodSavedKg: number;
  co2SavedKg: number;
  mealsProvided: number;
  monthlyRank: number | null;
}

interface UnreadCounts {
  notifications: number;
  messages: number;
  pendingRequests: number;
}

interface RecentListing {
  id: string;
  title: string;
  image: string;
  status: "active" | "completed" | "expired";
  viewCount: number;
  createdAt: string;
}

interface DashboardResponse {
  user: UserProfile;
  stats: UserStats;
  impact: ImpactMetrics;
  counts: UnreadCounts;
  recentListings: RecentListing[];
  badges: string[];
  lastActive: string;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetDashboard(ctx: HandlerContext<unknown, DashboardQuery>): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const includeListings = query.includeListings ?? true;
  const listingsLimit = query.listingsLimit ?? 5;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC that returns all dashboard data
  const { data, error } = await supabase.rpc("get_user_dashboard", {
    p_user_id: userId,
    p_include_listings: includeListings,
    p_listings_limit: listingsLimit,
  });

  if (error) {
    logger.error("Failed to fetch dashboard data", new Error(error.message));
    throw new Error("Failed to fetch dashboard");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Transform to response format
  const dashboardResponse: DashboardResponse = {
    user: {
      id: result.profile.id,
      displayName: result.profile.display_name,
      email: result.profile.email,
      avatarUrl: result.profile.avatar_url,
      bio: result.profile.bio,
      location: {
        lat: result.profile.latitude,
        lng: result.profile.longitude,
        city: result.profile.city,
      },
      createdAt: result.profile.created_at,
      isVerified: result.profile.is_verified || false,
    },
    stats: {
      itemsShared: result.stats.items_shared || 0,
      itemsReceived: result.stats.items_received || 0,
      activeListings: result.stats.active_listings || 0,
      rating: result.stats.rating_average,
      ratingCount: result.stats.rating_count || 0,
      completedTransactions: result.stats.completed_transactions || 0,
    },
    impact: {
      foodSavedKg: result.impact?.food_saved_kg || 0,
      co2SavedKg: result.impact?.co2_saved_kg || 0,
      mealsProvided: result.impact?.meals_provided || 0,
      monthlyRank: result.impact?.monthly_rank,
    },
    counts: {
      notifications: result.unread_notifications || 0,
      messages: result.unread_messages || 0,
      pendingRequests: result.pending_requests || 0,
    },
    recentListings: (result.recent_listings || []).map((listing: Record<string, unknown>) => ({
      id: listing.id,
      title: listing.post_name,
      image: Array.isArray(listing.images) ? listing.images[0] : null,
      status: listing.is_active ? "active" : listing.expires_at && new Date(listing.expires_at as string) < new Date() ? "expired" : "completed",
      viewCount: listing.view_count || 0,
      createdAt: listing.created_at,
    })),
    badges: result.badges || [],
    lastActive: result.last_active || new Date().toISOString(),
  };

  // Apply platform-specific transforms with dashboard-specific options
  const platformResponse = transformForPlatform(dashboardResponse, platform, {
    resourceType: "dashboard",
    imageUseCase: "thumbnail",
    includeCapabilities: true,
  });

  logger.info("Dashboard fetched", {
    userId,
    platform,
    includeListings,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-dashboard",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: dashboardQuerySchema,
      handler: handleGetDashboard,
    },
  },
});
