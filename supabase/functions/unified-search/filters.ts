/**
 * Search Filters
 *
 * Handles parsing, validation, and application of search filters
 * for listings and users.
 */

// Filter types
export interface SearchFilters {
  // Listing filters
  category?: string | string[];
  dietary?: string | string[];
  quantity?: {
    min?: number;
    max?: number;
  };
  distance?: {
    min?: number;
    max?: number;
  };
  expiresWithin?: number; // hours
  createdWithin?: number; // hours
  hasImages?: boolean;

  // User filters
  rating?: {
    min?: number;
    max?: number;
  };
  itemsShared?: {
    min?: number;
    max?: number;
  };
  verified?: boolean;

  // Sort options
  sortBy?: SortField;
  sortOrder?: "asc" | "desc";
}

type SortField =
  | "relevance"
  | "distance"
  | "created_at"
  | "expires_at"
  | "rating"
  | "popularity";

// Parsed filter value
interface ParsedFilter {
  field: string;
  operator: FilterOperator;
  value: unknown;
}

type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "contains"
  | "ilike"
  | "is";

// Filter definitions
interface FilterDefinition {
  field: string;
  dbField: string;
  type: "string" | "number" | "boolean" | "array" | "date";
  operators: FilterOperator[];
  validate?: (value: unknown) => boolean;
  transform?: (value: unknown) => unknown;
}

// Listing filter definitions
const LISTING_FILTERS: Record<string, FilterDefinition> = {
  category: {
    field: "category",
    dbField: "category",
    type: "string",
    operators: ["eq", "in"],
  },
  dietary: {
    field: "dietary",
    dbField: "dietary_info",
    type: "array",
    operators: ["contains"],
  },
  quantityMin: {
    field: "quantity.min",
    dbField: "quantity",
    type: "number",
    operators: ["gte"],
    validate: (v) => typeof v === "number" && v >= 0,
  },
  quantityMax: {
    field: "quantity.max",
    dbField: "quantity",
    type: "number",
    operators: ["lte"],
    validate: (v) => typeof v === "number" && v > 0,
  },
  hasImages: {
    field: "hasImages",
    dbField: "image_urls",
    type: "boolean",
    operators: ["neq"],
    transform: () => [], // Check if not empty array
  },
  expiresWithin: {
    field: "expiresWithin",
    dbField: "expires_at",
    type: "date",
    operators: ["lte"],
    transform: (hours) => {
      const date = new Date();
      date.setHours(date.getHours() + (hours as number));
      return date.toISOString();
    },
  },
  createdWithin: {
    field: "createdWithin",
    dbField: "created_at",
    type: "date",
    operators: ["gte"],
    transform: (hours) => {
      const date = new Date();
      date.setHours(date.getHours() - (hours as number));
      return date.toISOString();
    },
  },
};

// User filter definitions
const USER_FILTERS: Record<string, FilterDefinition> = {
  ratingMin: {
    field: "rating.min",
    dbField: "average_rating",
    type: "number",
    operators: ["gte"],
    validate: (v) => typeof v === "number" && v >= 0 && v <= 5,
  },
  ratingMax: {
    field: "rating.max",
    dbField: "average_rating",
    type: "number",
    operators: ["lte"],
    validate: (v) => typeof v === "number" && v >= 0 && v <= 5,
  },
  itemsSharedMin: {
    field: "itemsShared.min",
    dbField: "items_shared",
    type: "number",
    operators: ["gte"],
    validate: (v) => typeof v === "number" && v >= 0,
  },
  verified: {
    field: "verified",
    dbField: "is_verified",
    type: "boolean",
    operators: ["eq"],
  },
};

/**
 * Parse raw filter input into structured filters.
 */
export function parseFilters(input: SearchFilters): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};

  // Category filter
  if (input.category) {
    parsed.category = Array.isArray(input.category)
      ? input.category
      : [input.category];
  }

  // Dietary filter
  if (input.dietary) {
    parsed.dietary = Array.isArray(input.dietary)
      ? input.dietary
      : [input.dietary];
  }

  // Quantity range
  if (input.quantity) {
    if (input.quantity.min !== undefined) {
      parsed.quantityMin = input.quantity.min;
    }
    if (input.quantity.max !== undefined) {
      parsed.quantityMax = input.quantity.max;
    }
  }

  // Distance range
  if (input.distance) {
    if (input.distance.min !== undefined) {
      parsed.distanceMin = input.distance.min;
    }
    if (input.distance.max !== undefined) {
      parsed.distanceMax = input.distance.max;
    }
  }

  // Time-based filters
  if (input.expiresWithin !== undefined) {
    parsed.expiresWithin = input.expiresWithin;
  }
  if (input.createdWithin !== undefined) {
    parsed.createdWithin = input.createdWithin;
  }

  // Boolean filters
  if (input.hasImages !== undefined) {
    parsed.hasImages = input.hasImages;
  }

  // Rating range
  if (input.rating) {
    if (input.rating.min !== undefined) {
      parsed.ratingMin = input.rating.min;
    }
    if (input.rating.max !== undefined) {
      parsed.ratingMax = input.rating.max;
    }
  }

  // Items shared range
  if (input.itemsShared) {
    if (input.itemsShared.min !== undefined) {
      parsed.itemsSharedMin = input.itemsShared.min;
    }
  }

  // Verified filter
  if (input.verified !== undefined) {
    parsed.verified = input.verified;
  }

  // Sort options
  if (input.sortBy) {
    parsed.sortBy = input.sortBy;
    parsed.sortOrder = input.sortOrder ?? "desc";
  }

  return parsed;
}

