/**
 * Aggregation utilities for BFF-style responses
 * Consolidates multiple queries into single responses
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

export async function aggregateCounts(supabase: SupabaseClient, userId: string) {
  const [notifications, messages, requests] = await Promise.all([
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq(
      "user_id",
      userId,
    ).eq("read", false),
    supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq(
      "recipient_id",
      userId,
    ).eq("read", false),
    supabase.from("listing_requests").select("id", { count: "exact", head: true }).eq(
      "owner_id",
      userId,
    ).eq("status", "pending"),
  ]);

  return {
    notifications: notifications.count || 0,
    messages: messages.count || 0,
    requests: requests.count || 0,
  };
}

export async function aggregateStats(supabase: SupabaseClient, userId: string) {
  const [shared, received, active, ratings] = await Promise.all([
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq(
      "status",
      "completed",
    ),
    supabase.from("listing_requests").select("id", { count: "exact", head: true }).eq(
      "requester_id",
      userId,
    ).eq("status", "completed"),
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("user_id", userId).eq(
      "status",
      "active",
    ),
    supabase.from("reviews").select("rating").eq("reviewee_id", userId),
  ]);

  const avgRating = ratings.data?.length
    ? ratings.data.reduce((sum, r) => sum + r.rating, 0) / ratings.data.length
    : null;

  return {
    itemsShared: shared.count || 0,
    itemsReceived: received.count || 0,
    activeListings: active.count || 0,
    rating: avgRating,
    ratingCount: ratings.data?.length || 0,
  };
}

export async function aggregateImpact(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("user_impact")
    .select("food_saved_kg, co2_saved_kg, meals_provided")
    .eq("user_id", userId)
    .single();

  return data || { food_saved_kg: 0, co2_saved_kg: 0, meals_provided: 0 };
}
