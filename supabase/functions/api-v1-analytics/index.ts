/**
 * Analytics Sync API v1
 *
 * Syncs data from Supabase to MotherDuck for analytics.
 * Supports full and incremental sync strategies with batch processing.
 *
 * Routes:
 * - GET  / - Sync status (last sync times, record counts)
 * - GET  /health - Health check
 * - POST /sync - Trigger sync (mode=full|incremental)
 * - POST /sync (GET for cron compat) - Incremental sync
 *
 * @module api-v1-analytics
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError } from "../_shared/errors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "1.0.0",
  batchSize: 500,
  defaultIncrementalHours: 24,
};

// =============================================================================
// Schemas
// =============================================================================

const syncSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
});

type SyncRequest = z.infer<typeof syncSchema>;

// =============================================================================
// MotherDuck Client
// =============================================================================

async function getMotherDuckToken(): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("get_vault_secret", {
    secret_name: "MOTHERDUCK_TOKEN",
  });

  if (error || !data) {
    throw new ServerError("Missing MOTHERDUCK_TOKEN in Vault");
  }

  return data;
}

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
    throw new ServerError(`MotherDuck API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// =============================================================================
// Helpers
// =============================================================================

function escapeValue(s: unknown): string {
  if (s === null || s === undefined) return "NULL";
  if (typeof s === "boolean") return s ? "TRUE" : "FALSE";
  if (typeof s === "number") return String(s);
  return `'${String(s).replace(/'/g, "''")}'`;
}

function getServiceRoleClient() {
  return getSupabaseClient();
}

// =============================================================================
// Schema Setup
// =============================================================================

async function ensureSchema(mdToken: string): Promise<void> {
  await executeMotherDuckQuery(
    mdToken,
    `CREATE TABLE IF NOT EXISTS full_users (
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
    )`,
  );

  await executeMotherDuckQuery(
    mdToken,
    `CREATE TABLE IF NOT EXISTS full_listings (
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
    )`,
  );

  await executeMotherDuckQuery(
    mdToken,
    `CREATE TABLE IF NOT EXISTS events (
      id VARCHAR PRIMARY KEY,
      event_name VARCHAR,
      user_id VARCHAR,
      properties VARCHAR,
      timestamp TIMESTAMP,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  await executeMotherDuckQuery(
    mdToken,
    `CREATE TABLE IF NOT EXISTS sync_metadata (
      table_name VARCHAR PRIMARY KEY,
      last_sync_at TIMESTAMP,
      records_synced INTEGER,
      sync_mode VARCHAR
    )`,
  );
}

// =============================================================================
// Sync Metadata
// =============================================================================

async function getLastSyncTime(mdToken: string, tableName: string): Promise<Date | null> {
  try {
    const result = (await executeMotherDuckQuery(
      mdToken,
      `SELECT last_sync_at FROM sync_metadata WHERE table_name = '${tableName}'`,
    )) as { data?: Array<{ last_sync_at: string }> };

    if (result.data && result.data.length > 0 && result.data[0].last_sync_at) {
      return new Date(result.data[0].last_sync_at);
    }
  } catch {
    // Table might not exist yet
  }
  return null;
}

async function updateSyncMetadata(
  mdToken: string,
  tableName: string,
  recordsSynced: number,
  syncMode: string,
): Promise<void> {
  await executeMotherDuckQuery(
    mdToken,
    `INSERT OR REPLACE INTO sync_metadata (table_name, last_sync_at, records_synced, sync_mode)
     VALUES ('${tableName}', CURRENT_TIMESTAMP, ${recordsSynced}, '${syncMode}')`,
  );
}

async function getSyncStatus(mdToken: string): Promise<Array<Record<string, unknown>>> {
  try {
    const result = (await executeMotherDuckQuery(
      mdToken,
      `SELECT table_name, last_sync_at, records_synced, sync_mode FROM sync_metadata ORDER BY table_name`,
    )) as { data?: Array<Record<string, unknown>> };
    return result.data || [];
  } catch {
    return [];
  }
}

// =============================================================================
// Batch Sync Logic
// =============================================================================

async function syncUsers(
  mdToken: string,
  mode: "full" | "incremental",
): Promise<number> {
  const supabase = getServiceRoleClient();

  if (mode === "full") {
    await executeMotherDuckQuery(mdToken, "DELETE FROM full_users");
  }

  let query = supabase
    .from("profiles")
    .select(
      "id, created_time, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at",
    );

  if (mode === "incremental") {
    const lastSync = await getLastSyncTime(mdToken, "full_users");
    const syncFrom = lastSync ||
      new Date(Date.now() - CONFIG.defaultIncrementalHours * 60 * 60 * 1000);
    query = query.gte("updated_at", syncFrom.toISOString());
  }

  const { data: profiles, error } = await query;
  if (error) throw new ServerError(`Failed to fetch profiles: ${error.message}`);
  if (!profiles || profiles.length === 0) return 0;

  // Incremental: delete existing records before re-inserting
  if (mode === "incremental") {
    const ids = profiles.map((p) => escapeValue(p.id)).join(",");
    await executeMotherDuckQuery(mdToken, `DELETE FROM full_users WHERE id IN (${ids})`);
  }

  for (let i = 0; i < profiles.length; i += CONFIG.batchSize) {
    const batch = profiles.slice(i, i + CONFIG.batchSize);
    const values = batch
      .map(
        (p) =>
          `(${escapeValue(p.id)}, ${escapeValue(p.created_time)}, ${escapeValue(p.updated_at)}, ${
            escapeValue(p.email)
          }, ${escapeValue(p.nickname)}, ${escapeValue(p.first_name)}, ${
            escapeValue(p.second_name)
          }, ${escapeValue(p.is_active)}, ${escapeValue(p.is_verified)}, ${
            escapeValue(p.last_seen_at)
          }, CURRENT_TIMESTAMP)`,
      )
      .join(",");

    await executeMotherDuckQuery(
      mdToken,
      `INSERT INTO full_users (id, created_at, updated_at, email, nickname, first_name, second_name, is_active, is_verified, last_seen_at, synced_at) VALUES ${values}`,
    );
  }

  return profiles.length;
}

async function syncListings(
  mdToken: string,
  mode: "full" | "incremental",
): Promise<number> {
  const supabase = getServiceRoleClient();

  if (mode === "full") {
    await executeMotherDuckQuery(mdToken, "DELETE FROM full_listings");
  }

  let query = supabase
    .from("posts_with_location")
    .select(
      "id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude",
    );

  if (mode === "incremental") {
    const lastSync = await getLastSyncTime(mdToken, "full_listings");
    const syncFrom = lastSync ||
      new Date(Date.now() - CONFIG.defaultIncrementalHours * 60 * 60 * 1000);
    query = query.gte("updated_at", syncFrom.toISOString());
  }

  const { data: posts, error } = await query;
  if (error) throw new ServerError(`Failed to fetch listings: ${error.message}`);
  if (!posts || posts.length === 0) return 0;

  // Incremental: delete existing records before re-inserting
  if (mode === "incremental") {
    const ids = posts.map((p) => p.id).join(",");
    await executeMotherDuckQuery(mdToken, `DELETE FROM full_listings WHERE id IN (${ids})`);
  }

  for (let i = 0; i < posts.length; i += CONFIG.batchSize) {
    const batch = posts.slice(i, i + CONFIG.batchSize);
    const values = batch
      .map(
        (p) =>
          `(${p.id}, ${escapeValue(p.created_at)}, ${escapeValue(p.updated_at)}, ${
            escapeValue(p.post_name)
          }, ${escapeValue(p.post_type)}, ${escapeValue(p.is_active)}, ${
            escapeValue(p.is_arranged)
          }, ${escapeValue(p.post_arranged_at)}, ${escapeValue(p.profile_id)}, ${
            p.post_views || 0
          }, ${p.post_like_counter || 0}, ${escapeValue(p.latitude)}, ${
            escapeValue(p.longitude)
          }, CURRENT_TIMESTAMP)`,
      )
      .join(",");

    await executeMotherDuckQuery(
      mdToken,
      `INSERT INTO full_listings (id, created_at, updated_at, post_name, post_type, is_active, is_arranged, post_arranged_at, profile_id, post_views, post_like_counter, latitude, longitude, synced_at) VALUES ${values}`,
    );
  }

  return posts.length;
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGetStatus(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // GET /health
  if (path.endsWith("/health")) {
    return ok({ status: "ok", version: CONFIG.version }, ctx);
  }

  // GET / — return sync status, or trigger incremental sync for cron
  const isCron = ctx.headers.get("x-supabase-cron") === "true" ||
    url.searchParams.get("cron") === "true";

  if (isCron) {
    return handleSync({
      ...ctx,
      body: { mode: "incremental" as const },
    } as HandlerContext<SyncRequest>);
  }

  // Return sync status
  const mdToken = await getMotherDuckToken();
  const syncStatus = await getSyncStatus(mdToken);

  return ok({
    version: CONFIG.version,
    tables: syncStatus,
  }, ctx);
}

async function handleSync(ctx: HandlerContext<SyncRequest>): Promise<Response> {
  const startTime = performance.now();
  const mode = ctx.body.mode || "incremental";

  logger.info("Starting analytics sync", { mode });

  const mdToken = await getMotherDuckToken();
  await ensureSchema(mdToken);

  const usersCount = await syncUsers(mdToken, mode);
  const listingsCount = await syncListings(mdToken, mode);

  await updateSyncMetadata(mdToken, "full_users", usersCount, mode);
  await updateSyncMetadata(mdToken, "full_listings", listingsCount, mode);

  const durationMs = Math.round(performance.now() - startTime);

  logger.info("Analytics sync complete", {
    mode,
    users: usersCount,
    listings: listingsCount,
    durationMs,
  });

  return ok(
    {
      mode,
      synced: { users: usersCount, listings: listingsCount },
      durationMs,
      lastSyncAt: new Date().toISOString(),
    },
    ctx,
  );
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-analytics",
  version: CONFIG.version,
  requireAuth: false, // Cron + internal; auth handled at config.toml level
  csrf: false, // Service-to-service / cron function
  rateLimit: {
    limit: 10,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGetStatus,
    },
    POST: {
      schema: syncSchema,
      handler: handleSync,
    },
  },
}));
