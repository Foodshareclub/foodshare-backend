/**
 * Display Name API v1
 *
 * REST API for display name operations.
 *
 * Endpoints:
 * - GET    /api-v1-display-name/:userId     - Get display name for a user
 * - POST   /api-v1-display-name/batch       - Batch lookup (max 100)
 * - PUT    /api-v1-display-name/:userId     - Set admin override (admin only)
 * - DELETE /api-v1-display-name/:userId     - Remove admin override (admin only)
 * - GET    /api-v1-display-name/metrics     - Get service metrics
 *
 * @module api-v1-display-name
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  noContent,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { ValidationError, AuthorizationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import {
  getDisplayNameService,
  UserNotFoundError,
  BatchSizeExceededError,
} from "../_shared/display-name/index.ts";

// =============================================================================
// Schemas
// =============================================================================

const pathParamSchema = z.object({
  userId: z.string().uuid().optional(),
});

const batchLookupSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(100),
});

const setOverrideSchema = z.object({
  displayName: z.string().min(2).max(100),
  reason: z.string().min(1).max(500),
  expiresAt: z.string().datetime().optional(),
});

const querySchema = z.object({
  action: z.enum(["batch", "metrics"]).optional(),
});

type PathParams = z.infer<typeof pathParamSchema>;
type BatchLookupBody = z.infer<typeof batchLookupSchema>;
type SetOverrideBody = z.infer<typeof setOverrideSchema>;
type QueryParams = z.infer<typeof querySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * Get display name for a single user
 */
async function getDisplayName(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, request } = ctx;

  // Extract userId from path
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const userId = pathParts[pathParts.length - 1];

  if (!userId || userId === "api-v1-display-name") {
    throw new ValidationError("User ID is required in path");
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    throw new ValidationError("Invalid user ID format");
  }

  const service = getDisplayNameService(supabase);

  try {
    const result = await service.getDisplayName(userId);
    return ok(result, ctx);
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      throw error;
    }
    throw error;
  }
}

/**
 * Get service metrics
 */
async function getMetrics(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId } = ctx;

  // Metrics are available to authenticated users
  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const service = getDisplayNameService(supabase);
  const metrics = service.getMetrics();

  return ok({
    ...metrics,
    version: service.getVersion(),
  }, ctx);
}

/**
 * Batch lookup for multiple users
 */
async function batchLookup(ctx: HandlerContext<BatchLookupBody>): Promise<Response> {
  const { supabase, body, userId } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const service = getDisplayNameService(supabase);

  try {
    const result = await service.getDisplayNameBatch(body.userIds);
    return ok(result, ctx);
  } catch (error) {
    if (error instanceof BatchSizeExceededError) {
      throw error;
    }
    throw error;
  }
}

/**
 * Set admin override for a user's display name
 */
async function setOverride(ctx: HandlerContext<SetOverrideBody>): Promise<Response> {
  const { supabase, body, userId, request } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Check if user is admin
  const { data: adminCheck } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();

  if (!adminCheck?.is_admin) {
    throw new AuthorizationError("Admin access required");
  }

  // Extract target userId from path
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const targetUserId = pathParts[pathParts.length - 1];

  if (!targetUserId || targetUserId === "api-v1-display-name") {
    throw new ValidationError("Target user ID is required in path");
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(targetUserId)) {
    throw new ValidationError("Invalid target user ID format");
  }

  const service = getDisplayNameService(supabase);

  const result = await service.setAdminOverride(
    targetUserId,
    body.displayName,
    body.reason,
    userId,
    body.expiresAt
  );

  logger.info("Admin override set", {
    targetUserId,
    adminUserId: userId,
    displayName: body.displayName,
  });

  return ok(result, ctx);
}

/**
 * Remove admin override
 */
async function removeOverride(ctx: HandlerContext<unknown>): Promise<Response> {
  const { supabase, userId, request } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Check if user is admin
  const { data: adminCheck } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .single();

  if (!adminCheck?.is_admin) {
    throw new AuthorizationError("Admin access required");
  }

  // Extract target userId from path
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const targetUserId = pathParts[pathParts.length - 1];

  if (!targetUserId || targetUserId === "api-v1-display-name") {
    throw new ValidationError("Target user ID is required in path");
  }

  const service = getDisplayNameService(supabase);

  await service.removeAdminOverride(targetUserId);

  logger.info("Admin override removed", {
    targetUserId,
    adminUserId: userId,
  });

  return noContent(ctx);
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { query, request } = ctx;

  // Check for special actions
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  if (lastPart === "metrics" || query.action === "metrics") {
    return getMetrics(ctx);
  }

  return getDisplayName(ctx);
}

async function handlePost(ctx: HandlerContext<BatchLookupBody, QueryParams>): Promise<Response> {
  const { query, request } = ctx;

  // Check for batch action
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1];

  if (lastPart === "batch" || query.action === "batch") {
    return batchLookup(ctx);
  }

  throw new ValidationError("Invalid action. Use /batch for batch lookups");
}

async function handlePut(ctx: HandlerContext<SetOverrideBody>): Promise<Response> {
  return setOverride(ctx);
}

async function handleDelete(ctx: HandlerContext<unknown>): Promise<Response> {
  return removeOverride(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-display-name",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 100,
    windowMs: 60000, // 100 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema,
      handler: handleGet,
    },
    POST: {
      schema: batchLookupSchema,
      querySchema,
      handler: handlePost,
    },
    PUT: {
      schema: setOverrideSchema,
      handler: handlePut,
    },
    DELETE: {
      handler: handleDelete,
    },
  },
});
