/**
 * Unified Admin API v1
 *
 * Enterprise-grade admin management consolidating ALL admin operations:
 * - Listings: CRUD, activate/deactivate, bulk operations
 * - Users: List, roles, ban/unban
 * - Reports: View, resolve (future)
 * - Analytics: Dashboard stats (future)
 *
 * Routes:
 * - GET    /health
 * - GET    /users
 * - PUT    /users/:id/role
 * - PUT    /users/:id/roles
 * - POST   /users/:id/ban
 * - POST   /users/:id/unban
 * - PUT    /listings/:id
 * - PUT    /listings/:id/activate
 * - PUT    /listings/:id/deactivate
 * - PUT    /listings/:id/notes
 * - DELETE /listings/:id
 * - POST   /listings/bulk/activate
 * - POST   /listings/bulk/deactivate
 * - POST   /listings/bulk/delete
 *
 * @module api-v1-admin
 * @version 1.0.0
 */

import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { AppError, AuthenticationError } from "../_shared/errors.ts";
import { parseRoute } from "../_shared/routing.ts";
import { handleListingsRoute } from "./lib/listings.ts";
import { handleUsersRoute } from "./lib/users.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-admin";

// =============================================================================
// Types
// =============================================================================

export interface AdminContext {
  supabase: ReturnType<typeof getSupabaseClient>;
  requestId: string;
  adminId: string;
  corsHeaders: Record<string, string>;
}

// =============================================================================
// Admin Auth
// =============================================================================

async function authenticateAdmin(
  req: Request,
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<{ authenticated: boolean; adminId?: string; error?: string }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { authenticated: false, error: "Missing authorization header" };
  }

  const token = authHeader.slice(7);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return { authenticated: false, error: "Invalid token" };
  }

  // Check admin role
  const { data: userRoles, error: roleError } = await supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", user.id);

  if (roleError) {
    return { authenticated: false, error: "Failed to verify admin access" };
  }

  const roles = (userRoles || []).map(
    (r) => (r.roles as unknown as { name: string }).name,
  );
  const isAdmin = roles.includes("admin") || roles.includes("superadmin");

  if (!isAdmin) {
    return { authenticated: false, error: "Admin access required" };
  }

  return { authenticated: true, adminId: user.id };
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleRequest(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const route = parseRoute(url, ctx.request.method, SERVICE);
  const requestId = ctx.ctx.requestId;

  // Health check (no auth required)
  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  // Authenticate admin
  const supabase = getSupabaseClient();
  const auth = await authenticateAdmin(ctx.request, supabase);

  if (!auth.authenticated) {
    logger.warn("Admin auth failed", {
      requestId,
      path: url.pathname,
      error: auth.error,
    });
    throw new AuthenticationError(auth.error || "Unauthorized");
  }

  const context: AdminContext = {
    supabase,
    requestId,
    adminId: auth.adminId!,
    corsHeaders: ctx.corsHeaders,
  };

  logger.info("Admin request", {
    requestId,
    path: url.pathname,
    method: ctx.request.method,
    adminId: auth.adminId,
  });

  // Route to appropriate handler
  let body: unknown = null;
  if (["POST", "PUT", "PATCH"].includes(ctx.request.method)) {
    body = ctx.body;
  }

  const query = Object.fromEntries(url.searchParams);

  switch (route.resource) {
    case "users":
      return await handleUsersRoute(
        route.segments.slice(1),
        ctx.request.method,
        body,
        query,
        context,
      );

    case "listings":
      return await handleListingsRoute(route.segments.slice(1), ctx.request.method, body, context);

    default:
      throw new AppError("Not found", "NOT_FOUND", 404, {
        details: { availableResources: ["users", "listings", "health"] },
      });
  }
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false, // Admin auth handled per-route above
  csrf: true,
  rateLimit: {
    limit: 30,
    windowMs: 60_000,
    keyBy: "user",
  },
  routes: {
    GET: { handler: handleRequest },
    POST: { handler: handleRequest },
    PUT: { handler: handleRequest },
    DELETE: { handler: handleRequest },
  },
}));
