/**
 * Shared Bot User State Factory
 *
 * Generic user state management with TTL support for bot services.
 * Eliminates duplication between Telegram and WhatsApp bots.
 *
 * Usage:
 * ```ts
 * const stateService = createBotUserStateService<TelegramUserState>({
 *   tableName: "telegram_user_states",
 *   idColumn: "user_id",
 * });
 * const state = await stateService.get(userId);
 * ```
 */

import { logger } from "../logger.ts";
import { getSupabaseClient } from "../supabase.ts";

// =============================================================================
// Types
// =============================================================================

export interface BotUserStateConfig {
  /** Database table name (e.g., "telegram_user_states") */
  tableName: string;
  /** Column name for the identifier (e.g., "user_id" or "phone_number") */
  idColumn: string;
  /** TTL config by action name (in minutes) */
  ttlConfig?: Record<string, number>;
  /** Default TTL in minutes */
  defaultTTL?: number;
}

// =============================================================================
// Default TTL Config
// =============================================================================

const DEFAULT_STATE_TTL: Record<string, number> = {
  default: 30,
  awaiting_email: 15,
  awaiting_verification: 15,
  awaiting_verification_link: 15,
  sharing_food: 60,
  setting_radius: 10,
  updating_profile_location: 10,
};

// =============================================================================
// Factory
// =============================================================================

export function createBotUserStateService<TState extends { action?: string }>(
  config: BotUserStateConfig,
) {
  const {
    tableName,
    idColumn,
    ttlConfig = DEFAULT_STATE_TTL,
    defaultTTL = 30,
  } = config;

  function getTTLMinutes(action?: string): number {
    if (!action) return defaultTTL;
    return ttlConfig[action] ?? defaultTTL;
  }

  /**
   * Get user state with automatic expiration check
   */
  async function get(id: string | number): Promise<TState | null> {
    const supabase = getSupabaseClient();

    try {
      const { data, error } = await supabase
        .from(tableName)
        .select("state, expires_at")
        .eq(idColumn, id)
        .single();

      if (error || !data) return null;

      // Check if state has expired
      if (data.expires_at) {
        const expiresAt = new Date(data.expires_at);
        if (expiresAt < new Date()) {
          logger.info("Bot state expired, cleaning up", {
            table: tableName,
            id: String(id).substring(0, 8),
          });
          await remove(id);
          return null;
        }
      }

      return data.state as TState;
    } catch (error) {
      logger.error("Error getting bot user state", { table: tableName, error: String(error) });
      return null;
    }
  }

  /**
   * Set user state with automatic TTL
   */
  async function set(id: string | number, state: TState | null): Promise<void> {
    const supabase = getSupabaseClient();

    try {
      if (state === null) {
        await remove(id);
      } else {
        const ttlMinutes = getTTLMinutes(state.action);
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

        await supabase.from(tableName).upsert({
          [idColumn]: id,
          state: state,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error("Error setting bot user state", { table: tableName, error: String(error) });
      throw error;
    }
  }

  /**
   * Delete user state
   */
  async function remove(id: string | number): Promise<void> {
    const supabase = getSupabaseClient();
    try {
      await supabase.from(tableName).delete().eq(idColumn, id);
    } catch (error) {
      logger.error("Error deleting bot user state", { table: tableName, error: String(error) });
    }
  }

  /**
   * Clean up all expired states
   */
  async function cleanup(): Promise<number> {
    const supabase = getSupabaseClient();

    try {
      const { data, error } = await supabase
        .from(tableName)
        .delete()
        .lt("expires_at", new Date().toISOString())
        .select(idColumn);

      if (error) {
        logger.error("Error cleaning up expired bot states", {
          table: tableName,
          error: String(error),
        });
        return 0;
      }

      const count = data?.length || 0;
      if (count > 0) {
        logger.info("Cleaned up expired bot user states", { table: tableName, count });
      }
      return count;
    } catch (error) {
      logger.error("Error in bot state cleanup", { table: tableName, error: String(error) });
      return 0;
    }
  }

  return { get, set, remove, cleanup };
}
