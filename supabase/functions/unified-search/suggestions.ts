/**
 * Search Suggestions and Autocomplete
 *
 * Provides intelligent search suggestions, spell checking,
 * and "did you mean" functionality.
 */

// Suggestion configuration
export interface SuggestionConfig {
  maxSuggestions?: number;
  includeSpellCheck?: boolean;
  includePopular?: boolean;
  includeRecent?: boolean;
  minQueryLength?: number;
}

// Suggestion result
export interface SuggestionResult {
  suggestions: string[];
  didYouMean?: string;
  categories?: string[];
  popular?: string[];
}

// Common food-related terms for spell checking
const FOOD_TERMS = [
  "vegetables", "fruits", "bread", "bakery", "dairy", "meat", "fish",
  "seafood", "pasta", "rice", "beans", "legumes", "soup", "salad",
  "sandwich", "pizza", "burger", "chicken", "beef", "pork", "lamb",
  "turkey", "eggs", "cheese", "milk", "yogurt", "butter", "cream",
  "vegetables", "tomato", "potato", "carrot", "onion", "garlic",
  "lettuce", "spinach", "kale", "broccoli", "cauliflower", "corn",
  "apple", "banana", "orange", "lemon", "strawberry", "blueberry",
  "grape", "watermelon", "mango", "pineapple", "peach", "pear",
  "coffee", "tea", "juice", "soda", "water", "smoothie", "shake",
  "breakfast", "lunch", "dinner", "snack", "dessert", "appetizer",
  "organic", "fresh", "frozen", "canned", "dried", "homemade",
  "vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free",
  "halal", "kosher", "low-carb", "keto", "paleo",
];

// Common misspellings
const MISSPELLINGS: Record<string, string> = {
  "vegatable": "vegetable",
  "vegtable": "vegetable",
  "vegitables": "vegetables",
  "fruts": "fruits",
  "fruites": "fruits",
  "chiken": "chicken",
  "chkn": "chicken",
  "tomatoe": "tomato",
  "potatoe": "potato",
  "brocoli": "broccoli",
  "brocoili": "broccoli",
  "lettice": "lettuce",
  "letuce": "lettuce",
  "sandwhich": "sandwich",
  "sandwitch": "sandwich",
  "spagetti": "spaghetti",
  "spagehtti": "spaghetti",
  "yoghurt": "yogurt",
  "yougurt": "yogurt",
  "breakfest": "breakfast",
  "brekfast": "breakfast",
  "orgnic": "organic",
  "organik": "organic",
  "vegeterian": "vegetarian",
  "vegitarian": "vegetarian",
  "gluten free": "gluten-free",
  "dairy free": "dairy-free",
};

/**
 * Get search suggestions for a query.
 */
export async function getSuggestions(
  query: string,
  config: SuggestionConfig,
  supabase: any
): Promise<SuggestionResult> {
  const maxSuggestions = config.maxSuggestions ?? 8;
  const minLength = config.minQueryLength ?? 2;

  if (query.length < minLength) {
    return { suggestions: [] };
  }

  const normalizedQuery = query.toLowerCase().trim();
  const suggestions: string[] = [];

  // Check for spell corrections
  let didYouMean: string | undefined;
  if (config.includeSpellCheck !== false) {
    didYouMean = checkSpelling(normalizedQuery);
  }

  // Get suggestions from multiple sources
  const [
    titleSuggestions,
    categorySuggestions,
    popularSuggestions,
  ] = await Promise.all([
    getTitleSuggestions(supabase, normalizedQuery, maxSuggestions),
    getCategorySuggestions(normalizedQuery),
    config.includePopular !== false
      ? getPopularSearches(supabase, normalizedQuery, 5)
      : [],
  ]);

  // Combine and deduplicate suggestions
  const seen = new Set<string>();
  const addSuggestion = (suggestion: string) => {
    const normalized = suggestion.toLowerCase().trim();
    if (!seen.has(normalized) && normalized !== normalizedQuery) {
      seen.add(normalized);
      suggestions.push(suggestion);
    }
  };

  // Add in priority order
  for (const s of titleSuggestions) addSuggestion(s);
  for (const s of categorySuggestions) addSuggestion(s);
  for (const s of popularSuggestions) addSuggestion(s);

  // Get category suggestions
  const categories = getCategoryMatchesForQuery(normalizedQuery);

  return {
    suggestions: suggestions.slice(0, maxSuggestions),
    didYouMean: didYouMean !== normalizedQuery ? didYouMean : undefined,
    categories: categories.slice(0, 5),
    popular: popularSuggestions.slice(0, 5),
  };
}

