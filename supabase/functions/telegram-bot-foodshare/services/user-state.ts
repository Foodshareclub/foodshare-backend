/**
 * User state management service with TTL support
 * Prevents stuck states by auto-expiring after timeout
 */

import { logger } from "../../_shared/logger.ts";
import type { UserState } from "../types/index.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

// TTL configuration (in minutes)
const STATE_TTL = {
  default: 30,
  awaiting_email: 15,
  awaiting_verification: 15,
  awaiting_verification_link: 15,
  sharing_food: 60, // Give more time for multi-step food sharing
  setting_radius: 10,
  updating_profile_location: 10,
};

/**
 * Get TTL in minutes based on state action
 */
function getTTLMinutes(action?: string): number {
  if (!action) return STATE_TTL.default;
  return STATE_TTL[action as keyof typeof STATE_TTL] || STATE_TTL.default;
}

/**
 * Get user state with automatic expiration check
 * Returns null if state is expired (and deletes it)
 */
export async function getUserState(userId: number): Promise<UserState | null> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("telegram_user_states")
      .select("state, expires_at")
      .eq("user_id", userId)
      .single();

    if (error || !data) return null;

    // Check if state has expired
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at);
      if (expiresAt < new Date()) {
        // State expired - clean it up
        logger.info("State expired for user, cleaning up", { userId });
        await deleteUserState(userId);
        return null;
      }
    }

    return data.state;
  } catch (error) {
    logger.error("Error getting user state", { error: String(error) });
    return null;
  }
}

/**
 * Delete user state
 */
async function deleteUserState(userId: number): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    await supabase.from("telegram_user_states").delete().eq("user_id", userId);
  } catch (error) {
    logger.error("Error deleting user state", { error: String(error) });
  }
}

/**
 * Set user state with automatic TTL
 */
export async function setUserState(userId: number, state: UserState | null): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    if (state === null) {
      await deleteUserState(userId);
    } else {
      const ttlMinutes = getTTLMinutes(state.action);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      await supabase.from("telegram_user_states").upsert({
        user_id: userId,
        state: state,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    logger.error("Error setting user state", { error: String(error) });
    throw error; // Re-throw to let caller handle
  }
}

/**
 * Clean up all expired states (can be called periodically)
 */
export async function cleanupExpiredStates(): Promise<number> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("telegram_user_states")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("user_id");

    if (error) {
      logger.error("Error cleaning up expired states", { error: String(error) });
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      logger.info("Cleaned up expired user states", { count });
    }
    return count;
  } catch (error) {
    logger.error("Error in cleanupExpiredStates", { error: String(error) });
    return 0;
  }
}
