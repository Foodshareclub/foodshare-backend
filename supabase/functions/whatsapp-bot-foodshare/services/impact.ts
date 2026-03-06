/**
 * Impact statistics service adapted for WhatsApp
 */

import type { ImpactStats } from "../types/index.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

/**
 * Get user impact stats by profile ID
 */
export async function getUserImpactStats(profileId: string): Promise<ImpactStats> {
  const supabase = getSupabaseClient();

  // Get the profile
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, created_time")
    .eq("id", profileId)
    .single();

  if (profileError || !profile) {
    return {
      foodsShared: 0,
      foodsClaimed: 0,
      kgSaved: 0,
      co2Saved: 0,
      moneySaved: 0,
      memberSince: "Unknown",
      activeDays: 0,
    };
  }

  // Run queries in parallel
  const [sharedResult, claimedResult] = await Promise.all([
    // Get shared food count
    supabase
      .from("posts")
      .select("*", { count: "exact", head: true })
      .eq("profile_id", profile.id)
      .eq("post_type", "food"),

    // Get claimed food count
    supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("sender_id", profile.id),
  ]);

  const sharedCount = sharedResult.count || 0;
  const claimedCount = claimedResult.count || 0;

  // Estimate impact (average food item = 0.5kg, CO2 = 2.5kg per kg food)
  const kgSaved = sharedCount * 0.5;
  const co2Saved = kgSaved * 2.5;
  const moneySaved = kgSaved * 5;

  return {
    foodsShared: sharedCount,
    foodsClaimed: claimedCount,
    kgSaved: Math.round(kgSaved * 10) / 10,
    co2Saved: Math.round(co2Saved * 10) / 10,
    moneySaved: Math.round(moneySaved),
    memberSince: profile.created_time
      ? new Date(profile.created_time).toLocaleDateString()
      : "Unknown",
    activeDays: 0,
  };
}

/**
 * Get badges based on impact stats
 */
export function getBadges(stats: ImpactStats): string[] {
  const badges: string[] = [];

  if (stats.foodsShared >= 50) badges.push("Super Sharer");
  else if (stats.foodsShared >= 20) badges.push("Active Sharer");
  else if (stats.foodsShared >= 5) badges.push("Sharer");

  if (stats.foodsClaimed >= 30) badges.push("Food Rescuer");
  else if (stats.foodsClaimed >= 10) badges.push("Active Claimer");

  if (stats.kgSaved >= 25) badges.push("Eco Warrior");
  else if (stats.kgSaved >= 10) badges.push("Green Hero");

  if (stats.activeDays >= 30) badges.push("30-Day Streak");
  else if (stats.activeDays >= 7) badges.push("Weekly Active");

  return badges;
}

/**
 * Format badges as string
 */
export function formatBadges(stats: ImpactStats): string {
  const badges = getBadges(stats);
  if (badges.length === 0) return "";
  return badges.join(" | ");
}
