/**
 * Sync Analytics Edge Function
 *
 * Syncs data from Supabase to MotherDuck for analytics.
 * Performs full snapshot sync of users and listings.
 *
 * Features:
 * - Batch processing to handle large datasets
 * - Safe string escaping for SQL
 * - Full replenish strategy
 *
 * Usage:
 * POST /sync-analytics
 * GET /sync-analytics (for cron)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  batchSize: 500,
};

// =============================================================================
// Response Types
// =============================================================================

interface SyncResponse {
  success: boolean;
  synced: {
    users: number;
    listings: number;
  };
  durationMs?: number;
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
  return `'${String(s).replace(/'/g, "''")}'`;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleSyncAnalytics(ctx: HandlerContext): Promise<Response> {
  const { supabase, ctx: requestCtx } = ctx;
  const startTime = performance.now();

  logger.info("Starting analytics sync", {
    requestId: requestCtx?.requestId,
  });

  const mdToken = Deno.env.get("MOTHERDUCK_TOKEN");
  if (!mdToken) {
    throw new ServerError("Missing MOTHERDUCK_TOKEN");
  }

  // Fetch data from Supabase
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, created_at, role, full_name, email");

  if (profilesError) throw profilesError;

  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("id, created_at, title, status, profile_id, type");

  if (postsError) throw postsError;

  logger.info("Fetched data from Supabase", {
    profiles: profiles?.length || 0,
    posts: posts?.length || 0,
  });

  // Create/clear users table
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS full_users (
      id VARCHAR,
      created_at TIMESTAMP,
      role VARCHAR,
      full_name VARCHAR,
      email VARCHAR,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  await executeMotherDuckQuery(mdToken, "DELETE FROM full_users");

  // Bulk insert users in batches
  if (profiles && profiles.length > 0) {
    for (let i = 0; i < profiles.length; i += CONFIG.batchSize) {
      const batch = profiles.slice(i, i + CONFIG.batchSize);
      const values = batch
        .map(
          (p) =>
            `(${escapeValue(p.id)}, ${escapeValue(p.created_at)}, ${escapeValue(p.role)}, ${escapeValue(p.full_name)}, ${escapeValue(p.email)}, CURRENT_TIMESTAMP)`
        )
        .join(",");

      await executeMotherDuckQuery(mdToken, `INSERT INTO full_users VALUES ${values}`);
    }
  }

  // Create/clear listings table
  await executeMotherDuckQuery(
    mdToken,
    `
    CREATE TABLE IF NOT EXISTS full_listings (
      id BIGINT,
      created_at TIMESTAMP,
      title VARCHAR,
      status VARCHAR,
      profile_id VARCHAR,
      type VARCHAR,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  await executeMotherDuckQuery(mdToken, "DELETE FROM full_listings");

  // Bulk insert listings in batches
  if (posts && posts.length > 0) {
    for (let i = 0; i < posts.length; i += CONFIG.batchSize) {
      const batch = posts.slice(i, i + CONFIG.batchSize);
      const values = batch
        .map(
          (p) =>
            `(${p.id}, ${escapeValue(p.created_at)}, ${escapeValue(p.title)}, ${escapeValue(p.status)}, ${escapeValue(p.profile_id)}, ${escapeValue(p.type)}, CURRENT_TIMESTAMP)`
        )
        .join(",");

      await executeMotherDuckQuery(mdToken, `INSERT INTO full_listings VALUES ${values}`);
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  logger.info("Analytics sync complete", {
    users: profiles?.length || 0,
    listings: posts?.length || 0,
    durationMs,
  });

  const response: SyncResponse = {
    success: true,
    synced: {
      users: profiles?.length || 0,
      listings: posts?.length || 0,
    },
    durationMs,
  };

  return ok(response, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "sync-analytics",
  version: CONFIG.version,
  requireAuth: false, // Cron job - service-level
  routes: {
    POST: {
      handler: handleSyncAnalytics,
    },
    GET: {
      handler: handleSyncAnalytics, // Support GET for cron
    },
  },
});
