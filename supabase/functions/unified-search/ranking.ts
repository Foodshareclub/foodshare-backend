/**
 * Search Result Ranking
 *
 * Intelligent ranking of search results based on relevance,
 * location, recency, and user preferences.
 */

// Ranking configuration
export interface RankingConfig {
  userLocation?: {
    latitude: number;
    longitude: number;
  };
  userId?: string;
  boostRecent?: boolean;
  boostNearby?: boolean;
  boostHighRated?: boolean;
  diversityFactor?: number;
  personalizeResults?: boolean;
}

// Ranking weights
interface RankingWeights {
  textRelevance: number;
  proximity: number;
  recency: number;
  rating: number;
  popularity: number;
  personalization: number;
}

const DEFAULT_WEIGHTS: RankingWeights = {
  textRelevance: 0.35,
  proximity: 0.25,
  recency: 0.15,
  rating: 0.10,
  popularity: 0.10,
  personalization: 0.05,
};

// Search result item interface
interface SearchResultItem {
  id: string;
  type: "listing" | "user";
  title: string;
  subtitle?: string;
  imageUrl?: string;
  distance?: number;
  score?: number;
  highlights?: Record<string, string>;
  data: Record<string, unknown>;
}

// Score breakdown for debugging
interface ScoreBreakdown {
  textRelevance: number;
  proximity: number;
  recency: number;
  rating: number;
  popularity: number;
  personalization: number;
  final: number;
}

/**
 * Rank search results based on multiple factors.
 */
export async function rankResults(
  results: SearchResultItem[],
  query: string,
  config: RankingConfig,
  supabase: any
): Promise<SearchResultItem[]> {
  if (results.length === 0) return results;

  // Get user preferences if personalizing
  let userPreferences: UserPreferences | null = null;
  if (config.personalizeResults && config.userId) {
    userPreferences = await getUserPreferences(supabase, config.userId);
  }

  // Calculate scores for each result
  const scoredResults = results.map((result) => {
    const scores = calculateScores(result, query, config, userPreferences);
    const finalScore = calculateFinalScore(scores, getWeights(config));

    return {
      ...result,
      score: finalScore,
      _scoreBreakdown: scores,
    };
  });

  // Sort by score
  scoredResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Apply diversity if configured
  if (config.diversityFactor && config.diversityFactor > 0) {
    return applyDiversity(scoredResults, config.diversityFactor);
  }

  return scoredResults;
}

/**
 * Calculate individual scores for a result.
 */
function calculateScores(
  result: SearchResultItem,
  query: string,
  config: RankingConfig,
  userPreferences: UserPreferences | null
): ScoreBreakdown {
  return {
    textRelevance: calculateTextRelevance(result, query),
    proximity: calculateProximityScore(result, config.userLocation),
    recency: calculateRecencyScore(result),
    rating: calculateRatingScore(result),
    popularity: calculatePopularityScore(result),
    personalization: calculatePersonalizationScore(result, userPreferences),
    final: 0, // Calculated later
  };
}

/**
 * Calculate text relevance score.
 */
function calculateTextRelevance(result: SearchResultItem, query: string): number {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

  let score = 0;
  const title = result.title.toLowerCase();
  const subtitle = result.subtitle?.toLowerCase() ?? "";
  const description = (result.data.description as string)?.toLowerCase() ?? "";

  // Exact title match (highest weight)
  if (title === queryLower) {
    score += 1.0;
  }
  // Title contains query
  else if (title.includes(queryLower)) {
    score += 0.8;
  }
  // Title starts with query
  else if (title.startsWith(queryLower)) {
    score += 0.7;
  }

  // Term matching
  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 0.3;
    }
    if (subtitle.includes(term)) {
      score += 0.15;
    }
    if (description.includes(term)) {
      score += 0.1;
    }
  }

  // All terms present bonus
  if (queryTerms.length > 1) {
    const allInTitle = queryTerms.every((t) => title.includes(t));
    const allInDescription = queryTerms.every((t) => description.includes(t));
    if (allInTitle) score += 0.5;
    if (allInDescription) score += 0.2;
  }

  // Normalize to 0-1
  return Math.min(1, score / 2);
}

