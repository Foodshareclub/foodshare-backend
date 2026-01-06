/**
 * BFF API Contract Schemas
 * Shared schema definitions for contract testing between clients and Edge Functions
 */

import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

// ================================
// Common Types
// ================================

export const PaginationSchema = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().min(0),
  hasMore: z.boolean(),
});

export const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export const SuccessResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

// ================================
// User Schemas
// ================================

export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(1),
  displayName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  bio: z.string().nullable(),
  location: z.string().nullable(),
  createdAt: z.string().datetime(),
  listingCount: z.number().int().min(0),
  reviewCount: z.number().int().min(0),
  averageRating: z.number().min(0).max(5).nullable(),
  badges: z.array(z.string()),
  level: z.number().int().min(1),
  xp: z.number().int().min(0),
});

export const UserProfileSummarySchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().url().nullable(),
  averageRating: z.number().min(0).max(5).nullable(),
});

// ================================
// Listing Schemas
// ================================

export const ListingStatusSchema = z.enum([
  'active',
  'pending',
  'completed',
  'expired',
  'cancelled',
]);

export const ListingConditionSchema = z.enum([
  'fresh',
  'good',
  'fair',
]);

export const FoodListingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(100),
  description: z.string().max(1000),
  quantity: z.string(),
  condition: ListingConditionSchema,
  expiryDate: z.string().datetime().nullable(),
  pickupLocation: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  imageUrls: z.array(z.string().url()),
  status: ListingStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  user: UserProfileSummarySchema,
  distance: z.number().min(0).optional(),
  isFavorited: z.boolean().optional(),
});

export const ListingDetailSchema = FoodListingSchema.extend({
  viewCount: z.number().int().min(0),
  favoriteCount: z.number().int().min(0),
  messageCount: z.number().int().min(0),
  relatedListings: z.array(FoodListingSchema.omit({ user: true })).optional(),
});

export const CreateListingRequestSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(1000),
  quantity: z.string().min(1),
  condition: ListingConditionSchema,
  expiryDate: z.string().datetime().optional(),
  pickupLocation: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  imageUrls: z.array(z.string().url()).min(1).max(5),
});

export const UpdateListingRequestSchema = CreateListingRequestSchema.partial();

// ================================
// Feed Schemas
// ================================

export const FeedFiltersSchema = z.object({
  condition: ListingConditionSchema.optional(),
  maxDistance: z.number().min(0).optional(),
  categories: z.array(z.string()).optional(),
  excludeExpired: z.boolean().optional(),
});

export const FeedRequestSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
  filters: FeedFiltersSchema.optional(),
});

export const FeedResponseSchema = z.object({
  listings: z.array(FoodListingSchema),
  pagination: PaginationSchema,
  nearbyCount: z.number().int().min(0),
});

// ================================
// Chat Schemas
// ================================

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  senderId: z.string().uuid(),
  content: z.string(),
  createdAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  type: z.enum(['text', 'image', 'system']),
});

export const ChatRoomSchema = z.object({
  id: z.string().uuid(),
  listingId: z.string().uuid().nullable(),
  participants: z.array(UserProfileSummarySchema),
  lastMessage: ChatMessageSchema.nullable(),
  unreadCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ChatRoomDetailSchema = ChatRoomSchema.extend({
  listing: FoodListingSchema.nullable(),
  messages: z.array(ChatMessageSchema),
});

// ================================
// Review Schemas
// ================================

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  reviewerId: z.string().uuid(),
  revieweeId: z.string().uuid(),
  listingId: z.string().uuid().nullable(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
  reviewer: UserProfileSummarySchema,
});

export const CreateReviewRequestSchema = z.object({
  revieweeId: z.string().uuid(),
  listingId: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
});

// ================================
// Search Schemas
// ================================

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radius: z.number().min(0).optional(),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
  filters: FeedFiltersSchema.optional(),
});

export const SearchSuggestionSchema = z.object({
  text: z.string(),
  type: z.enum(['query', 'category', 'location']),
  count: z.number().int().min(0).optional(),
});

export const SearchResponseSchema = z.object({
  results: z.array(FoodListingSchema),
  suggestions: z.array(SearchSuggestionSchema),
  pagination: PaginationSchema,
  queryTime: z.number().min(0),
});

// ================================
// Notification Schemas
// ================================

export const NotificationTypeSchema = z.enum([
  'message',
  'listing_interest',
  'review_received',
  'listing_expired',
  'badge_earned',
  'challenge_completed',
  'system',
]);

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: NotificationTypeSchema,
  title: z.string(),
  body: z.string(),
  data: z.record(z.unknown()).optional(),
  read: z.boolean(),
  createdAt: z.string().datetime(),
});

export const NotificationsResponseSchema = z.object({
  notifications: z.array(NotificationSchema),
  unreadCount: z.number().int().min(0),
  pagination: PaginationSchema,
});

// ================================
// Forum Schemas
// ================================

export const ForumCategorySchema = z.enum([
  'general',
  'tips',
  'recipes',
  'sustainability',
  'announcements',
]);

export const ForumPostSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  category: ForumCategorySchema,
  imageUrls: z.array(z.string().url()),
  likeCount: z.number().int().min(0),
  commentCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  author: UserProfileSummarySchema,
  isLiked: z.boolean().optional(),
});

export const ForumCommentSchema = z.object({
  id: z.string().uuid(),
  postId: z.string().uuid(),
  authorId: z.string().uuid(),
  content: z.string().min(1).max(2000),
  likeCount: z.number().int().min(0),
  createdAt: z.string().datetime(),
  author: UserProfileSummarySchema,
  isLiked: z.boolean().optional(),
});

// ================================
// Gamification Schemas
// ================================

export const BadgeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  iconUrl: z.string().url(),
  earnedAt: z.string().datetime().nullable(),
  progress: z.number().min(0).max(1),
});

export const ChallengeSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  type: z.enum(['daily', 'weekly', 'monthly', 'special']),
  targetValue: z.number().int().min(1),
  currentValue: z.number().int().min(0),
  xpReward: z.number().int().min(0),
  badgeReward: z.string().nullable(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  isCompleted: z.boolean(),
});

export const LeaderboardEntrySchema = z.object({
  rank: z.number().int().min(1),
  user: UserProfileSummarySchema,
  score: z.number().int().min(0),
  change: z.number().int(),
});

// ================================
// Export Types
// ================================

export type Pagination = z.infer<typeof PaginationSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UserProfileSummary = z.infer<typeof UserProfileSummarySchema>;
export type FoodListing = z.infer<typeof FoodListingSchema>;
export type ListingDetail = z.infer<typeof ListingDetailSchema>;
export type CreateListingRequest = z.infer<typeof CreateListingRequestSchema>;
export type FeedRequest = z.infer<typeof FeedRequestSchema>;
export type FeedResponse = z.infer<typeof FeedResponseSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatRoom = z.infer<typeof ChatRoomSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type ForumPost = z.infer<typeof ForumPostSchema>;
export type ForumComment = z.infer<typeof ForumCommentSchema>;
export type Badge = z.infer<typeof BadgeSchema>;
export type Challenge = z.infer<typeof ChallengeSchema>;
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