/**
 * Apply filters to a Supabase query.
 */
export function applyFilters(
  query: any,
  filters: Record<string, unknown>,
  type: "listing" | "user"
): any {
  const definitions = type === "listing" ? LISTING_FILTERS : USER_FILTERS;

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;

    const definition = definitions[key];
    if (!definition) continue;

    // Validate if validator exists
    if (definition.validate && !definition.validate(value)) {
      console.warn(`Invalid filter value for ${key}:`, value);
      continue;
    }

    // Transform value if transformer exists
    const transformedValue = definition.transform
      ? definition.transform(value)
      : value;

    // Apply filter based on operator
    query = applyOperator(query, definition.dbField, definition.operators[0], transformedValue);
  }

  // Apply sorting
  if (filters.sortBy && type === "listing") {
    const sortField = getSortField(filters.sortBy as SortField);
    const ascending = filters.sortOrder === "asc";
    query = query.order(sortField, { ascending });
  }

  return query;
}

/**
 * Apply a single filter operator.
 */
function applyOperator(
  query: any,
  field: string,
  operator: FilterOperator,
  value: unknown
): any {
  switch (operator) {
    case "eq":
      return query.eq(field, value);
    case "neq":
      return query.neq(field, value);
    case "gt":
      return query.gt(field, value);
    case "gte":
      return query.gte(field, value);
    case "lt":
      return query.lt(field, value);
    case "lte":
      return query.lte(field, value);
    case "in":
      return query.in(field, value as unknown[]);
    case "contains":
      // For array contains, use overlaps
      return query.overlaps(field, value as unknown[]);
    case "ilike":
      return query.ilike(field, `%${value}%`);
    case "is":
      return query.is(field, value as boolean | null);
    default:
      return query;
  }
}

/**
 * Get database sort field name.
 */
function getSortField(sortBy: SortField): string {
  const sortFields: Record<SortField, string> = {
    relevance: "created_at", // Fallback to created_at
    distance: "created_at", // Distance sorting handled separately
    created_at: "created_at",
    expires_at: "expires_at",
    rating: "average_rating",
    popularity: "favorite_count",
  };
  return sortFields[sortBy] ?? "created_at";
}

/**
 * Validate filter values.
 */
