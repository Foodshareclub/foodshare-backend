/**
 * BFF Response Types
 *
 * Unified type definitions for BFF aggregated responses.
 * Ensures consistency across iOS, Android, and Web clients.
 */

// =============================================================================
// Common Types
// =============================================================================

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  address?: string;
  city?: string;
  distanceKm?: number;
}

export interface UserSummary {
  id: string;
  displayName: string;
  avatarUrl?: string;
  rating: number;
  reviewCount: number;
  isVerified: boolean;
  memberSince: string;
}

export interface ImageInfo {
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  blurhash?: string;
}

// =============================================================================
// Listing Types
// =============================================================================

export interface ListingSummary {
  id: string;
  title: string;
  description: string;
  quantity: number;
  unit: string;
  category: CategoryInfo;
  images: ImageInfo[];
  location: GeoLocation;
  expiresAt?: string;
  status: "available" | "reserved" | "claimed" | "expired";
  createdAt: string;
  user: UserSummary;
  isFavorited: boolean;
  favoriteCount: number;
}

export interface CategoryInfo {
  id: number;
  name: string;
  icon: string;
  color: string;
}

export interface ListingDetailResponse {
  listing: ListingSummary & {
    fullDescription: string;
    pickupInstructions?: string;
    dietaryTags: string[];
    allergens: string[];
    viewCount: number;
  };
  seller: UserSummary & {
    bio?: string;
    totalShares: number;
    responseRate: number;
    responseTimeMinutes: number;
  };
  relatedListings: ListingSummary[];
  recentReviews: ReviewSummary[];
  canContact: boolean;
  canFavorite: boolean;
  canReport: boolean;
}

// =============================================================================
// Search Types
// =============================================================================

export interface SearchFilters {
  query?: string;
  categoryIds?: number[];
  dietaryTags?: string[];
  maxDistanceKm?: number;
  latitude?: number;
  longitude?: number;
  sortBy?: "relevance" | "distance" | "newest" | "expiring";
  status?: "available" | "all";
}

export interface SearchSuggestion {
  text: string;
  type: "query" | "category" | "dietary" | "recent";
  count?: number;
}

export interface SearchResponse {
  results: ListingSummary[];
  pagination: PaginationMeta;
  filters: SearchFilters;
  suggestions: SearchSuggestion[];
  facets: {
    categories: { id: number; name: string; count: number }[];
    dietaryTags: { tag: string; count: number }[];
  };
  meta: {
    searchTimeMs: number;
    totalMatches: number;
  };
}

// =============================================================================
// Challenge Types
// =============================================================================

export interface ChallengeSummary {
  id: string;
  title: string;
  description: string;
  type: "daily" | "weekly" | "monthly" | "special";
  iconUrl: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  reward: ChallengeReward;
}

export interface ChallengeReward {
  points: number;
  badgeId?: string;
  badgeName?: string;
  badgeIconUrl?: string;
}

export interface ChallengeProgress {
  challengeId: string;
  currentValue: number;
  targetValue: number;
  progressPercentage: number;
  isCompleted: boolean;
  completedAt?: string;
  claimedAt?: string;
}

export interface ChallengesResponse {
  activeChallenges: (ChallengeSummary & { progress: ChallengeProgress })[];
  completedChallenges: (ChallengeSummary & { progress: ChallengeProgress })[];
  upcomingChallenges: ChallengeSummary[];
  userStats: {
    totalChallengesCompleted: number;
    currentStreak: number;
    pointsEarned: number;
    badgesEarned: number;
  };
  leaderboard: {
    rank: number;
    totalParticipants: number;
    topUsers: LeaderboardEntry[];
  };
}

export interface LeaderboardEntry {
  rank: number;
  user: UserSummary;
  points: number;
  challengesCompleted: number;
}

// =============================================================================
// Notification Types
// =============================================================================

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  imageUrl?: string;
  data: Record<string, string>;
  isRead: boolean;
  createdAt: string;
  action?: NotificationAction;
}

