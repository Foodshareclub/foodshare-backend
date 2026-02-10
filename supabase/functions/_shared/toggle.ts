/**
 * Generic Toggle Row Utility
 *
 * Implements the check-exists / delete-or-insert toggle pattern
 * used by likes, bookmarks, and similar entities.
 *
 * Used by: api-v1-engagement
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { logger } from "./logger.ts";

export interface ToggleConfig {
  /** Table name (e.g. "post_likes", "post_bookmarks") */
  table: string;
  /** Column name for the entity ID (e.g. "post_id") */
  entityColumn: string;
  /** Column name for the user ID (e.g. "profile_id") */
  userColumn: string;
}

export interface ToggleResult {
  /** Whether the row now exists (true = added, false = removed) */
  active: boolean;
}

/**
 * Toggle a row in a table: delete if exists, insert if not.
 *
 * @example
 * ```ts
 * const result = await toggleRow(supabase, {
 *   table: "post_likes",
 *   entityColumn: "post_id",
 *   userColumn: "profile_id",
 * }, postId, userId);
 * // result.active === true means "liked", false means "unliked"
 * ```
 */
export async function toggleRow(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  config: ToggleConfig,
  entityId: number | string,
  userId: string,
): Promise<ToggleResult> {
  const { table, entityColumn, userColumn } = config;

  // Check if already exists
  const { data: existing } = await supabase
    .from(table)
    .select("id")
    .eq(entityColumn, entityId)
    .eq(userColumn, userId)
    .single();

  if (existing) {
    // Remove
    await supabase
      .from(table)
      .delete()
      .eq(entityColumn, entityId)
      .eq(userColumn, userId);

    logger.debug("Toggle removed", { table, entityId, userId: userId.substring(0, 8) });
    return { active: false };
  }

  // Insert
  await supabase.from(table).insert({
    [entityColumn]: entityId,
    [userColumn]: userId,
  });

  logger.debug("Toggle added", { table, entityId, userId: userId.substring(0, 8) });
  return { active: true };
}
