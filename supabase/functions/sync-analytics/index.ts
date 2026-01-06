/**
 * Sync Analytics Edge Function v5.2.0
 *
 * Computes analytics from Supabase data and stores in PostgreSQL staging tables.
 * A separate sync job (GitHub Actions + Python/DuckDB) pulls from these tables to MotherDuck.
 *
 * Architecture:
 * 1. Edge Function: Supabase → PostgreSQL (analytics_* tables)
 * 2. GitHub Actions: PostgreSQL → MotherDuck (via Python + DuckDB)
 *
 * Why this approach:
 * - MotherDuck has no REST SQL API for writes
 * - DuckDB native bindings don't work in Deno/Edge Functions
 * - MotherDuck WASM requires browser features (SharedArrayBuffer)
 *
 * Usage:
 * POST /sync-analytics - Incremental sync (default)
 * POST /sync-analytics?mode=full - Full recompute
 * GET /sync-analytics - Incremental sync (for cron)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CONFIG = {
  version: "5.2.0",
  defaultLookbackDays: 7,
  maxUsersPerSync: 100, // Limit to avoid compute limits
};

interface SyncResponse {
  success: boolean;
  mode: "full" | "incremental";
  stats: {
    daysProcessed: number;
    usersUpdated: number;
    postsAnalyzed: number;
  };
  durationMs?: number;
  lastSyncAt?: string;
  note?: string;
}

function createSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, supabaseKey);
}


// =============================================================================
// Compute Daily Stats → PostgreSQL
// =============================================================================

async function computeDailyStats(
  supabase: ReturnType<typeof createClient>,
  date: string
): Promise<void> {
  const { count: newUsers } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .gte("created_time", `${date}T00:00:00Z`)
    .lt("created_time", `${date}T23:59:59Z`);

  const { count: activeUsers } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .gte("last_seen_at", `${date}T00:00:00Z`)
    .lt("last_seen_at", `${date}T23:59:59Z`);

  const { count: newListings } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .gte("created_at", `${date}T00:00:00Z`)
    .lt("created_at", `${date}T23:59:59Z`);

  const { count: completedShares } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .eq("is_arranged", true)
    .gte("post_arranged_at", `${date}T00:00:00Z`)
    .lt("post_arranged_at", `${date}T23:59:59Z`);

  const { count: messagesSent } = await supabase
    .from("room_participants")
    .select("*", { count: "exact", head: true })
    .gte("timestamp", `${date}T00:00:00Z`)
    .lt("timestamp", `${date}T23:59:59Z`);

  const { data: categoryData } = await supabase
    .from("posts")
    .select("post_type")
    .gte("created_at", `${date}T00:00:00Z`)
    .lt("created_at", `${date}T23:59:59Z`);

  const categoryCounts: Record<string, number> = {};
  if (categoryData) {
    for (const post of categoryData) {
      const type = post.post_type || "unknown";
      categoryCounts[type] = (categoryCounts[type] || 0) + 1;
    }
  }

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));

  // Upsert to PostgreSQL staging table
  await supabase.from("analytics_daily_stats").upsert(
    {
      date,
      new_users: newUsers || 0,
      active_users: activeUsers || 0,
      returning_users: Math.max(0, (activeUsers || 0) - (newUsers || 0)),
      new_listings: newListings || 0,
      completed_shares: completedShares || 0,
      messages_sent: messagesSent || 0,
      top_categories: topCategories,
      computed_at: new Date().toISOString(),
      synced_to_motherduck: false,
    },
    { onConflict: "date" }
  );
}

// =============================================================================
// Update User Activity Summaries → PostgreSQL (Optimized)
// =============================================================================

async function updateUserActivitySummaries(
  supabase: ReturnType<typeof createClient>,
  sinceDate: string
): Promise<number> {
  // Limit users to avoid compute limits
  const { data: activeProfiles } = await supabase
    .from("profiles")
    .select("id, last_seen_at")
    .gte("last_seen_at", sinceDate)
    .order("last_seen_at", { ascending: false })
    .limit(CONFIG.maxUsersPerSync);

  if (!activeProfiles || activeProfiles.length === 0) {
    return 0;
  }

  // Batch fetch all counts in parallel for each user
  const updates = await Promise.all(
    activeProfiles.map(async (profile) => {
      const [viewsRes, savesRes, msgsRes, sharesRes] = await Promise.all([
        supabase.from("post_views").select("*", { count: "exact", head: true }).eq("viewer_id", profile.id),
        supabase.from("post_bookmarks").select("*", { count: "exact", head: true }).eq("profile_id", profile.id),
        supabase.from("rooms").select("*", { count: "exact", head: true }).eq("requester", profile.id),
        supabase.from("posts").select("*", { count: "exact", head: true }).eq("profile_id", profile.id).eq("is_arranged", true),
      ]);

      return {
        user_id: profile.id,
        listings_viewed: viewsRes.count || 0,
        listings_saved: savesRes.count || 0,
        messages_initiated: msgsRes.count || 0,
        shares_completed: sharesRes.count || 0,
        last_activity_at: profile.last_seen_at,
        updated_at: new Date().toISOString(),
        synced_to_motherduck: false,
      };
    })
  );

  // Batch upsert
  await supabase.from("analytics_user_activity").upsert(updates, { onConflict: "user_id" });

  return updates.length;
}


// =============================================================================
// Compute Post Analytics → PostgreSQL
// =============================================================================

async function computePostAnalytics(
  supabase: ReturnType<typeof createClient>,
  sinceDate: string
): Promise<number> {
  const { data: posts } = await supabase
    .from("posts")
    .select("id, post_views, post_like_counter, is_arranged, post_type")
    .gte("updated_at", sinceDate);

  if (!posts || posts.length === 0) {
    return 0;
  }

  const typeStats: Record<string, { views: number; likes: number; arranged: number; count: number }> = {};

  for (const post of posts) {
    const type = post.post_type || "unknown";
    if (!typeStats[type]) {
      typeStats[type] = { views: 0, likes: 0, arranged: 0, count: 0 };
    }
    typeStats[type].views += post.post_views || 0;
    typeStats[type].likes += post.post_like_counter || 0;
    typeStats[type].arranged += post.is_arranged ? 1 : 0;
    typeStats[type].count += 1;
  }

  const today = new Date().toISOString().split("T")[0];

  for (const [postType, stats] of Object.entries(typeStats)) {
    const id = `${today}_${postType}`;
    await supabase.from("analytics_post_activity").upsert(
      {
        id,
        date: today,
        post_type: postType,
        posts_viewed: stats.views,
        posts_arranged: stats.arranged,
        total_likes: stats.likes,
        updated_at: new Date().toISOString(),
        synced_to_motherduck: false,
      },
      { onConflict: "id" }
    );
  }

  return posts.length;
}

// =============================================================================
// Handler
// =============================================================================

async function handleSyncAnalytics(request: Request): Promise<Response> {
  const startTime = performance.now();

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "full" ? "full" : "incremental";

  console.log(`Starting analytics sync: mode=${mode}, version=${CONFIG.version}`);

  const supabase = createSupabaseClient();

  let daysProcessed = 0;
  let usersUpdated = 0;
  let postsAnalyzed = 0;

  try {
    const lookbackDays = mode === "full" ? 30 : CONFIG.defaultLookbackDays;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - lookbackDays);

    // Compute daily stats
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split("T")[0];
      await computeDailyStats(supabase, dateStr);
      daysProcessed++;
    }

    // Update user activity summaries
    const lookbackDate = startDate.toISOString();
    usersUpdated = await updateUserActivitySummaries(supabase, lookbackDate);

    // Compute post analytics
    postsAnalyzed = await computePostAnalytics(supabase, lookbackDate);

    const durationMs = Math.round(performance.now() - startTime);

    console.log(
      `Analytics sync complete: mode=${mode}, days=${daysProcessed}, users=${usersUpdated}, posts=${postsAnalyzed}, duration=${durationMs}ms`
    );

    const response: SyncResponse = {
      success: true,
      mode,
      stats: {
        daysProcessed,
        usersUpdated,
        postsAnalyzed,
      },
      durationMs,
      lastSyncAt: new Date().toISOString(),
      note: "Data staged in PostgreSQL. Run sync-to-motherduck script to push to MotherDuck.",
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Analytics sync error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return await handleSyncAnalytics(request);
});