export type NotificationType =
  | "message"
  | "listing_interest"
  | "listing_claimed"
  | "listing_expired"
  | "review_received"
  | "badge_earned"
  | "challenge_complete"
  | "system"
  | "promotion";

export interface NotificationAction {
  type: "navigate" | "deep_link" | "web_url";
  destination: string;
}

export interface NotificationGroup {
  date: string;
  notifications: NotificationItem[];
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
  grouped: NotificationGroup[];
  pagination: PaginationMeta;
  unreadCount: number;
  settings: NotificationSettings;
}

export interface NotificationSettings {
  pushEnabled: boolean;
  emailEnabled: boolean;
  categories: {
    messages: boolean;
    listings: boolean;
    reviews: boolean;
    challenges: boolean;
    promotions: boolean;
  };
}

// =============================================================================
// Review Types
// =============================================================================

export interface ReviewSummary {
  id: string;
  rating: number;
  comment?: string;
  createdAt: string;
  reviewer: UserSummary;
  listingTitle?: string;
}

// =============================================================================
// Feed Types (extending existing)
// =============================================================================

export interface FeedResponse {
  listings: ListingSummary[];
  pagination: PaginationMeta;
  highlights: {
    nearbyCount: number;
    expiringCount: number;
    newToday: number;
  };
  categories: CategoryInfo[];
  promotedListings?: ListingSummary[];
}

// =============================================================================
// Dashboard Types (extending existing)
// =============================================================================

export interface DashboardResponse {
  user: UserSummary & {
    email: string;
    points: number;
    level: number;
    levelProgress: number;
    badges: BadgeSummary[];
  };
  stats: {
    totalShares: number;
    totalReceived: number;
    activeListings: number;
    unreadMessages: number;
    pendingReviews: number;
  };
  recentActivity: ActivityItem[];
  quickActions: QuickAction[];
}

export interface BadgeSummary {
  id: string;
  name: string;
  iconUrl: string;
  earnedAt: string;
}

export interface ActivityItem {
  id: string;
  type: "share" | "receive" | "review" | "badge" | "challenge";
  title: string;
  description: string;
  timestamp: string;
  points?: number;
}

export interface QuickAction {
  id: string;
  title: string;
  icon: string;
  action: string;
  badge?: number;
}

// =============================================================================
// Profile Types (extending existing)
// =============================================================================

export interface ProfileResponse {
  user: UserSummary & {
    bio?: string;
    location?: GeoLocation;
    joinDate: string;
    lastActiveAt: string;
  };
  stats: {
    totalShares: number;
    totalReceived: number;
    totalReviews: number;
    averageRating: number;
    responseRate: number;
  };
  listings: ListingSummary[];
  reviews: ReviewSummary[];
  badges: BadgeSummary[];
  isOwnProfile: boolean;
  isFollowing?: boolean;
}

// =============================================================================
// Messages Types (extending existing)
// =============================================================================

export interface MessagesResponse {
  rooms: ChatRoomSummary[];
  pagination: PaginationMeta;
  unreadTotal: number;
}

export interface ChatRoomSummary {
  id: string;
  participant: UserSummary;
  listing?: {
    id: string;
    title: string;
    imageUrl?: string;
  };
  lastMessage: {
    content: string;
    sentAt: string;
    isFromMe: boolean;
  };
  unreadCount: number;
  updatedAt: string;
}

// =============================================================================
// Error Response
// =============================================================================

export interface BFFErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    requestId: string;
    timestamp: string;
  };
}

// =============================================================================
// Success Response Wrapper
// =============================================================================

export interface BFFSuccessResponse<T> {
  success: true;
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
    responseTimeMs: number;
    cacheHit?: boolean;
  };
}

export type BFFResponse<T> = BFFSuccessResponse<T> | BFFErrorResponse;
