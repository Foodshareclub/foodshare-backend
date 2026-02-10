/**
 * User state management service for WhatsApp
 * Uses phone number as identifier instead of user ID
 */

import { logger } from "../../_shared/logger.ts";
import type { UserState } from "../types/index.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

// TTL configuration (in minutes)
const STATE_TTL = {
  default: 30,
  awaiting_email: 15,
  awaiting_verification: 15,
  sharing_food: 60,
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
 */
export async function getUserState(phoneNumber: string): Promise<UserState | null> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("whatsapp_user_states")
      .select("state, expires_at")
      .eq("phone_number", phoneNumber)
      .single();

    if (error || !data) return null;

    // Check if state has expired
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at);
      if (expiresAt < new Date()) {
        logger.info("State expired, cleaning up", { phone: phoneNumber.substring(0, 4) + "***" });
        await deleteUserState(phoneNumber);
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
async function deleteUserState(phoneNumber: string): Promise<void> {
  const supabase = getSupabaseClient();
  try {
    await supabase.from("whatsapp_user_states").delete().eq("phone_number", phoneNumber);
  } catch (error) {
    logger.error("Error deleting user state", { error: String(error) });
  }
}

/**
 * Set user state with automatic TTL
 */
export async function setUserState(phoneNumber: string, state: UserState | null): Promise<void> {
  const supabase = getSupabaseClient();

  try {
    if (state === null) {
      await deleteUserState(phoneNumber);
    } else {
      const ttlMinutes = getTTLMinutes(state.action);
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      await supabase.from("whatsapp_user_states").upsert({
        phone_number: phoneNumber,
        state: state,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    logger.error("Error setting user state", { error: String(error) });
    throw error;
  }
}

/**
 * Clean up all expired states
 */
export async function cleanupExpiredStates(): Promise<number> {
  const supabase = getSupabaseClient();

  try {
    const { data, error } = await supabase
      .from("whatsapp_user_states")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("phone_number");

    if (error) {
      logger.error("Error cleaning up expired states", { error: String(error) });
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      logger.info("Cleaned up expired WhatsApp user states", { count });
    }
    return count;
  } catch (error) {
    logger.error("Error in cleanupExpiredStates", { error: String(error) });
    return 0;
  }
}
