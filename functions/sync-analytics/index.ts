/**
 * Sync Analytics Edge Function
 *
 * Syncs data from Supabase to MotherDuck for analytics.
 * Supports both full and incremental sync strategies.
 *
 * Features:
 * - Incremental sync using updated_at timestamps
 * - Full sync option for initial setup or recovery
 * - Batch processing to handle large datasets
 * - Safe string escaping for SQL
 * - Sync metadata tracking
 *
 * Usage:
 * POST /sync-analytics - Incremental sync (default)
 * POST /sync-analytics?mode=full - Full replenish sync
 * GET /sync-analytics - Incremental sync (for cron)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

// =============================================================================
// Inline CORS (self-contained)
// =============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "3.1.0",
  batchSize: 500,
  defaultIncrementalHours: 24, // Look back 24 hours for incremental sync
};

// =============================================================================
// Response Types
// =============================================================================

interface SyncResponse {
  success: boolean;
  mode: "full" | "incremental";
  synced: {
    users: number;
    listings: number;
  };
  durationMs?: number;
  lastSyncAt?: string;
}

// =============================================================================
// Helper: Create Supabase Client
// =============================================================================

function createSupabaseClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, supabaseKey);
}

// =============================================================================
// Helper: Get Secret from Vault
// =============================================================================

async function getVaultSecret(supabase: ReturnType<typeof createClient>, secretName: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("get_vault_secret", { secret_name: secretName });
  if (error) {
    console.error(`Failed to get secret ${secretName}:`, error.message);
    return null;
  }
  return data;
}

// =============================================================================
// MotherDuck Helper
// =============================================================================

async function executeMotherDuckQuery(token: string, sql: string): Promise<unknown> {
  const response = await fetch("https://api.motherduck.com/v1/sql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MotherDuck API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// =============================================================================
// String Escape Helper
// =============================================================================

function escapeValue(s: unknown): string {
  if (s === null || s === undefined) return "NULL";
  if (typeof s === "boolean") return s ? "TRUE" : "FALSE";
  if (typeof s === "number") return String(s);
  return `'${String(s).replace(/'/g, "''")}'`;
}

// =============================================================================
// Schema Setup
// =============================================================================

async function ensureSchema(mdToken: string): Promise<void> {
  // Create users table with proper schema matching Supabase profiles
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS full_users (
      id VARCHAR PRIMARY KEY,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      email VARCHAR,
      nickname VARCHAR,
      first_name VARCHAR,
      second_name VARCHAR,
      is_active BOOLEAN,
      is_verified BOOLEAN,
      last_seen_at TIMESTAMP,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  // Create listings table with proper schema matching Supabase posts
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS full_listings (
      id BIGINT PRIMARY KEY,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      post_name VARCHAR,
      post_type VARCHAR,
      is_active BOOLEAN,
      is_arranged BOOLEAN,
      post_arranged_at TIMESTAMP,
      profile_id VARCHAR,
      post_views INTEGER,
      post_like_counter INTEGER,
      latitude DOUBLE,
      longitude DOUBLE,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  // Create events table for tracking
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS events (
      id VARCHAR PRIMARY KEY,
      event_name VARCHAR,
      user_id VARCHAR,
      properties VARCHAR,
      timestamp TIMESTAMP,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  // Create sync metadata table
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS sync_metadata (
      table_name VARCHAR PRIMARY KEY,
      last_sync_at TIMESTAMP,
      records_synced INTEGER,
      sync_mode VARCHAR
    )
    `
  );
}

// =============================================================================
// Get Last Sync Time
// =============================================================================

async function getLastSyncTime(mdToken: string, tableName: string): Promise<Date | null> {
  try {
    const result = await executeMotherDuckQuery(
      mdToken,
      `SELECT last_sync_at FROM sync_metadata WHERE table_name = '${tableName}'`
    ) as { data?: Array<{ last_sync_at: string }> };

    if (result.data && result.data.length > 0 && result.data[0].last_sync_at) {
      return new Date(result.data[0].last_sync_at);
    }
  } catch {
    // Table might not exist yet, return null
  }
  return null;
}

// =============================================================================
// Update Sync Metadata
// =============================================================================

async function updateSyncMetadata(
  mdToken: string,
  tableName: string,
  recordsSynced: number,
  syncMode: string
): Promise<void> {
  await executeMotherDuckQuery(
    mdToken,
    `
    INSERT OR REPLACE INTO sync_metadata (table_name, last_sync_at, records_synced, sync_mode)
    VALUES ('${tableName}', CURRENT_TIMESTAMP, ${recordsSynced}, '${syncMode}')
    `
  );
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleSyncAnalytics(request: Request): Promise<Response> {
  const startTime = performance.now();

  // Determine sync mode from query params
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "full" ? "full" : "incremental";

  console.log(`Starting analytics sync: mode=${mode}`);

  const supabase = createSupabaseClient();

  // Get MotherDuck token from Vault
  const mdToken = await getVaultSecret(supabase, "MOTHERDUCK_TOKEN");
  if (!mdToken) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing MOTHERDUCK_TOKEN in Vault" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Ensure schema exists
  await ensureSchema(mdToken);

  let usersCount = 0;
  let listingsCount = 0;

  if (mode === "full") {
    // Full sync: Delete and replenish
    await executeMotherDuckQuery(mdToken, "DELETE FROM full_users");
    await executeMotherDuckQuery(mdToken, "DELETE FROM full_listings");

    // Fetch all profiles
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, created_time, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at");

    if (profilesError) throw profilesError;

    // Fetch all posts with coordinates from posts_with_location view
    const { data: posts, error: postsError } = await supabase
      .from("posts_with_location")
      .select("id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude");

    if (postsError) throw postsError;

    // Insert users in batches
    if (profiles && profiles.length > 0) {
      for (let i = 0; i < profiles.length; i += CONFIG.batchSize) {
        const batch = profiles.slice(i, i + CONFIG.batchSize);
        const values = batch
          .map(
            (p) =>
              `(${escapeValue(p.id)}, ${escapeValue(p.created_time)}, ${escapeValue(p.updated_at)}, ${escapeValue(p.email)}, ${escapeValue(p.nickname)}, ${escapeValue(p.first_name)}, ${escapeValue(p.second_name)}, ${escapeValue(p.is_active)}, ${escapeValue(p.is_verified)}, ${escapeValue(p.last_seen_at)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(
          mdToken,
          `INSERT INTO full_users (id, created_at, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at, synced_at) VALUES ${values}`
        );
      }
      usersCount = profiles.length;
    }

    // Insert listings in batches
    if (posts && posts.length > 0) {
      for (let i = 0; i < posts.length; i += CONFIG.batchSize) {
        const batch = posts.slice(i, i + CONFIG.batchSize);
        const values = batch
          .map(
            (p) =>
              `(${p.id}, ${escapeValue(p.created_at)}, ${escapeValue(p.updated_at)}, ${escapeValue(p.post_name)}, ${escapeValue(p.post_type)}, ${escapeValue(p.is_active)}, ${escapeValue(p.is_arranged)}, ${escapeValue(p.post_arranged_at)}, ${escapeValue(p.profile_id)}, ${p.post_views || 0}, ${p.post_like_counter || 0}, ${escapeValue(p.latitude)}, ${escapeValue(p.longitude)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(
          mdToken,
          `INSERT INTO full_listings (id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude, synced_at) VALUES ${values}`
        );
      }
      listingsCount = posts.length;
    }
  } else {
    // Incremental sync: Only sync records updated since last sync
    const lastUserSync = await getLastSyncTime(mdToken, "full_users");
    const lastListingSync = await getLastSyncTime(mdToken, "full_listings");

    // Default to 24 hours ago if no previous sync
    const defaultLookback = new Date(Date.now() - CONFIG.defaultIncrementalHours * 60 * 60 * 1000);
    const userSyncFrom = lastUserSync || defaultLookback;
    const listingSyncFrom = lastListingSync || defaultLookback;

    // Fetch updated profiles
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, created_time, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at")
      .gte("updated_at", userSyncFrom.toISOString());

    if (profilesError) throw profilesError;

    // Fetch updated posts with coordinates from posts_with_location view
    const { data: posts, error: postsError } = await supabase
      .from("posts_with_location")
      .select("id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude")
      .gte("updated_at", listingSyncFrom.toISOString());

    if (postsError) throw postsError;

    // Upsert users (delete then insert for simplicity with DuckDB)
    if (profiles && profiles.length > 0) {
      const ids = profiles.map((p) => escapeValue(p.id)).join(",");
      await executeMotherDuckQuery(mdToken, `DELETE FROM full_users WHERE id IN (${ids})`);

      for (let i = 0; i < profiles.length; i += CONFIG.batchSize) {
        const batch = profiles.slice(i, i + CONFIG.batchSize);
        const values = batch
          .map(
            (p) =>
              `(${escapeValue(p.id)}, ${escapeValue(p.created_time)}, ${escapeValue(p.updated_at)}, ${escapeValue(p.email)}, ${escapeValue(p.nickname)}, ${escapeValue(p.first_name)}, ${escapeValue(p.second_name)}, ${escapeValue(p.is_active)}, ${escapeValue(p.is_verified)}, ${escapeValue(p.last_seen_at)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(
          mdToken,
          `INSERT INTO full_users (id, created_at, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at, synced_at) VALUES ${values}`
        );
      }
      usersCount = profiles.length;
    }

    // Upsert listings
    if (posts && posts.length > 0) {
      const ids = posts.map((p) => p.id).join(",");
      await executeMotherDuckQuery(mdToken, `DELETE FROM full_listings WHERE id IN (${ids})`);

      for (let i = 0; i < posts.length; i += CONFIG.batchSize) {
        const batch = posts.slice(i, i + CONFIG.batchSize);
        const values = batch
          .map(
            (p) =>
              `(${p.id}, ${escapeValue(p.created_at)}, ${escapeValue(p.updated_at)}, ${escapeValue(p.post_name)}, ${escapeValue(p.post_type)}, ${escapeValue(p.is_active)}, ${escapeValue(p.is_arranged)}, ${escapeValue(p.post_arranged_at)}, ${escapeValue(p.profile_id)}, ${p.post_views || 0}, ${p.post_like_counter || 0}, ${escapeValue(p.latitude)}, ${escapeValue(p.longitude)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(
          mdToken,
          `INSERT INTO full_listings (id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude, synced_at) VALUES ${values}`
        );
      }
      listingsCount = posts.length;
    }
  }

  // Update sync metadata
  await updateSyncMetadata(mdToken, "full_users", usersCount, mode);
  await updateSyncMetadata(mdToken, "full_listings", listingsCount, mode);

  const durationMs = Math.round(performance.now() - startTime);

  console.log(`Analytics sync complete: mode=${mode}, users=${usersCount}, listings=${listingsCount}, duration=${durationMs}ms`);

  const response: SyncResponse = {
    success: true,
    mode,
    synced: {
      users: usersCount,
      listings: listingsCount,
    },
    durationMs,
    lastSyncAt: new Date().toISOString(),
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(async (request: Request): Promise<Response> => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only allow GET and POST
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(
      JSON.stringify({ success: false, error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    return await handleSyncAnalytics(request);
  } catch (error) {
    console.error("Sync analytics error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
