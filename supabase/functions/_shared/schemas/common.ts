/**
 * Common Zod Schemas
 *
 * Shared validation schemas used across multiple Edge Functions.
 * Centralizes frequently duplicated patterns.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Primitive Schemas
// =============================================================================

/** UUID v4 string */
export const uuidSchema = z.string().uuid();

/** Email address */
export const emailSchema = z.string().email();

/** ISO 8601 datetime string */
export const datetimeSchema = z.string().datetime();

/** Positive integer (e.g., post IDs, category IDs) */
export const positiveIntSchema = z.number().int().positive();

/** URL string */
export const urlSchema = z.string().url();

// =============================================================================
// Re-export z for convenience
// =============================================================================

export { z };
