/**
 * RPC Contract Schemas
 * Schema definitions for Supabase RPC function contracts
 */

import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

// ================================
// Location RPC Schemas
// ================================

export const NearbyListingsRequestSchema = z.object({
  user_lat: z.number().min(-90).max(90),
  user_lng: z.number().min(-180).max(180),
  radius_km: z.number().min(0).max(500).default(10),
  max_results: z.number().int().min(1).max(100).default(20),
});

export const NearbyListingResultSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  distance_km: z.number(),
  user_id: z.string().uuid(),
  username: z.string(),
  avatar_url: z.string().nullable(),
  image_urls: z.array(z.string()),
  condition: z.string(),
  created_at: z.string(),
});

// ================================
// Matching RPC Schemas
// ================================

export const MatchScoreRequestSchema = z.object({
  user_id: z.string().uuid(),
  listing_id: z.string().uuid(),
});

export const MatchScoreResultSchema = z.object({
  score: z.number().min(0).max(100),
  factors: z.object({
    distance: z.number(),
    category_preference: z.number(),
    time_preference: z.number(),
    past_interactions: z.number(),
  }),
});

export const RecommendedListingsRequestSchema = z.object({
  user_id: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  limit: z.number().int().min(1).max(50).default(10),
});

// ================================
// Statistics RPC Schemas
// ================================

export const UserStatsRequestSchema = z.object({
  user_id: z.string().uuid(),
});

export const UserStatsResultSchema = z.object({
  total_listings: z.number().int(),
  active_listings: z.number().int(),
  completed_listings: z.number().int(),
  total_messages_sent: z.number().int(),
  total_messages_received: z.number().int(),
  reviews_given: z.number().int(),
  reviews_received: z.number().int(),
  average_rating: z.number().nullable(),
  total_xp: z.number().int(),
  current_level: z.number().int(),
  badges_earned: z.number().int(),
  food_saved_kg: z.number(),
  co2_saved_kg: z.number(),
  member_since: z.string(),
});

export const PlatformStatsResultSchema = z.object({
  total_users: z.number().int(),
  total_listings: z.number().int(),
  active_listings: z.number().int(),
  completed_transactions: z.number().int(),
  total_food_saved_kg: z.number(),
  total_co2_saved_kg: z.number(),
  listings_today: z.number().int(),
  new_users_today: z.number().int(),
});

// ================================
// Gamification RPC Schemas
// ================================

export const AwardXPRequestSchema = z.object({
  user_id: z.string().uuid(),
  xp_amount: z.number().int().min(1),
  reason: z.string(),
  source_type: z.enum(['listing', 'review', 'challenge', 'badge', 'bonus']),
  source_id: z.string().uuid().optional(),
});

export const AwardXPResultSchema = z.object({
  success: z.boolean(),
  new_total_xp: z.number().int(),
  new_level: z.number().int(),
  level_up: z.boolean(),
  badges_earned: z.array(z.string()),
});

export const CheckBadgeEligibilityRequestSchema = z.object({
  user_id: z.string().uuid(),
  badge_id: z.string(),
});

export const CheckBadgeEligibilityResultSchema = z.object({
  eligible: z.boolean(),
  progress: z.number().min(0).max(1),
  requirements_met: z.array(z.string()),
  requirements_pending: z.array(z.string()),
});

export const LeaderboardRequestSchema = z.object({
  type: z.enum(['xp', 'listings', 'reviews', 'food_saved']),
  period: z.enum(['weekly', 'monthly', 'all_time']),
  limit: z.number().int().min(1).max(100).default(10),
});

export const LeaderboardResultSchema = z.object({
  entries: z.array(z.object({
    rank: z.number().int(),
    user_id: z.string().uuid(),
    username: z.string(),
    avatar_url: z.string().nullable(),
    score: z.number(),
  })),
  user_rank: z.number().int().nullable(),
  user_score: z.number().nullable(),
});

// ================================
// Search RPC Schemas
// ================================

export const FullTextSearchRequestSchema = z.object({
  query: z.string().min(1),
  user_lat: z.number().min(-90).max(90).optional(),
  user_lng: z.number().min(-180).max(180).optional(),
  radius_km: z.number().min(0).optional(),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});

export const SearchResultSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  rank: z.number(),
  distance_km: z.number().nullable(),
  image_url: z.string().nullable(),
  user_id: z.string().uuid(),
  username: z.string(),
});

export const SearchSuggestionsRequestSchema = z.object({
  prefix: z.string().min(1),
  limit: z.number().int().min(1).max(10).default(5),
});

