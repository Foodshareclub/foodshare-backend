/**
 * Delta Sync Edge Function
 *
 * Provides incremental data synchronization for offline-first clients.
 * Uses version-based tracking to return only changed data since last sync.
 *
 * Endpoints:
 * - POST /sync - Get delta updates for specified tables
 * - POST /sync/pending - Submit pending offline operations
 * - GET /sync/status - Get sync status for user
 *
 * Request body for /sync:
 * {
 *   tables: ["posts", "notifications", "rooms"],
 *   checkpoints?: { posts: 123, notifications: 456 }
 * }
 *
 * Response includes:
 * - Changes per table with new checkpoint versions
 * - Conflict detection for pending operations
 * - Optimized payload (only changed fields)
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError, ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Constants
// =============================================================================

const VERSION = "2.0.0";
const ALLOWED_TABLES = ["posts", "notifications", "rooms", "profiles", "messages"] as const;

// =============================================================================
// Request Schemas
// =============================================================================

const syncRequestSchema = z.object({
  tables: z.array(z.enum(ALLOWED_TABLES)).min(1, "At least one table required"),
  checkpoints: z.record(z.number()).optional(),
});

const pendingOperationSchema = z.object({
  operationId: z.string().uuid(),
  table: z.string(),
  operation: z.enum(["insert", "update", "delete"]),
  recordId: z.string().uuid().optional(),
  data: z.record(z.unknown()).optional(),
  clientTimestamp: z.string().datetime(),
});

const pendingOperationsSchema = z.object({
  operations: z.array(pendingOperationSchema).max(100, "Maximum 100 operations per batch"),
});

type SyncRequest = z.infer<typeof syncRequestSchema>;
type PendingOperationsRequest = z.infer<typeof pendingOperationsSchema>;

// =============================================================================
// Route Detection
// =============================================================================

function getSubPath(url: URL): string {
  const pathname = url.pathname;
  const idx = pathname.indexOf("/api-v1-sync");
  if (idx === -1) return "";
  const subPath = pathname.slice(idx + 12); // Remove "/api-v1-sync"
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// =============================================================================
// Delta Sync Handler
// =============================================================================

async function handleDeltaSync(ctx: HandlerContext<SyncRequest>): Promise<Response> {
  const { supabase, userId, body, ctx: requestCtx } = ctx;
  const startTime = performance.now();

  logger.info("Processing delta sync", {
    userId: userId?.substring(0, 8),
    tables: body.tables,
    requestId: requestCtx?.requestId,
  });

  // Call the database function for delta sync
  const { data, error } = await supabase.rpc("get_delta_sync", {
    p_user_id: userId,
    p_tables: body.tables,
    p_checkpoints: body.checkpoints || {},
  });

  if (error) {
    logger.error("Delta sync failed", {
      error: error.message,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to retrieve sync data");
  }

  const dbResponse = data as {
    success: boolean;
    tables: Record<string, {
      changes: unknown[];
      checkpoint: number;
      hasMore: boolean;
    }>;
    meta: {
      totalChanges: number;
      syncedAt: string;
    };
  };

  const processingTime = Math.round(performance.now() - startTime);

  logger.info("Delta sync completed", {
    userId: userId?.substring(0, 8),
    totalChanges: dbResponse.meta?.totalChanges || 0,
    processingTime,
    requestId: requestCtx?.requestId,
  });

  return ok(
    {
      tables: dbResponse.tables,
      syncedAt: dbResponse.meta?.syncedAt || new Date().toISOString(),
      totalChanges: dbResponse.meta?.totalChanges || 0,
    },
    ctx,
    {
      uiHints: {
        refreshAfter: 30, // Suggest re-sync in 30 seconds
      },
    },
  );
}

// =============================================================================
// Pending Operations Handler
// =============================================================================

async function handlePendingOperations(
  ctx: HandlerContext<PendingOperationsRequest>,
): Promise<Response> {
  const { supabase, userId, body, ctx: requestCtx } = ctx;

  logger.info("Processing pending operations", {
    userId: userId?.substring(0, 8),
    operationCount: body.operations.length,
    requestId: requestCtx?.requestId,
  });

  if (!body.operations || body.operations.length === 0) {
    return ok({ processed: 0, results: [] }, ctx);
  }

  const results: Array<{
    operationId: string;
    status: "applied" | "conflict" | "rejected" | "pending";
    error?: string;
    serverVersion?: unknown;
    serverTimestamp?: string;
  }> = [];

  for (const op of body.operations) {
    try {
      // Step 1: Submit operation for conflict detection
      const { data: submitData, error: submitError } = await supabase.rpc(
        "submit_pending_operation",
        {
          p_user_id: userId,
          p_operation_type: op.operation,
          p_table_name: op.table,
          p_record_id: op.recordId || null,
          p_payload: op.data || {},
          p_client_timestamp: op.clientTimestamp,
        },
      );

      if (submitError) {
        results.push({
          operationId: op.operationId,
          status: "rejected",
          error: submitError.message,
        });
        continue;
      }

      const submitResult = submitData as {
        success: boolean;
        operationId: string;
        conflict?: boolean;
        serverTimestamp?: string;
        status?: string;
        message?: string;
      };

      // If conflict detected, don't apply
      if (submitResult.conflict) {
        results.push({
          operationId: op.operationId,
          status: "conflict",
          serverTimestamp: submitResult.serverTimestamp,
        });
        continue;
      }

      // Step 2: Apply the pending operation
      const { data: applyData, error: applyError } = await supabase.rpc("apply_pending_operation", {
        p_operation_id: submitResult.operationId,
      });

      if (applyError) {
        results.push({
          operationId: op.operationId,
          status: "rejected",
          error: applyError.message,
        });
        continue;
      }

      const applyResult = applyData as {
        success: boolean;
        status: "applied" | "conflict" | "rejected";
        error?: string;
      };

      results.push({
        operationId: op.operationId,
        status: applyResult.success ? "applied" : (applyResult.status || "rejected"),
        error: applyResult.error,
      });
    } catch (opError) {
      results.push({
        operationId: op.operationId,
        status: "rejected",
        error: opError instanceof Error ? opError.message : "Unknown error",
      });
    }
  }

  const applied = results.filter((r) => r.status === "applied").length;
  const conflicts = results.filter((r) => r.status === "conflict").length;
  const rejected = results.filter((r) => r.status === "rejected").length;

  logger.info("Pending operations processed", {
    userId: userId?.substring(0, 8),
    applied,
    conflicts,
    rejected,
    requestId: requestCtx?.requestId,
  });

  return ok({
    processed: results.length,
    summary: { applied, conflicts, rejected },
    results,
  }, ctx);
}

// =============================================================================
// Sync Status Handler
// =============================================================================

async function handleSyncStatus(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId, ctx: requestCtx } = ctx;

  logger.info("Getting sync status", {
    userId: userId?.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  // Get sync checkpoints for user
  const { data: checkpoints, error: checkpointError } = await supabase
    .from("sync_checkpoints")
    .select("table_name, last_sync_version, last_sync_at")
    .eq("user_id", userId);

  if (checkpointError) {
    logger.error("Failed to get sync status", {
      error: checkpointError.message,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to retrieve sync status");
  }

  // Get pending operations count
  const { count: pendingCount } = await supabase
    .from("pending_operations")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "pending");

  const checkpointMap: Record<string, { version: number; syncedAt: string }> = {};
  for (const cp of checkpoints || []) {
    checkpointMap[cp.table_name] = {
      version: cp.last_sync_version,
      syncedAt: cp.last_sync_at,
    };
  }

  return ok({
    checkpoints: checkpointMap,
    pendingOperations: pendingCount || 0,
    lastSyncAt: checkpoints && checkpoints.length > 0
      ? checkpoints.reduce(
        (latest, cp) => new Date(cp.last_sync_at) > new Date(latest) ? cp.last_sync_at : latest,
        checkpoints[0].last_sync_at,
      )
      : null,
  }, ctx);
}

// =============================================================================
// Main Router Handler
// =============================================================================

async function handlePostSync(ctx: HandlerContext): Promise<Response> {
  const { request } = ctx;
  const url = new URL(request.url);
  const subPath = getSubPath(url);

  // POST /sync/pending
  if (subPath === "pending" || subPath === "pending/") {
    const parsed = pendingOperationsSchema.safeParse(ctx.body);

    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join(", "));
    }

    return handlePendingOperations({ ...ctx, body: parsed.data });
  }

  // POST /sync - Delta sync
  const parsed = syncRequestSchema.safeParse(ctx.body);

  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors.map((e) => e.message).join(", "));
  }

  return handleDeltaSync({ ...ctx, body: parsed.data });
}

async function handleGetSync(ctx: HandlerContext): Promise<Response> {
  const { request } = ctx;
  const url = new URL(request.url);
  const subPath = getSubPath(url);

  // Health check
  if (subPath === "health" || subPath === "health/") {
    return ok({
      status: "healthy",
      service: "api-v1-sync",
      version: VERSION,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  // GET /sync/status
  if (subPath === "status" || subPath === "status/") {
    return handleSyncStatus(ctx);
  }

  // GET /sync - Not supported, return method info
  throw new ValidationError("Use POST /sync for delta sync or GET /sync/status for sync status");
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-sync",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 30,
    windowMs: 60000, // 30 sync requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      handler: handleGetSync,
    },
    POST: {
      handler: handlePostSync,
    },
  },
}));
