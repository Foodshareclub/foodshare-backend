/**
 * Admin Users API
 *
 * Edge Function for admin user management operations.
 * Provides role management, ban/unban functionality.
 *
 * Routes:
 * - GET / - List users with filters
 * - PUT /:id/role - Update user role
 * - PUT /:id/roles - Update multiple user roles
 * - POST /:id/ban - Ban user
 * - POST /:id/unban - Unban user
 */

import { createAPIHandler, ok, paginated, type HandlerContext } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Schemas
// =============================================================================

const listUsersQuerySchema = z.object({
  search: z.string().max(100).optional(),
  role: z.string().max(50).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const updateRoleSchema = z.object({
  role: z.string().min(1).max(50),
});

const updateRolesSchema = z.object({
  roles: z.record(z.string(), z.boolean()),
});

const banUserSchema = z.object({
  reason: z.string().min(1).max(500),
});

// =============================================================================
// Admin Auth Helper
// =============================================================================

async function requireAdmin(ctx: HandlerContext): Promise<string> {
  if (!ctx.userId) {
    throw new ForbiddenError("Authentication required");
  }

  const { data: userRoles, error } = await ctx.supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", ctx.userId);

  if (error) {
    logger.error("Failed to check admin role", { error: error.message });
    throw new ForbiddenError("Failed to verify admin access");
  }

  const roles = (userRoles || []).map(
    (r) => (r.roles as unknown as { name: string }).name
  );
  const isAdmin = roles.includes("admin") || roles.includes("superadmin");

  if (!isAdmin) {
    throw new ForbiddenError("Admin access required");
  }

  return ctx.userId;
}

// =============================================================================
// Audit Logging
// =============================================================================

async function logAdminAction(
  ctx: HandlerContext,
  action: string,
  resourceType: string,
  resourceId: string,
  adminId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await ctx.supabase.rpc("log_audit_event", {
      p_user_id: adminId,
      p_action: action,
      p_resource_type: resourceType,
      p_resource_id: resourceId,
      p_metadata: metadata,
    });
  } catch (error) {
    logger.warn("Failed to log admin action", { action, error });
  }
}

// =============================================================================
// Handlers
// =============================================================================

async function handleRequest(ctx: HandlerContext): Promise<Response> {
  const adminId = await requireAdmin(ctx);
  const url = new URL(ctx.request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  const functionIndex = pathParts.findIndex((p) => p === "api-v1-admin-users");
  const subPath = pathParts.slice(functionIndex + 1);

  // GET / - List users
  if (ctx.request.method === "GET" && subPath.length === 0) {
    return handleListUsers(ctx, adminId);
  }

  // Operations on specific user
  const userId = subPath[0];
  if (!userId || !isValidUUID(userId)) {
    return new Response(JSON.stringify({ error: "Invalid user ID" }), {
      status: 400,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  const action = subPath[1];

  switch (ctx.request.method) {
    case "PUT":
      if (action === "role") {
        return handleUpdateRole(ctx, userId, adminId);
      } else if (action === "roles") {
        return handleUpdateRoles(ctx, userId, adminId);
      }
      break;
    case "POST":
      if (action === "ban") {
        return handleBanUser(ctx, userId, adminId);
      } else if (action === "unban") {
        return handleUnbanUser(ctx, userId, adminId);
      }
      break;
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

async function handleListUsers(
  ctx: HandlerContext,
  _adminId: string
): Promise<Response> {
  const queryParams = listUsersQuerySchema.parse(ctx.query);

  const page = parseInt(queryParams.page || "1", 10);
  const limit = Math.min(parseInt(queryParams.limit || "20", 10), 100);
  const offset = (page - 1) * limit;

  let query = ctx.supabase
    .from("profiles")
    .select("id, first_name, second_name, email, created_time, is_active", { count: "exact" });

  if (queryParams.search) {
    const safeSearch = queryParams.search.replace(/[%_]/g, "\\$&");
    query = query.or(
      `first_name.ilike.%${safeSearch}%,second_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`
    );
  }

  if (queryParams.isActive !== undefined) {
    query = query.eq("is_active", queryParams.isActive === "true");
  }

  query = query.order("created_time", { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  // Get product counts and roles for each user
  const usersWithData = await Promise.all(
    (data ?? []).map(async (user) => {
      const [{ count: productsCount }, { data: userRoles }] = await Promise.all([
        ctx.supabase
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("profile_id", user.id),
        ctx.supabase
          .from("user_roles")
          .select("roles!inner(name)")
          .eq("profile_id", user.id),
      ]);

      const roles = (userRoles ?? [])
        .map((r) => {
          const roleData = r.roles as unknown as { name: string } | { name: string }[];
          return Array.isArray(roleData) ? roleData[0]?.name : roleData?.name;
        })
        .filter(Boolean) as string[];

      return {
        id: user.id,
        firstName: user.first_name,
        secondName: user.second_name,
        email: user.email,
        createdTime: user.created_time,
        isActive: user.is_active,
        productsCount: productsCount ?? 0,
        roles,
      };
    })
  );

  // Filter by role if specified
  let filteredUsers = usersWithData;
  if (queryParams.role && queryParams.role !== "all") {
    filteredUsers = usersWithData.filter((u) => u.roles?.includes(queryParams.role!));
  }

  return paginated(filteredUsers, ctx, {
    offset,
    limit,
    total: count ?? 0,
  });
}

async function handleUpdateRole(
  ctx: HandlerContext,
  userId: string,
  adminId: string
): Promise<Response> {
  // Prevent changing own role
  if (userId === adminId) {
    throw new ValidationError("Cannot change your own role");
  }

  const input = updateRoleSchema.parse(ctx.body);

  // Get role_id from roles table
  const { data: roleData, error: roleError } = await ctx.supabase
    .from("roles")
    .select("id")
    .eq("name", input.role)
    .single();

  if (roleError || !roleData) {
    throw new NotFoundError(`Role '${input.role}' not found`);
  }

  // Upsert into user_roles
  const { error } = await ctx.supabase
    .from("user_roles")
    .upsert(
      { profile_id: userId, role_id: roleData.id },
      { onConflict: "profile_id,role_id" }
    );

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "UPDATE_USER_ROLE", "profile", userId, adminId, {
    newRole: input.role,
  });

  return ok({ userId, role: input.role, updated: true }, ctx);
}

async function handleUpdateRoles(
  ctx: HandlerContext,
  userId: string,
  adminId: string
): Promise<Response> {
  // Prevent changing own role
  if (userId === adminId) {
    throw new ValidationError("Cannot change your own roles");
  }

  const input = updateRolesSchema.parse(ctx.body);

  // Get all role IDs from roles table
  const { data: allRoles, error: rolesError } = await ctx.supabase
    .from("roles")
    .select("id, name");

  if (rolesError) {
    throw new Error(rolesError.message);
  }

  const roleMap = new Map((allRoles ?? []).map((r) => [r.name, r.id]));

  // Delete existing user roles
  const { error: deleteError } = await ctx.supabase
    .from("user_roles")
    .delete()
    .eq("profile_id", userId);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  // Insert new roles
  const rolesToInsert = Object.entries(input.roles)
    .filter(([_, enabled]) => enabled)
    .map(([roleName]) => roleMap.get(roleName))
    .filter((roleId): roleId is number => roleId !== undefined)
    .map((roleId) => ({ profile_id: userId, role_id: roleId }));

  if (rolesToInsert.length > 0) {
    const { error: insertError } = await ctx.supabase
      .from("user_roles")
      .insert(rolesToInsert);

    if (insertError) {
      throw new Error(insertError.message);
    }
  }

  await logAdminAction(ctx, "UPDATE_USER_ROLES", "profile", userId, adminId, {
    roles: input.roles,
  });

  return ok({ userId, roles: input.roles, updated: true }, ctx);
}

async function handleBanUser(
  ctx: HandlerContext,
  userId: string,
  adminId: string
): Promise<Response> {
  // Prevent banning yourself
  if (userId === adminId) {
    throw new ValidationError("Cannot ban yourself");
  }

  const input = banUserSchema.parse(ctx.body);

  // Check if user exists
  const { data: targetUser } = await ctx.supabase
    .from("profiles")
    .select("id, first_name, second_name, email")
    .eq("id", userId)
    .single();

  if (!targetUser) {
    throw new NotFoundError("User not found");
  }

  // Ban the user
  const { error } = await ctx.supabase
    .from("profiles")
    .update({ is_active: false, ban_reason: input.reason })
    .eq("id", userId);

  if (error) {
    throw new Error(error.message);
  }

  // Deactivate all user's listings
  await ctx.supabase
    .from("posts")
    .update({ is_active: false })
    .eq("profile_id", userId);

  await logAdminAction(ctx, "BAN_USER", "profile", userId, adminId, {
    targetEmail: targetUser.email,
    reason: input.reason,
  });

  return ok({
    userId,
    banned: true,
    reason: input.reason,
  }, ctx);
}

async function handleUnbanUser(
  ctx: HandlerContext,
  userId: string,
  adminId: string
): Promise<Response> {
  // Check if user exists
  const { data: targetUser } = await ctx.supabase
    .from("profiles")
    .select("id, email, is_active")
    .eq("id", userId)
    .single();

  if (!targetUser) {
    throw new NotFoundError("User not found");
  }

  if (targetUser.is_active) {
    throw new ValidationError("User is not banned");
  }

  // Unban the user
  const { error } = await ctx.supabase
    .from("profiles")
    .update({ is_active: true, ban_reason: null })
    .eq("id", userId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "UNBAN_USER", "profile", userId, adminId, {
    targetEmail: targetUser.email,
  });

  return ok({ userId, unbanned: true }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "admin-users-api",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: { handler: handleRequest },
    PUT: { handler: handleRequest },
    POST: { handler: handleRequest },
  },
});