export const SearchSuggestionResultSchema = z.object({
  suggestion: z.string(),
  type: z.enum(['title', 'category', 'location']),
  count: z.number().int(),
});

// ================================
// Notification RPC Schemas
// ================================

export const MarkNotificationsReadRequestSchema = z.object({
  user_id: z.string().uuid(),
  notification_ids: z.array(z.string().uuid()).optional(),
  mark_all: z.boolean().default(false),
});

export const MarkNotificationsReadResultSchema = z.object({
  updated_count: z.number().int(),
});

export const UnreadNotificationCountRequestSchema = z.object({
  user_id: z.string().uuid(),
});

export const UnreadNotificationCountResultSchema = z.object({
  count: z.number().int(),
});

// ================================
// Chat RPC Schemas
// ================================

export const GetOrCreateChatRoomRequestSchema = z.object({
  user1_id: z.string().uuid(),
  user2_id: z.string().uuid(),
  listing_id: z.string().uuid().optional(),
});

export const GetOrCreateChatRoomResultSchema = z.object({
  room_id: z.string().uuid(),
  created: z.boolean(),
});

export const MarkMessagesReadRequestSchema = z.object({
  room_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const MarkMessagesReadResultSchema = z.object({
  updated_count: z.number().int(),
});

// ================================
// Moderation RPC Schemas
// ================================

export const ReportContentRequestSchema = z.object({
  reporter_id: z.string().uuid(),
  content_type: z.enum(['listing', 'message', 'review', 'forum_post', 'profile']),
  content_id: z.string().uuid(),
  reason: z.enum([
    'hate_speech',
    'harassment',
    'violence',
    'nsfw',
    'fraud',
    'spam',
    'inappropriate',
    'other',
  ]),
  details: z.string().max(1000).optional(),
});

export const ReportContentResultSchema = z.object({
  report_id: z.string().uuid(),
  status: z.enum(['submitted', 'duplicate', 'rejected']),
  message: z.string(),
});

export const CheckUserModerationStatusRequestSchema = z.object({
  user_id: z.string().uuid(),
});

export const CheckUserModerationStatusResultSchema = z.object({
  is_shadowbanned: z.boolean(),
  warning_count: z.number().int(),
  restriction_level: z.enum(['none', 'limited', 'restricted', 'suspended']),
  restrictions: z.array(z.string()),
});

// ================================
// Sync RPC Schemas
// ================================

export const GetSyncStatusRequestSchema = z.object({
  user_id: z.string().uuid(),
  entity_type: z.enum([
    'listings',
    'messages',
    'notifications',
    'favorites',
    'reviews',
  ]),
  last_sync_version: z.number().int().min(0),
});

export const SyncChangeSchema = z.object({
  id: z.string().uuid(),
  operation: z.enum(['insert', 'update', 'delete']),
  version: z.number().int(),
  data: z.record(z.unknown()).nullable(),
  timestamp: z.string().datetime(),
});

export const GetSyncStatusResultSchema = z.object({
  current_version: z.number().int(),
  changes: z.array(SyncChangeSchema),
  has_more: z.boolean(),
});

// ================================
// Export Types
// ================================

export type NearbyListingsRequest = z.infer<typeof NearbyListingsRequestSchema>;
export type NearbyListingResult = z.infer<typeof NearbyListingResultSchema>;
export type MatchScoreRequest = z.infer<typeof MatchScoreRequestSchema>;
export type MatchScoreResult = z.infer<typeof MatchScoreResultSchema>;
export type UserStatsRequest = z.infer<typeof UserStatsRequestSchema>;
export type UserStatsResult = z.infer<typeof UserStatsResultSchema>;
export type PlatformStatsResult = z.infer<typeof PlatformStatsResultSchema>;
export type AwardXPRequest = z.infer<typeof AwardXPRequestSchema>;
export type AwardXPResult = z.infer<typeof AwardXPResultSchema>;
export type LeaderboardRequest = z.infer<typeof LeaderboardRequestSchema>;
export type LeaderboardResult = z.infer<typeof LeaderboardResultSchema>;
export type FullTextSearchRequest = z.infer<typeof FullTextSearchRequestSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type ReportContentRequest = z.infer<typeof ReportContentRequestSchema>;
export type ReportContentResult = z.infer<typeof ReportContentResultSchema>;
export type GetSyncStatusRequest = z.infer<typeof GetSyncStatusRequestSchema>;
export type GetSyncStatusResult = z.infer<typeof GetSyncStatusResultSchema>;
