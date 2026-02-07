/**
 * Feature Flags API v1
 *
 * Provides feature flags, A/B experiments, and version compatibility checking.
 * Integrates with database functions for deterministic rollout and targeting.
 *
 * Routes:
 * - GET /                      - Get all flags for current user
 * - GET /experiments/:key      - Get/assign experiment variant
 * - GET /compatibility         - Check app version compatibility
 * - GET /health                - Health check
 *
 * Headers:
 * - X-Platform: ios | android | web
 * - X-App-Version: semver string (e.g., "1.2.3")
 *
 * @module api-v1-feature-flags
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { NotFoundError, ServerError, UnauthorizedError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "1.0.0";

// =============================================================================
// Query Schemas
// =============================================================================

const flagsQuerySchema = z.object({
  platform: z.string().optional(),
  version: z.string().optional(),
  action: z.string().optional(),
  experimentKey: z.string().optional(),
});

type FlagsQuery = z.infer<typeof flagsQuerySchema>;

// =============================================================================
// Route Detection
// =============================================================================

function getSubPath(url: URL): string {
  const pathname = url.pathname;
  // Match against function name in path
  const marker = "/api-v1-feature-flags";
  const idx = pathname.indexOf(marker);
  if (idx === -1) return "";
  const subPath = pathname.slice(idx + marker.length);
  return subPath.startsWith("/") ? subPath.slice(1) : subPath;
}

// =============================================================================
// Feature Flags Handler
// =============================================================================

async function handleGetFeatureFlags(ctx: HandlerContext<unknown, FlagsQuery>): Promise<Response> {
  const { supabase, userId, query, request, ctx: requestCtx } = ctx;

  const platform = request.headers.get("X-Platform") || query.platform || "unknown";
  const appVersion = request.headers.get("X-App-Version") || query.version || null;

  logger.info("Getting feature flags", {
    userId: userId?.substring(0, 8),
    platform,
    requestId: requestCtx?.requestId,
  });

  const { data, error } = await supabase.rpc("get_user_feature_flags", {
    p_user_id: userId || null,
    p_platform: platform,
    p_app_version: appVersion,
  });

  if (error) {
    logger.error("Failed to get feature flags", {
      error: error.message,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to retrieve feature flags");
  }

  const dbResponse = data as {
    success: boolean;
    flags: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
    context: { platform: string; appVersion: string; userHash: number };
    meta: { timestamp: string; refreshAfter: number; cacheTTL: number };
  };

  return ok(
    {
      flags: dbResponse.flags,
      context: dbResponse.context,
    },
    ctx,
    {
      cacheTTL: dbResponse.meta?.cacheTTL || 60,
      uiHints: {
        refreshAfter: dbResponse.meta?.refreshAfter || 300,
      },
    },
  );
}

// =============================================================================
// Experiment Variant Handler
// =============================================================================

async function handleExperimentVariant(
  ctx: HandlerContext<unknown, FlagsQuery>,
  experimentKey: string,
): Promise<Response> {
  const { supabase, userId, ctx: requestCtx } = ctx;

  if (!userId) {
    throw new UnauthorizedError("Authentication required for experiments");
  }

  logger.info("Getting experiment variant", {
    userId: userId.substring(0, 8),
    experimentKey,
    requestId: requestCtx?.requestId,
  });

  const { data, error } = await supabase.rpc("get_experiment_variant", {
    p_user_id: userId,
    p_experiment_key: experimentKey,
  });

  if (error) {
    logger.error("Failed to get experiment variant", {
      error: error.message,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to get experiment variant");
  }

  const dbResponse = data as {
    success: boolean;
    experimentKey: string;
    variant: string | null;
    assignedAt?: string;
    isNewAssignment?: boolean;
    reason?: string;
    error?: string;
  };

  if (!dbResponse.success) {
    throw new NotFoundError("Experiment", experimentKey);
  }

  return ok(
    {
      experimentKey: dbResponse.experimentKey,
      variant: dbResponse.variant,
      assignedAt: dbResponse.assignedAt,
      isNewAssignment: dbResponse.isNewAssignment || false,
      reason: dbResponse.reason,
    },
    ctx,
  );
}

// =============================================================================
// Compatibility Check Handler
// =============================================================================

async function handleCompatibilityCheck(
  ctx: HandlerContext<unknown, FlagsQuery>,
): Promise<Response> {
  const { supabase, query, request, ctx: requestCtx } = ctx;

  const platform = request.headers.get("X-Platform") || query.platform || "unknown";
  const version = request.headers.get("X-App-Version") || query.version || "1.0.0";

  logger.info("Checking client compatibility", {
    platform,
    version,
    requestId: requestCtx?.requestId,
  });

  const { data, error } = await supabase.rpc("check_client_compatibility", {
    p_platform: platform,
    p_version: version,
  });

  if (error) {
    logger.error("Failed to check compatibility", {
      error: error.message,
      requestId: requestCtx?.requestId,
    });
    throw new ServerError("Failed to check compatibility");
  }

  const dbResponse = data as {
    success: boolean;
    supported: boolean;
    needsUpdate: boolean;
    forceUpdate: boolean;
    currentVersion: string;
    minVersion: string;
    recommendedVersion: string;
    message: string | null;
  };

  return ok(
    {
      supported: dbResponse.supported,
      needsUpdate: dbResponse.needsUpdate,
      forceUpdate: dbResponse.forceUpdate,
      versions: {
        current: dbResponse.currentVersion,
        minimum: dbResponse.minVersion,
        recommended: dbResponse.recommendedVersion,
      },
      message: dbResponse.message,
      action: dbResponse.forceUpdate
        ? "force_update"
        : dbResponse.needsUpdate
          ? "suggest_update"
          : "none",
    },
    ctx,
  );
}

// =============================================================================
// Main Router Handler
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, FlagsQuery>): Promise<Response> {
  const { request, query } = ctx;
  const url = new URL(request.url);
  const subPath = getSubPath(url);

  // GET /health
  if (subPath === "health" || subPath === "health/") {
    return ok({ status: "ok", version: VERSION }, ctx);
  }

  // GET /compatibility
  if (subPath === "compatibility" || subPath === "compatibility/" || query.action === "compatibility") {
    return handleCompatibilityCheck(ctx);
  }

  // GET /experiments/:key or ?experimentKey=...
  if (subPath.startsWith("experiments") || query.experimentKey) {
    const experimentKey = query.experimentKey || subPath.split("/").pop() || "";
    if (experimentKey && experimentKey !== "experiments") {
      return handleExperimentVariant(ctx, experimentKey);
    }
  }

  // GET / — all flags
  return handleGetFeatureFlags(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-feature-flags",
  version: VERSION,
  requireAuth: false, // Auth is optional — flags work for anonymous users too
  rateLimit: {
    limit: 60,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema: flagsQuerySchema,
      handler: handleGet,
    },
  },
});
