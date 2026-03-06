/**
 * Pagination Zod Schemas
 *
 * Shared cursor/offset pagination query schemas.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Cursor-based Pagination
// =============================================================================

/** Standard cursor pagination query params (strings from query string) */
export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// =============================================================================
// Offset-based Pagination
// =============================================================================

/** Standard offset pagination query params */
export const offsetPaginationSchema = z.object({
  limit: z.string().optional(),
  offset: z.string().optional(),
});