/**
 * Get title-based suggestions from listings.
 */
async function getTitleSuggestions(
  supabase: any,
  query: string,
  limit: number
): Promise<string[]> {
  const { data } = await supabase
    .from("posts")
    .select("title")
    .eq("status", "active")
    .ilike("title", `${query}%`)
    .order("created_at", { ascending: false })
    .limit(limit * 2);

  if (!data) return [];

  // Extract unique title prefixes
  const suggestions = new Set<string>();

  for (const row of data) {
    const title = row.title as string;

    // Get the matching prefix + next word
    const words = title.split(/\s+/);
    const queryWords = query.split(/\s+/).length;

    if (words.length > queryWords) {
      const suggestion = words.slice(0, queryWords + 1).join(" ");
      suggestions.add(suggestion);
    }

    // Also add full title if short enough
    if (title.length <= 50) {
      suggestions.add(title);
    }
  }

  return Array.from(suggestions).slice(0, limit);
}

/**
 * Get category-based suggestions.
 */
function getCategorySuggestions(query: string): string[] {
  const categories = [
    "Fresh Produce",
    "Bakery Items",
    "Dairy Products",
    "Meat & Poultry",
    "Seafood",
    "Prepared Meals",
    "Canned Goods",
    "Frozen Foods",
    "Snacks",
    "Beverages",
    "Condiments",
    "Grains & Pasta",
    "Organic Foods",
    "Baby Food",
    "Pet Food",
  ];

  return categories.filter((cat) =>
    cat.toLowerCase().includes(query)
  );
}

/**
 * Get popular searches matching query.
 */
async function getPopularSearches(
  supabase: any,
  query: string,
  limit: number
): Promise<string[]> {
  const { data } = await supabase
    .from("search_analytics")
    .select("query")
    .ilike("query", `${query}%`)
    .gte("result_count", 1)
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("result_count", { ascending: false })
    .limit(limit * 3);

  if (!data) return [];

  // Count occurrences
  const queryCounts = new Map<string, number>();
  for (const row of data) {
    const q = (row.query as string).toLowerCase().trim();
    queryCounts.set(q, (queryCounts.get(q) ?? 0) + 1);
  }

  return Array.from(queryCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([q]) => q);
}

/**
 * Check spelling and return correction if found.
 */
function checkSpelling(query: string): string | undefined {
  const words = query.split(/\s+/);
  let corrected = false;
  const correctedWords = words.map((word) => {
    // Check direct misspelling map
    if (MISSPELLINGS[word]) {
      corrected = true;
      return MISSPELLINGS[word];
    }

    // Check Levenshtein distance to food terms
    const closest = findClosestTerm(word, FOOD_TERMS, 2);
    if (closest && closest !== word) {
      corrected = true;
      return closest;
    }

    return word;
  });

  return corrected ? correctedWords.join(" ") : undefined;
}

/**
 * Find closest term using Levenshtein distance.
 */
