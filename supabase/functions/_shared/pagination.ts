/**
 * Pagination Utilities
 *
 * Provides cursor-based pagination helpers:
 * - Composite cursor support (timestamp + ID for tie-breaking)
 * - Query builder integration
 * - Next cursor extraction
 */

/**
 * Composite cursor for precise pagination
 * Uses timestamp + ID to handle items created at the same second
 */
export interface CompositeCursor {
  timestamp: string;
  id: string;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  /** Maximum items per page (default: 20, max: 100) */
  limit?: number;
  /** Cursor string from previous response */
  cursor?: string;
  /** Sort direction (default: desc for newest first) */
  direction?: "asc" | "desc";
}

/**
 * Pagination result
 */
export interface PaginationResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  total?: number;
}

/**
 * Default and maximum limits
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Encode a composite cursor to a string
 */
export function encodeCursor(cursor: CompositeCursor): string {
  const json = JSON.stringify(cursor);
  return btoa(json);
}

/**
 * Decode a cursor string to composite cursor
 */
export function decodeCursor(cursorString: string): CompositeCursor | null {
  try {
    const json = atob(cursorString);
    const parsed = JSON.parse(json);

    if (typeof parsed.timestamp === "string" && typeof parsed.id === "string") {
      return parsed as CompositeCursor;
    }

    // Handle legacy single-value cursors (just timestamp)
    if (typeof parsed === "string") {
      return { timestamp: parsed, id: "" };
    }

    return null;
  } catch {
    // Try to handle raw timestamp strings (legacy format)
    if (/^\d{4}-\d{2}-\d{2}/.test(cursorString)) {
      return { timestamp: cursorString, id: "" };
    }
    return null;
  }
}

/**
 * Normalize limit value to be within bounds
 */
export function normalizeLimit(limit?: number | string): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_LIMIT;
  }

  const parsed = typeof limit === "string" ? parseInt(limit, 10) : limit;

  if (isNaN(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Apply cursor pagination to a Supabase query builder
 *
 * @param query - Supabase query builder
 * @param options - Pagination options
 * @param timestampColumn - Column name for timestamp (default: "created_at")
 * @param idColumn - Column name for ID (default: "id")
 * @returns Modified query builder
 */
export function applyCursorPagination<
  // deno-lint-ignore no-explicit-any
  T extends {
    lt: (col: string, val: string) => T;
    gt: (col: string, val: string) => T;
    order: (col: string, opts?: { ascending?: boolean }) => T;
    limit: (n: number) => T;
    or: (filter: string) => T;
  },
>(
  query: T,
  options: PaginationOptions,
  timestampColumn = "created_at",
  idColumn = "id",
): T {
  const limit = normalizeLimit(options.limit);
  const direction = options.direction ?? "desc";
  const ascending = direction === "asc";

  // Add ordering
  query = query
    .order(timestampColumn, { ascending })
    .order(idColumn, { ascending })
    .limit(limit + 1); // Fetch one extra for hasMore check

  // Apply cursor filter
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);

    if (cursor) {
      if (cursor.id) {
        // Composite cursor - use combined filter for precise pagination
        // For descending: (timestamp < cursor.timestamp) OR (timestamp = cursor.timestamp AND id < cursor.id)
        if (ascending) {
          query = query.or(
            `${timestampColumn}.gt.${cursor.timestamp},and(${timestampColumn}.eq.${cursor.timestamp},${idColumn}.gt.${cursor.id})`,
          );
        } else {
          query = query.or(
            `${timestampColumn}.lt.${cursor.timestamp},and(${timestampColumn}.eq.${cursor.timestamp},${idColumn}.lt.${cursor.id})`,
          );
        }
      } else {
        // Simple timestamp-only cursor (legacy)
        if (ascending) {
          query = query.gt(timestampColumn, cursor.timestamp);
        } else {
          query = query.lt(timestampColumn, cursor.timestamp);
        }
      }
    }
  }

  return query;
}

