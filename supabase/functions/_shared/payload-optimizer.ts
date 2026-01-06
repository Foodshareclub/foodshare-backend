/**
 * Payload Optimizer
 *
 * Optimizes API response payloads to reduce bandwidth
 * through field selection, pagination, and data transformation.
 */

// Field selection configuration
export interface FieldSelection {
  include?: string[];
  exclude?: string[];
  maxDepth?: number;
}

// Pagination configuration
export interface PaginationConfig {
  page: number;
  limit: number;
  maxLimit?: number;
  offset?: number;
}

// Optimization options
export interface OptimizationOptions {
  fields?: FieldSelection;
  pagination?: PaginationConfig;
  removeNulls?: boolean;
  shortenKeys?: boolean;
  compactArrays?: boolean;
  truncateStrings?: number;
  dateFormat?: "iso" | "unix" | "relative";
}

// Key mapping for shortening
const SHORT_KEY_MAP: Record<string, string> = {
  id: "i",
  created_at: "c",
  updated_at: "u",
  user_id: "ui",
  title: "t",
  description: "d",
  image_url: "img",
  image_urls: "imgs",
  latitude: "lat",
  longitude: "lng",
  display_name: "dn",
  avatar_url: "av",
  status: "s",
  type: "tp",
  category: "cat",
  quantity: "q",
  expires_at: "exp",
  location_name: "loc",
  dietary_info: "di",
  is_active: "ia",
  message: "m",
  content: "cnt",
  rating: "r",
  count: "n",
};

// Reverse key mapping for expansion
const LONG_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SHORT_KEY_MAP).map(([k, v]) => [v, k])
);

/**
 * Optimize a payload by applying various optimizations.
 */
export function optimizePayload<T extends Record<string, unknown>>(
  data: T | T[],
  options: OptimizationOptions = {}
): unknown {
  // Handle arrays
  if (Array.isArray(data)) {
    let result = data.map((item) => optimizeObject(item, options));

    // Apply pagination
    if (options.pagination) {
      result = applyPagination(result, options.pagination);
    }

    // Compact arrays
    if (options.compactArrays) {
      return compactArray(result);
    }

    return result;
  }

  return optimizeObject(data, options);
}

/**
 * Optimize a single object.
 */
function optimizeObject<T extends Record<string, unknown>>(
  obj: T,
  options: OptimizationOptions,
  depth: number = 0
): Record<string, unknown> {
  const maxDepth = options.fields?.maxDepth ?? 10;

  if (depth > maxDepth) {
    return { _truncated: true };
  }

  let result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Check field inclusion/exclusion
    if (!shouldIncludeField(key, options.fields)) {
      continue;
    }

    // Skip nulls if configured
    if (options.removeNulls && value === null) {
      continue;
    }

    // Transform value
    let transformedValue = transformValue(value, options, depth);

    // Shorten key if configured
    const outputKey = options.shortenKeys ? shortenKey(key) : key;

    result[outputKey] = transformedValue;
  }

  return result;
}

/**
 * Check if a field should be included.
 */
function shouldIncludeField(key: string, selection?: FieldSelection): boolean {
  if (!selection) return true;

  // Check exclude list first
  if (selection.exclude?.includes(key)) {
    return false;
  }

  // If include list exists, only include those fields
  if (selection.include && selection.include.length > 0) {
    return selection.include.includes(key);
  }

  return true;
}

/**
 * Transform a value based on options.
 */
function transformValue(
  value: unknown,
  options: OptimizationOptions,
  depth: number
): unknown {
  // Handle null
  if (value === null) {
    return options.removeNulls ? undefined : null;
  }

  // Handle undefined
  if (value === undefined) {
    return undefined;
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "object" && item !== null) {
        return optimizeObject(item as Record<string, unknown>, options, depth + 1);
      }
      return transformValue(item, options, depth);
    });
  }

  // Handle objects
  if (typeof value === "object") {
    return optimizeObject(value as Record<string, unknown>, options, depth + 1);
  }

  // Handle strings
  if (typeof value === "string") {
    // Check if it's a date string
    if (isISODateString(value) && options.dateFormat) {
      return transformDate(value, options.dateFormat);
    }

    // Truncate long strings
    if (options.truncateStrings && value.length > options.truncateStrings) {
      return value.substring(0, options.truncateStrings) + "...";
    }

    return value;
  }

  return value;
}

/**
 * Apply pagination to an array.
 */
function applyPagination<T>(items: T[], config: PaginationConfig): T[] {
  const limit = Math.min(config.limit, config.maxLimit ?? 100);
  const offset = config.offset ?? (config.page - 1) * limit;

  return items.slice(offset, offset + limit);
}

/**
 * Compact an array by removing redundant keys.
 */
function compactArray(items: Record<string, unknown>[]): {
  keys: string[];
  values: unknown[][];
} {
  if (items.length === 0) {
    return { keys: [], values: [] };
  }

  // Get all keys from first item
  const keys = Object.keys(items[0]);

  // Extract values in key order
  const values = items.map((item) => keys.map((key) => item[key]));

  return { keys, values };
}

/**
 * Expand a compacted array back to objects.
 */
export function expandCompactArray(
  compact: { keys: string[]; values: unknown[][] }
): Record<string, unknown>[] {
  return compact.values.map((row) => {
    const obj: Record<string, unknown> = {};
    compact.keys.forEach((key, i) => {
      obj[key] = row[i];
    });
    return obj;
  });
}