function findClosestTerm(
  word: string,
  terms: string[],
  maxDistance: number
): string | null {
  if (word.length < 3) return null;

  let closest: string | null = null;
  let minDistance = maxDistance + 1;

  for (const term of terms) {
    // Skip if length difference is too big
    if (Math.abs(term.length - word.length) > maxDistance) continue;

    const distance = levenshteinDistance(word, term);
    if (distance < minDistance) {
      minDistance = distance;
      closest = term;
    }
  }

  return minDistance <= maxDistance ? closest : null;
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Get category matches for a query.
 */
function getCategoryMatchesForQuery(query: string): string[] {
  const categoryMapping: Record<string, string[]> = {
    "Fresh Produce": ["vegetables", "fruits", "fresh", "produce", "salad", "lettuce", "tomato"],
    "Bakery": ["bread", "bakery", "pastry", "cake", "cookies", "muffin", "bagel"],
    "Dairy": ["milk", "cheese", "yogurt", "butter", "cream", "dairy", "eggs"],
    "Meat & Poultry": ["meat", "chicken", "beef", "pork", "turkey", "lamb", "poultry"],
    "Seafood": ["fish", "seafood", "shrimp", "salmon", "tuna", "crab", "lobster"],
    "Prepared Meals": ["prepared", "cooked", "meal", "dinner", "lunch", "ready"],
    "Canned Goods": ["canned", "can", "preserved", "soup", "beans"],
    "Frozen": ["frozen", "ice cream", "freezer"],
    "Snacks": ["snacks", "chips", "crackers", "nuts", "popcorn"],
    "Beverages": ["drink", "beverage", "juice", "soda", "water", "coffee", "tea"],
    "Grains": ["rice", "pasta", "grain", "cereal", "oats", "quinoa"],
    "Organic": ["organic", "natural", "bio"],
    "Vegetarian": ["vegetarian", "veggie", "meatless"],
    "Vegan": ["vegan", "plant-based", "plant based"],
    "Gluten-Free": ["gluten-free", "gluten free", "celiac"],
  };

  const matches: string[] = [];

  for (const [category, keywords] of Object.entries(categoryMapping)) {
    for (const keyword of keywords) {
      if (query.includes(keyword) || keyword.includes(query)) {
        matches.push(category);
        break;
      }
    }
  }

  return matches;
}

/**
 * Generate query completions.
 */
export function generateCompletions(
  query: string,
  maxCompletions: number = 5
): string[] {
  const completions: string[] = [];
  const queryLower = query.toLowerCase();

  // Common search patterns
  const patterns = [
    `${query} near me`,
    `${query} available`,
    `fresh ${query}`,
    `organic ${query}`,
    `free ${query}`,
    `homemade ${query}`,
  ];

  for (const pattern of patterns) {
    if (!pattern.toLowerCase().startsWith(queryLower)) continue;
    completions.push(pattern);
    if (completions.length >= maxCompletions) break;
  }

  return completions;
}

/**
 * Get trending search queries.
 */
export async function getTrendingQueries(
  supabase: any,
  limit: number = 10,
  hoursBack: number = 24
): Promise<Array<{ query: string; count: number; trend: "up" | "down" | "stable" }>> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
  const previousCutoff = new Date(cutoff.getTime() - hoursBack * 60 * 60 * 1000);

  // Get current period searches
  const { data: current } = await supabase
    .from("search_analytics")
    .select("query")
    .gte("created_at", cutoff.toISOString())
    .gte("result_count", 1);

  // Get previous period for comparison
  const { data: previous } = await supabase
    .from("search_analytics")
    .select("query")
    .gte("created_at", previousCutoff.toISOString())
    .lt("created_at", cutoff.toISOString())
    .gte("result_count", 1);

  // Count current searches
  const currentCounts = new Map<string, number>();
  for (const row of current ?? []) {
    const q = (row.query as string).toLowerCase().trim();
    currentCounts.set(q, (currentCounts.get(q) ?? 0) + 1);
  }

  // Count previous searches
  const previousCounts = new Map<string, number>();
  for (const row of previous ?? []) {
    const q = (row.query as string).toLowerCase().trim();
    previousCounts.set(q, (previousCounts.get(q) ?? 0) + 1);
  }

  // Calculate trends
  const results = Array.from(currentCounts.entries())
    .map(([query, count]) => {
      const previousCount = previousCounts.get(query) ?? 0;
      let trend: "up" | "down" | "stable" = "stable";

      if (previousCount === 0 && count > 2) {
        trend = "up";
      } else if (previousCount > 0) {
        const change = (count - previousCount) / previousCount;
        if (change > 0.2) trend = "up";
        else if (change < -0.2) trend = "down";
      }

      return { query, count, trend };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return results;
}

export { FOOD_TERMS, MISSPELLINGS };