/**
 * Process cursor pagination result
 *
 * @param items - Items returned from query (includes extra item for hasMore check)
 * @param limit - Requested limit
 * @param timestampColumn - Column name for timestamp
 * @param idColumn - Column name for ID
 * @returns Pagination result with items and cursor
 */
export function processCursorResult<T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  timestampColumn = "created_at",
  idColumn = "id",
): PaginationResult<T> {
  const normalizedLimit = normalizeLimit(limit);
  const hasMore = items.length > normalizedLimit;

  // Remove extra item used for hasMore check
  const resultItems = hasMore ? items.slice(0, normalizedLimit) : items;

  // Generate next cursor from last item
  let nextCursor: string | null = null;
  if (hasMore && resultItems.length > 0) {
    const lastItem = resultItems[resultItems.length - 1];
    const timestamp = lastItem[timestampColumn];
    const id = lastItem[idColumn];

    if (typeof timestamp === "string" && (typeof id === "string" || typeof id === "number")) {
      nextCursor = encodeCursor({
        timestamp,
        id: String(id),
      });
    }
  }

  return {
    items: resultItems,
    hasMore,
    nextCursor,
  };
}

/**
 * Extract cursor info from items for a given column
 */
export function extractCursor<T extends Record<string, unknown>>(
  items: T[],
  timestampColumn = "created_at",
  idColumn = "id",
): CompositeCursor | null {
  if (items.length === 0) return null;

  const lastItem = items[items.length - 1];
  const timestamp = lastItem[timestampColumn];
  const id = lastItem[idColumn];

  if (typeof timestamp !== "string") return null;
  if (typeof id !== "string" && typeof id !== "number") return null;

  return {
    timestamp,
    id: String(id),
  };
}

/**
 * Create a simple paginated query helper
 * For use with direct database calls
 */
export function createPaginationHelper(options: PaginationOptions) {
  const limit = normalizeLimit(options.limit);
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;

  return {
    limit,
    cursor,
    limitPlusOne: limit + 1,
    direction: options.direction ?? "desc",

    /**
     * Get SQL WHERE clause for cursor
     */
    getCursorWhere(
      timestampColumn = "created_at",
      idColumn = "id",
    ): string | null {
      if (!cursor) return null;

      const direction = options.direction ?? "desc";
      const compareOp = direction === "desc" ? "<" : ">";

      if (cursor.id) {
        // Composite cursor
        return `(${timestampColumn} ${compareOp} '${cursor.timestamp}' OR (${timestampColumn} = '${cursor.timestamp}' AND ${idColumn} ${compareOp} '${cursor.id}'))`;
      }

      // Simple cursor
      return `${timestampColumn} ${compareOp} '${cursor.timestamp}'`;
    },

    /**
     * Process results and generate response
     */
    processResults<T extends Record<string, unknown>>(
      items: T[],
      timestampColumn = "created_at",
      idColumn = "id",
    ): PaginationResult<T> {
      return processCursorResult(items, limit, timestampColumn, idColumn);
    },
  };
}

/**
 * Offset-based pagination helper (for backward compatibility)
 */
export interface OffsetPaginationOptions {
  offset?: number;
  limit?: number;
}

export interface OffsetPaginationResult<T> {
  items: T[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
}

/**
 * Create offset pagination info
 */
export function createOffsetPagination<T>(
  items: T[],
  options: OffsetPaginationOptions,
  total: number,
): OffsetPaginationResult<T> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = normalizeLimit(options.limit);
  const hasMore = offset + items.length < total;

  return {
    items,
    pagination: {
      offset,
      limit,
      total,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
  };
}

/**
 * Parse pagination params from query string
 */
export function parsePaginationParams(
  query: Record<string, string>,
): PaginationOptions {
  return {
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    cursor: query.cursor,
    direction: query.direction === "asc" ? "asc" : "desc",
  };
}
