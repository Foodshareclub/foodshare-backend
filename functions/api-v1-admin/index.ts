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

import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
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
  supabase: ReturnType<typeof getSupabaseClient>
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
    (r) => (r.roles as unknown as { name: string }).name
  );
  const isAdmin = roles.includes("admin") || roles.includes("superadmin");

  if (!isAdmin) {
    return { authenticated: false, error: "Admin access required" };
  }

  return { authenticated: true, adminId: user.id };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400
): Response {
  return jsonResponse({ success: false, error }, corsHeaders, status);
}

// =============================================================================
// Route Parser
// =============================================================================

interface ParsedRoute {
  resource: string;
  segments: string[];
  method: string;
}

function parseRoute(url: URL, method: string): ParsedRoute {
  const path = url.pathname
    .replace(/^\/api-v1-admin\/?/, "")
    .replace(/^\/+/, "");

  const segments = path.split("/").filter(Boolean);
  const resource = segments[0] || "";

  return { resource, segments, method };
}

// =============================================================================
// Main Router
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const startTime = performance.now();
  const requestId = crypto.randomUUID();
  const corsHeaders = getCorsHeaders(req);

  const url = new URL(req.url);
  const route = parseRoute(url, req.method);

  try {
    // Health check (no auth required)
    if (route.resource === "health" || route.resource === "") {
      return jsonResponse({
        status: "healthy",
        version: VERSION,
        service: SERVICE,
        timestamp: new Date().toISOString(),
      }, corsHeaders);
    }

    // Authenticate admin
    const supabase = getSupabaseClient();
    const auth = await authenticateAdmin(req, supabase);

    if (!auth.authenticated) {
      logger.warn("Admin auth failed", {
        requestId,
        path: url.pathname,
        error: auth.error,
      });
      return errorResponse(auth.error || "Unauthorized", corsHeaders, 401);
    }

    const context: AdminContext = {
      supabase,
      requestId,
      adminId: auth.adminId!,
      corsHeaders,
    };

    logger.info("Admin request", {
      requestId,
      path: url.pathname,
      method: req.method,
      adminId: auth.adminId,
    });

    // Route to appropriate handler
    let body: unknown = null;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      body = await req.json().catch(() => ({}));
    }

    const query = Object.fromEntries(url.searchParams);

    switch (route.resource) {
      case "users":
        return await handleUsersRoute(route.segments.slice(1), req.method, body, query, context);

      case "listings":
        return await handleListingsRoute(route.segments.slice(1), req.method, body, context);

      default:
        return jsonResponse({
          success: false,
          error: "Not found",
          availableResources: ["users", "listings", "health"],
        }, corsHeaders, 404);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Admin request failed", err, {
      requestId,
      path: url.pathname,
    });

    const status = err.name === "ForbiddenError" ? 403
      : err.name === "NotFoundError" ? 404
      : err.name === "ValidationError" ? 400
      : 500;

    return jsonResponse({
      success: false,
      error: err.message,
      requestId,
    }, corsHeaders, status);
  } finally {
    const duration = performance.now() - startTime;
    if (duration > 3000) {
      logger.warn("Slow admin request", {
        requestId,
        path: url.pathname,
        durationMs: Math.round(duration),
      });
    }
  }
});