/**
 * Shorten a key name.
 */
function shortenKey(key: string): string {
  return SHORT_KEY_MAP[key] ?? key;
}

/**
 * Expand a shortened key name.
 */
export function expandKey(shortKey: string): string {
  return LONG_KEY_MAP[shortKey] ?? shortKey;
}

/**
 * Expand all shortened keys in an object.
 */
export function expandKeys<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const expandedKey = expandKey(key);

    if (Array.isArray(value)) {
      result[expandedKey] = value.map((item) => {
        if (typeof item === "object" && item !== null) {
          return expandKeys(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof value === "object" && value !== null) {
      result[expandedKey] = expandKeys(value as Record<string, unknown>);
    } else {
      result[expandedKey] = value;
    }
  }

  return result;
}

/**
 * Check if a string is an ISO date.
 */
function isISODateString(str: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(str);
}

/**
 * Transform a date string.
 */
function transformDate(
  isoDate: string,
  format: "iso" | "unix" | "relative"
): string | number {
  const date = new Date(isoDate);

  switch (format) {
    case "unix":
      return Math.floor(date.getTime() / 1000);
    case "relative":
      return getRelativeTime(date);
    case "iso":
    default:
      return isoDate;
  }
}

/**
 * Get relative time string.
 */
function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return `${diffSeconds}s`;
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  return `${Math.floor(diffDays / 30)}mo`;
}

/**
 * Calculate payload size savings.
 */
export function calculateSavings(
  original: unknown,
  optimized: unknown
): {
  originalSize: number;
  optimizedSize: number;
  savings: number;
  savingsPercent: number;
} {
  const originalStr = JSON.stringify(original);
  const optimizedStr = JSON.stringify(optimized);

  const originalSize = new TextEncoder().encode(originalStr).length;
  const optimizedSize = new TextEncoder().encode(optimizedStr).length;
  const savings = originalSize - optimizedSize;

  return {
    originalSize,
    optimizedSize,
    savings,
    savingsPercent: originalSize > 0 ? (savings / originalSize) * 100 : 0,
  };
}

/**
 * Common field selections for different contexts.
 */
export const FIELD_PRESETS: Record<string, FieldSelection> = {
  listingList: {
    include: [
      "id", "title", "image_urls", "latitude", "longitude",
      "quantity", "expires_at", "created_at", "user_id",
    ],
    exclude: ["description", "dietary_info"],
    maxDepth: 1,
  },
  listingDetail: {
    exclude: ["search_vector"],
    maxDepth: 3,
  },
  userMinimal: {
    include: ["id", "display_name", "avatar_url"],
    maxDepth: 1,
  },
  userProfile: {
    exclude: ["password_hash", "email_verified_at", "auth_provider"],
    maxDepth: 2,
  },
  messageList: {
    include: ["id", "content", "sender_id", "created_at", "is_read"],
    maxDepth: 1,
  },
  feedItem: {
    include: [
      "id", "type", "title", "image_url", "distance",
      "created_at", "user", "category",
    ],
    maxDepth: 2,
  },
};

/**
 * Optimize for mobile clients (aggressive optimization).
 */
export function optimizeForMobile<T extends Record<string, unknown>>(
  data: T | T[]
): unknown {
  return optimizePayload(data, {
    removeNulls: true,
    shortenKeys: true,
    truncateStrings: 200,
    dateFormat: "unix",
  });
}

/**
 * Optimize for web clients (moderate optimization).
 */
export function optimizeForWeb<T extends Record<string, unknown>>(
  data: T | T[]
): unknown {
  return optimizePayload(data, {
    removeNulls: true,
    shortenKeys: false,
    truncateStrings: 500,
    dateFormat: "iso",
  });
}

/**
 * Create optimized list response with pagination metadata.
 */
export function createListResponse<T extends Record<string, unknown>>(
  items: T[],
  totalCount: number,
  pagination: PaginationConfig,
  options: OptimizationOptions = {}
): {
  data: unknown;
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
} {
  const optimized = optimizePayload(items, {
    ...options,
    pagination,
  });

  const limit = Math.min(pagination.limit, pagination.maxLimit ?? 100);
  const totalPages = Math.ceil(totalCount / limit);

  return {
    data: optimized,
    meta: {
      page: pagination.page,
      limit,
      total: totalCount,
      totalPages,
      hasNext: pagination.page < totalPages,
      hasPrev: pagination.page > 1,
    },
  };
}

/**
 * Diff two objects and return only changed fields.
 */
export function getChangedFields<T extends Record<string, unknown>>(
  original: T,
  updated: T
): Partial<T> {
  const changes: Partial<T> = {};

  for (const key of Object.keys(updated) as (keyof T)[]) {
    const originalValue = original[key];
    const updatedValue = updated[key];

    if (JSON.stringify(originalValue) !== JSON.stringify(updatedValue)) {
      changes[key] = updatedValue;
    }
  }

  return changes;
}

/**
 * Merge partial update into existing object.
 */
export function mergeUpdate<T extends Record<string, unknown>>(
  original: T,
  update: Partial<T>
): T {
  return { ...original, ...update };
}

export { SHORT_KEY_MAP, LONG_KEY_MAP };