/**
 * Calculate proximity score based on distance.
 */
function calculateProximityScore(
  result: SearchResultItem,
  userLocation?: { latitude: number; longitude: number }
): number {
  if (!userLocation || result.distance === undefined) {
    return 0.5; // Neutral score if no location
  }

  const distance = result.distance;

  // Score based on distance (exponential decay)
  // Within 1km: ~1.0
  // Within 5km: ~0.7
  // Within 10km: ~0.5
  // Within 25km: ~0.25
  // Beyond 50km: ~0.05

  return Math.exp(-distance / 10);
}

/**
 * Calculate recency score.
 */
function calculateRecencyScore(result: SearchResultItem): number {
  const createdAt = result.data.createdAt as string
    ?? result.data.memberSince as string
    ?? result.data.expiresAt as string;

  if (!createdAt) return 0.5;

  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const ageHours = (now - created) / (1000 * 60 * 60);

  // Score based on age (exponential decay)
  // < 1 hour: ~1.0
  // < 24 hours: ~0.7
  // < 7 days: ~0.4
  // < 30 days: ~0.2
  // > 30 days: ~0.1

  return Math.exp(-ageHours / (24 * 7));
}

/**
 * Calculate rating score.
 */
function calculateRatingScore(result: SearchResultItem): number {
  const rating = result.data.rating as number;
  const reviewCount = result.data.reviewCount as number ?? 0;

  if (!rating) return 0.5; // Neutral if no rating

  // Weight by review count (more reviews = more reliable)
  const reliability = Math.min(1, reviewCount / 10);

  // Score: (rating / 5) weighted by reliability
  const ratingScore = rating / 5;

  return 0.5 + (ratingScore - 0.5) * reliability;
}

/**
 * Calculate popularity score.
 */
function calculatePopularityScore(result: SearchResultItem): number {
  let score = 0.5;

  // For listings
  const favoriteCount = result.data.favoriteCount as number ?? 0;
  const viewCount = result.data.viewCount as number ?? 0;
  const messageCount = result.data.messageCount as number ?? 0;

  // For users
  const itemsShared = result.data.itemsShared as number ?? 0;
  const arrangementsCompleted = result.data.arrangementsCompleted as number ?? 0;

  // Listing popularity
  if (result.type === "listing") {
    const engagementScore =
      favoriteCount * 0.3 +
      viewCount * 0.01 +
      messageCount * 0.5;
    score = Math.min(1, 0.5 + engagementScore / 20);
  }

  // User popularity
  if (result.type === "user") {
    const activityScore = itemsShared * 0.2 + arrangementsCompleted * 0.3;
    score = Math.min(1, 0.5 + activityScore / 30);
  }

  return score;
}

/**
 * Calculate personalization score based on user preferences.
 */
function calculatePersonalizationScore(
  result: SearchResultItem,
  preferences: UserPreferences | null
): number {
  if (!preferences) return 0.5;

  let score = 0.5;

  // Check category preference
  const category = result.data.category as string;
  if (category && preferences.preferredCategories.includes(category)) {
    score += 0.2;
  }

  // Check dietary preference
  const dietaryInfo = result.data.dietaryInfo as string[];
  if (dietaryInfo && preferences.dietaryRestrictions.length > 0) {
    const matchCount = dietaryInfo.filter((d) =>
      preferences.dietaryRestrictions.includes(d)
    ).length;
    score += matchCount * 0.1;
  }

  // Check interaction history
  if (result.type === "user") {
    if (preferences.interactedUserIds.includes(result.id)) {
      score += 0.15;
    }
  }

  return Math.min(1, score);
}

/**
 * Calculate final weighted score.
 */
