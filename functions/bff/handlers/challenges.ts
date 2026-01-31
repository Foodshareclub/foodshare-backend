/**
 * BFF Challenges Handler
 *
 * Aggregates gamification challenges data:
 * - Active challenges with user progress
 * - Completed challenges history
 * - Upcoming challenges preview
 * - User stats and streaks
 * - Leaderboard rankings
 *
 * Reduces client round-trips from 4-5 calls to 1.
 *
 * NOTE: Translation is handled separately by iOS calling /localization/get-translations
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";
import type {
  ChallengesResponse,
  ChallengeSummary,
  ChallengeProgress,
  ChallengeReward,
  LeaderboardEntry,
  UserSummary,
} from "../_types/bff-responses.ts";

// =============================================================================
// Request Schema
// =============================================================================

const challengesQuerySchema = z.object({
  includeCompleted: z.string().transform((v) => v === "true").optional(),
  includeUpcoming: z.string().transform((v) => v === "true").optional(),
  includeLeaderboard: z.string().transform((v) => v === "true").optional(),
  leaderboardLimit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  completedLimit: z.string().transform(Number).pipe(z.number().int().min(1).max(20)).optional(),
});

type ChallengesQuery = z.infer<typeof challengesQuerySchema>;

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetChallenges(
  ctx: HandlerContext<unknown, ChallengesQuery>
): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const includeCompleted = query.includeCompleted ?? true;
  const includeUpcoming = query.includeUpcoming ?? true;
  const includeLeaderboard = query.includeLeaderboard ?? true;
  const leaderboardLimit = query.leaderboardLimit ?? 10;
  const completedLimit = query.completedLimit ?? 5;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC for challenges
  const { data, error } = await supabase.rpc("get_bff_challenges_data", {
    p_user_id: userId,
    p_include_completed: includeCompleted,
    p_include_upcoming: includeUpcoming,
    p_include_leaderboard: includeLeaderboard,
    p_leaderboard_limit: leaderboardLimit,
    p_completed_limit: completedLimit,
  });

  if (error) {
    logger.error("Failed to fetch challenges", new Error(error.message));
    throw new Error("Failed to fetch challenges");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Transform active challenges with progress
  const activeChallenges: (ChallengeSummary & { progress: ChallengeProgress })[] = (
    result.active_challenges || []
  ).map((c: Record<string, unknown>) => {
    const id = String(c.id);
    return {
      id,
      title: c.title as string,
      description: c.description as string,
      type: c.type as "daily" | "weekly" | "monthly" | "special",
      iconUrl: c.icon_url as string,
      startDate: c.start_date as string,
      endDate: c.end_date as string,
      isActive: true,
      reward: {
        points: c.reward_points as number,
        badgeId: c.badge_id as string | undefined,
        badgeName: c.badge_name as string | undefined,
        badgeIconUrl: c.badge_icon_url as string | undefined,
      } as ChallengeReward,
      progress: {
        challengeId: id,
        currentValue: c.current_value as number,
        targetValue: c.target_value as number,
        progressPercentage: Math.min(
          100,
          Math.round(((c.current_value as number) / (c.target_value as number)) * 100)
        ),
        isCompleted: (c.current_value as number) >= (c.target_value as number),
        completedAt: c.completed_at as string | undefined,
        claimedAt: c.claimed_at as string | undefined,
      } as ChallengeProgress,
    };
  });

  // Transform completed challenges
  const completedChallenges: (ChallengeSummary & { progress: ChallengeProgress })[] = (
    result.completed_challenges || []
  ).map((c: Record<string, unknown>) => {
    const id = String(c.id);
    return {
      id,
      title: c.title as string,
      description: c.description as string,
      type: c.type as "daily" | "weekly" | "monthly" | "special",
      iconUrl: c.icon_url as string,
      startDate: c.start_date as string,
      endDate: c.end_date as string,
      isActive: false,
      reward: {
        points: c.reward_points as number,
        badgeId: c.badge_id as string | undefined,
        badgeName: c.badge_name as string | undefined,
        badgeIconUrl: c.badge_icon_url as string | undefined,
      } as ChallengeReward,
      progress: {
        challengeId: id,
        currentValue: c.target_value as number,
        targetValue: c.target_value as number,
        progressPercentage: 100,
        isCompleted: true,
        completedAt: c.completed_at as string,
        claimedAt: c.claimed_at as string | undefined,
      } as ChallengeProgress,
    };
  });

  // Transform upcoming challenges
  const upcomingChallenges: ChallengeSummary[] = (result.upcoming_challenges || []).map(
    (c: Record<string, unknown>) => {
      const id = String(c.id);
      return {
        id,
        title: c.title as string,
        description: c.description as string,
        type: c.type as "daily" | "weekly" | "monthly" | "special",
        iconUrl: c.icon_url as string,
        startDate: c.start_date as string,
        endDate: c.end_date as string,
        isActive: false,
        reward: {
          points: c.reward_points as number,
          badgeId: c.badge_id as string | undefined,
          badgeName: c.badge_name as string | undefined,
          badgeIconUrl: c.badge_icon_url as string | undefined,
        } as ChallengeReward,
      };
    }
  );

  // Transform leaderboard
  const topUsers: LeaderboardEntry[] = (result.leaderboard || []).map(
    (entry: Record<string, unknown>, index: number) => ({
      rank: index + 1,
      user: {
        id: entry.user_id as string,
        displayName: entry.display_name as string,
        avatarUrl: entry.avatar_url as string | undefined,
        rating: (entry.rating as number) || 0,
        reviewCount: 0,
        isVerified: (entry.is_verified as boolean) || false,
        memberSince: entry.member_since as string,
      } as UserSummary,
      points: entry.points as number,
      challengesCompleted: entry.challenges_completed as number,
    })
  );

  // Get user's rank
  const userRank = result.user_rank as number | null;
  const totalParticipants = result.total_participants as number;

  // Build user stats
  const userStats = {
    totalChallengesCompleted: result.user_stats?.total_completed || 0,
    currentStreak: result.user_stats?.current_streak || 0,
    pointsEarned: result.user_stats?.points_earned || 0,
    badgesEarned: result.user_stats?.badges_earned || 0,
  };

  // Build response
  const response: ChallengesResponse = {
    activeChallenges,
    completedChallenges,
    upcomingChallenges,
    userStats,
    leaderboard: {
      rank: userRank || 0,
      totalParticipants: totalParticipants || 0,
      topUsers,
    },
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(response, platform, {
    resourceType: "challenges",
    imageUseCase: "icon",
    includeCapabilities: false,
  });

  logger.info("Challenges fetched", {
    userId,
    activeCount: activeChallenges.length,
    completedCount: completedChallenges.length,
    userRank,
    platform,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Claim Reward Handler
// =============================================================================

const claimRewardBodySchema = z.object({
  challengeId: z.string().uuid(),
});

async function handleClaimReward(
  ctx: HandlerContext<z.infer<typeof claimRewardBodySchema>>
): Promise<Response> {
  const { supabase, userId, body } = ctx;

  const { challengeId } = body;

  // Call RPC to claim reward
  const { data, error } = await supabase.rpc("claim_challenge_reward", {
    p_user_id: userId,
    p_challenge_id: challengeId,
  });

  if (error) {
    logger.error("Failed to claim reward", new Error(error.message));
    throw new Error(error.message || "Failed to claim reward");
  }

  const result = typeof data === "string" ? JSON.parse(data) : data;

  if (!result.success) {
    throw new Error(result.error || "Challenge not eligible for claiming");
  }

  logger.info("Reward claimed", {
    userId,
    challengeId,
    pointsAwarded: result.points_awarded,
    badgeAwarded: result.badge_id,
  });

  return ok({
    success: true,
    pointsAwarded: result.points_awarded,
    newTotalPoints: result.new_total_points,
    badge: result.badge_id
      ? {
          id: result.badge_id,
          name: result.badge_name,
          iconUrl: result.badge_icon_url,
        }
      : null,
  }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-challenges",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: challengesQuerySchema,
      handler: handleGetChallenges,
    },
    POST: {
      bodySchema: claimRewardBodySchema,
      handler: handleClaimReward,
    },
  },
});
