/**
 * match-users Edge Function
 *
 * Finds nearby users with food items and returns compatibility scores.
 * All scoring logic moved to PostgreSQL RPC for thick server architecture.
 *
 * Usage from iOS/Android/Web:
 * POST /match-users
 * Authorization: Bearer <jwt>
 * Body: { latitude, longitude, dietaryPreferences?, radiusKm?, limit? }
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Request Schema
// =============================================================================

const matchUsersSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  dietaryPreferences: z.array(z.string()).default([]),
  radiusKm: z.number().min(1).max(1000).default(10),
  limit: z.number().int().min(1).max(50).default(20),
});

type MatchUsersRequest = z.infer<typeof matchUsersSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UserMatch {
  userId: string;
  username: string;
  avatarUrl: string | null;
  distanceKm: number;
  compatibilityScore: number;
  distanceScore: number;
  activityScore: number;
  ratingScore: number;
  prefsScore: number;
  sharedItemsCount: number;
  ratingAverage: number;
  commonPreferences: string[];
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleMatchUsers(ctx: HandlerContext<MatchUsersRequest>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  // Call PostgreSQL RPC for all scoring/filtering/sorting
  const { data: matches, error: rpcError } = await supabase.rpc(
    "calculate_user_matches",
    {
      p_user_id: userId,
      p_latitude: body.latitude,
      p_longitude: body.longitude,
      p_dietary_preferences: body.dietaryPreferences,
      p_radius_km: body.radiusKm,
      p_limit: body.limit,
    }
  );

  if (rpcError) {
    logger.error("RPC error calculating user matches", new Error(rpcError.message));
    throw new Error("Failed to calculate matches");
  }

  // Transform RPC results to camelCase response format
  const formattedMatches: UserMatch[] = (matches || []).map((match: Record<string, unknown>) => ({
    userId: match.user_id as string,
    username: match.username as string,
    avatarUrl: match.avatar_url as string | null,
    distanceKm: Number(match.distance_km),
    compatibilityScore: match.compatibility_score as number,
    distanceScore: match.distance_score as number,
    activityScore: match.activity_score as number,
    ratingScore: match.rating_score as number,
    prefsScore: match.prefs_score as number,
    sharedItemsCount: Number(match.shared_items_count),
    ratingAverage: Number(match.rating_average),
    commonPreferences: (match.common_preferences as string[]) || [],
  }));

  return ok({
    matches: formattedMatches,
    totalMatches: formattedMatches.length,
    userLocation: { latitude: body.latitude, longitude: body.longitude },
    radiusKm: body.radiusKm,
  }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "match-users",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 matches requests per minute
    keyBy: "user",
  },
  routes: {
    POST: {
      schema: matchUsersSchema,
      handler: handleMatchUsers,
    },
  },
});