export function validateFilters(filters: SearchFilters): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Validate category
  if (filters.category) {
    const categories = Array.isArray(filters.category)
      ? filters.category
      : [filters.category];
    const validCategories = [
      "fresh_produce", "bakery", "dairy", "meat", "seafood",
      "prepared_meals", "canned_goods", "frozen", "snacks",
      "beverages", "grains", "organic", "other",
    ];
    for (const cat of categories) {
      if (!validCategories.includes(cat)) {
        errors.push(`Invalid category: ${cat}`);
      }
    }
  }

  // Validate dietary
  if (filters.dietary) {
    const dietary = Array.isArray(filters.dietary)
      ? filters.dietary
      : [filters.dietary];
    const validDietary = [
      "vegetarian", "vegan", "gluten_free", "dairy_free",
      "nut_free", "halal", "kosher", "organic",
    ];
    for (const d of dietary) {
      if (!validDietary.includes(d)) {
        errors.push(`Invalid dietary option: ${d}`);
      }
    }
  }

  // Validate quantity range
  if (filters.quantity) {
    if (filters.quantity.min !== undefined && filters.quantity.min < 0) {
      errors.push("Quantity minimum must be >= 0");
    }
    if (filters.quantity.max !== undefined && filters.quantity.max < 1) {
      errors.push("Quantity maximum must be >= 1");
    }
    if (
      filters.quantity.min !== undefined &&
      filters.quantity.max !== undefined &&
      filters.quantity.min > filters.quantity.max
    ) {
      errors.push("Quantity minimum cannot exceed maximum");
    }
  }

  // Validate distance range
  if (filters.distance) {
    if (filters.distance.min !== undefined && filters.distance.min < 0) {
      errors.push("Distance minimum must be >= 0");
    }
    if (filters.distance.max !== undefined && filters.distance.max > 500) {
      errors.push("Distance maximum cannot exceed 500 km");
    }
  }

  // Validate time ranges
  if (filters.expiresWithin !== undefined) {
    if (filters.expiresWithin < 1 || filters.expiresWithin > 720) {
      errors.push("expiresWithin must be between 1 and 720 hours");
    }
  }
  if (filters.createdWithin !== undefined) {
    if (filters.createdWithin < 1 || filters.createdWithin > 8760) {
      errors.push("createdWithin must be between 1 and 8760 hours (1 year)");
    }
  }

  // Validate rating range
  if (filters.rating) {
    if (filters.rating.min !== undefined && (filters.rating.min < 0 || filters.rating.min > 5)) {
      errors.push("Rating minimum must be between 0 and 5");
    }
    if (filters.rating.max !== undefined && (filters.rating.max < 0 || filters.rating.max > 5)) {
      errors.push("Rating maximum must be between 0 and 5");
    }
  }

  // Validate sort options
  if (filters.sortBy) {
    const validSortFields: SortField[] = [
      "relevance", "distance", "created_at", "expires_at", "rating", "popularity",
    ];
    if (!validSortFields.includes(filters.sortBy)) {
      errors.push(`Invalid sortBy: ${filters.sortBy}`);
    }
  }
  if (filters.sortOrder && !["asc", "desc"].includes(filters.sortOrder)) {
    errors.push(`Invalid sortOrder: ${filters.sortOrder}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get filter options with counts for faceted search.
 */
export async function getFilterCounts(
  supabase: any,
  baseQuery: string,
  filterType: "category" | "dietary"
): Promise<Array<{ value: string; count: number }>> {
  const field = filterType === "category" ? "category" : "dietary_info";

  const { data } = await supabase
    .from("posts")
    .select(field)
    .eq("status", "active")
    .or(`title.ilike.%${baseQuery}%,description.ilike.%${baseQuery}%`);

  if (!data) return [];

  const counts = new Map<string, number>();

  for (const row of data) {
    if (filterType === "category") {
      const value = row.category as string;
      if (value) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    } else {
      const values = row.dietary_info as string[];
      for (const value of values ?? []) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  }

  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build filter query string for URLs.
 */
export function buildFilterQueryString(filters: SearchFilters): string {
  const params = new URLSearchParams();

  if (filters.category) {
    const categories = Array.isArray(filters.category)
      ? filters.category
      : [filters.category];
    params.set("category", categories.join(","));
  }

  if (filters.dietary) {
    const dietary = Array.isArray(filters.dietary)
      ? filters.dietary
      : [filters.dietary];
    params.set("dietary", dietary.join(","));
  }

  if (filters.quantity?.min !== undefined) {
    params.set("qtyMin", String(filters.quantity.min));
  }
  if (filters.quantity?.max !== undefined) {
    params.set("qtyMax", String(filters.quantity.max));
  }

  if (filters.distance?.max !== undefined) {
    params.set("radius", String(filters.distance.max));
  }

  if (filters.expiresWithin !== undefined) {
    params.set("expiresIn", String(filters.expiresWithin));
  }

  if (filters.hasImages) {
    params.set("hasImages", "1");
  }

  if (filters.rating?.min !== undefined) {
    params.set("ratingMin", String(filters.rating.min));
  }

  if (filters.verified) {
    params.set("verified", "1");
  }

  if (filters.sortBy) {
    params.set("sort", filters.sortBy);
  }
  if (filters.sortOrder) {
    params.set("order", filters.sortOrder);
  }

  return params.toString();
}

/**
 * Parse filter query string from URL.
 */
export function parseFilterQueryString(queryString: string): SearchFilters {
  const params = new URLSearchParams(queryString);
  const filters: SearchFilters = {};

  const category = params.get("category");
  if (category) {
    filters.category = category.includes(",") ? category.split(",") : category;
  }

  const dietary = params.get("dietary");
  if (dietary) {
    filters.dietary = dietary.includes(",") ? dietary.split(",") : dietary;
  }

  const qtyMin = params.get("qtyMin");
  const qtyMax = params.get("qtyMax");
  if (qtyMin || qtyMax) {
    filters.quantity = {};
    if (qtyMin) filters.quantity.min = parseInt(qtyMin);
    if (qtyMax) filters.quantity.max = parseInt(qtyMax);
  }

  const radius = params.get("radius");
  if (radius) {
    filters.distance = { max: parseFloat(radius) };
  }

  const expiresIn = params.get("expiresIn");
  if (expiresIn) {
    filters.expiresWithin = parseInt(expiresIn);
  }

  if (params.get("hasImages") === "1") {
    filters.hasImages = true;
  }

  const ratingMin = params.get("ratingMin");
  if (ratingMin) {
    filters.rating = { min: parseFloat(ratingMin) };
  }

  if (params.get("verified") === "1") {
    filters.verified = true;
  }

  const sort = params.get("sort");
  if (sort) {
    filters.sortBy = sort as SortField;
  }

  const order = params.get("order");
  if (order) {
    filters.sortOrder = order as "asc" | "desc";
  }

  return filters;
}