function calculateFinalScore(
  scores: ScoreBreakdown,
  weights: RankingWeights
): number {
  return (
    scores.textRelevance * weights.textRelevance +
    scores.proximity * weights.proximity +
    scores.recency * weights.recency +
    scores.rating * weights.rating +
    scores.popularity * weights.popularity +
    scores.personalization * weights.personalization
  );
}

/**
 * Get weights based on config.
 */
function getWeights(config: RankingConfig): RankingWeights {
  const weights = { ...DEFAULT_WEIGHTS };

  // Adjust weights based on config
  if (!config.userLocation) {
    // No location, redistribute proximity weight
    weights.proximity = 0;
    weights.textRelevance += 0.15;
    weights.recency += 0.1;
  }

  if (config.boostRecent) {
    weights.recency *= 1.5;
  }

  if (config.boostNearby && config.userLocation) {
    weights.proximity *= 1.5;
  }

  if (config.boostHighRated) {
    weights.rating *= 1.5;
  }

  // Normalize weights to sum to 1
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(weights) as (keyof RankingWeights)[]) {
    weights[key] /= total;
  }

  return weights;
}

/**
 * Apply diversity to avoid similar results clustering.
 */
function applyDiversity(
  results: SearchResultItem[],
  factor: number
): SearchResultItem[] {
  if (results.length <= 3) return results;

  const diversified: SearchResultItem[] = [];
  const remaining = [...results];
  const seenCategories = new Set<string>();
  const seenTypes = new Map<string, number>();

  while (remaining.length > 0 && diversified.length < results.length) {
    let bestIndex = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      let score = item.score ?? 0;

      // Penalize if same type appears too often recently
      const typeCount = seenTypes.get(item.type) ?? 0;
      score *= Math.pow(1 - factor, typeCount);

      // Penalize if same category recently
      const category = item.data.category as string;
      if (category && seenCategories.has(category)) {
        score *= (1 - factor * 0.5);
      }

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const selected = remaining.splice(bestIndex, 1)[0];
    diversified.push(selected);

    // Track for diversity
    seenTypes.set(selected.type, (seenTypes.get(selected.type) ?? 0) + 1);
    const category = selected.data.category as string;
    if (category) {
      seenCategories.add(category);
      // Only keep last 3 categories
      if (seenCategories.size > 3) {
        const first = seenCategories.values().next().value;
        seenCategories.delete(first);
      }
    }
  }

  return diversified;
}

// User preferences interface
interface UserPreferences {
  preferredCategories: string[];
  dietaryRestrictions: string[];
  interactedUserIds: string[];
  searchHistory: string[];
}

/**
 * Get user preferences for personalization.
 */
async function getUserPreferences(
  supabase: any,
  userId: string
): Promise<UserPreferences | null> {
  try {
    // Get user profile preferences
    const { data: profile } = await supabase
      .from("profiles")
      .select("dietary_restrictions")
      .eq("id", userId)
      .single();

    // Get frequently viewed categories
    const { data: views } = await supabase
      .from("listing_views")
      .select("posts(category)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    const categoryCounts = new Map<string, number>();
    for (const view of views ?? []) {
      const category = view.posts?.category;
      if (category) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
    }

    const preferredCategories = Array.from(categoryCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat]) => cat);

    // Get users interacted with
    const { data: conversations } = await supabase
      .from("chat_messages")
      .select("sender_id, receiver_id")
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .order("created_at", { ascending: false })
      .limit(50);

    const interactedUserIds = new Set<string>();
    for (const msg of conversations ?? []) {
      if (msg.sender_id !== userId) interactedUserIds.add(msg.sender_id);
      if (msg.receiver_id !== userId) interactedUserIds.add(msg.receiver_id);
    }

    return {
      preferredCategories,
      dietaryRestrictions: profile?.dietary_restrictions ?? [],
      interactedUserIds: Array.from(interactedUserIds),
      searchHistory: [],
    };
  } catch (error) {
    console.error("Failed to get user preferences:", error);
    return null;
  }
}

export { RankingWeights, ScoreBreakdown };
