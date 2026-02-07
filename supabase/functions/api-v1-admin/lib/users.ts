/**
 * Admin Users Handler
 *
 * Handles all user-related admin operations.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { logger } from "../../_shared/logger.ts";
import type { AdminContext } from "../index.ts";

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
// Errors
// =============================================================================

class ValidationError extends Error {
  name = "ValidationError";
}

class NotFoundError extends Error {
  name = "NotFoundError";
}

// =============================================================================
// Response Helper
// =============================================================================

function jsonResponse(data: unknown, corsHeaders: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// Audit Logging
// =============================================================================

async function logAdminAction(
  ctx: AdminContext,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await ctx.supabase.rpc("log_audit_event", {
      p_user_id: ctx.adminId,
      p_action: action,
      p_resource_type: "profile",
      p_resource_id: resourceId,
      p_metadata: metadata,
    });
  } catch (error) {
    logger.warn("Failed to log admin action", { action, error });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function isValidUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// =============================================================================
// Route Handler
// =============================================================================

export async function handleUsersRoute(
  segments: string[],
  method: string,
  body: unknown,
  query: Record<string, string>,
  ctx: AdminContext
): Promise<Response> {
  // GET / - List users
  if (method === "GET" && segments.length === 0) {
    return handleListUsers(query, ctx);
  }

  // Operations on specific user: /users/:id/:action
  const userId = segments[0];
  if (!userId || !isValidUUID(userId)) {
    return jsonResponse({ error: "Invalid user ID" }, ctx.corsHeaders, 400);
  }

  const action = segments[1];

  switch (method) {
    case "PUT":
      if (action === "role") return handleUpdateRole(userId, body, ctx);
      if (action === "roles") return handleUpdateRoles(userId, body, ctx);
      break;
    case "POST":
      if (action === "ban") return handleBanUser(userId, body, ctx);
      if (action === "unban") return handleUnbanUser(userId, ctx);
      break;
  }

  return jsonResponse({ error: "Not found" }, ctx.corsHeaders, 404);
}

// =============================================================================
// Handlers
// =============================================================================

async function handleListUsers(
  query: Record<string, string>,
  ctx: AdminContext
): Promise<Response> {
  const queryParams = listUsersQuerySchema.parse(query);

  const page = parseInt(queryParams.page || "1", 10);
  const limit = Math.min(parseInt(queryParams.limit || "20", 10), 100);
  const offset = (page - 1) * limit;

  let dbQuery = ctx.supabase
    .from("profiles")
    .select("id, first_name, second_name, email, created_time, is_active", { count: "exact" });

  if (queryParams.search) {
    const safeSearch = queryParams.search.replace(/[%_]/g, "\\$&");
    dbQuery = dbQuery.or(
      `first_name.ilike.%${safeSearch}%,second_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`
    );
  }

  if (queryParams.isActive !== undefined) {
    dbQuery = dbQuery.eq("is_active", queryParams.isActive === "true");
  }

  dbQuery = dbQuery.order("created_time", { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await dbQuery;

  if (error) throw new Error(error.message);

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

  const total = count ?? 0;
  const hasMore = offset + limit < total;

  return jsonResponse({
    success: true,
    data: filteredUsers,
    pagination: {
      page,
      limit,
      total,
      hasMore,
    },
  }, ctx.corsHeaders);
}

async function handleUpdateRole(
  userId: string,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  if (userId === ctx.adminId) {
    throw new ValidationError("Cannot change your own role");
  }

  const input = updateRoleSchema.parse(body);

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

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "UPDATE_USER_ROLE", userId, { newRole: input.role });

  return jsonResponse({ success: true, userId, role: input.role, updated: true }, ctx.corsHeaders);
}

async function handleUpdateRoles(
  userId: string,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  if (userId === ctx.adminId) {
    throw new ValidationError("Cannot change your own roles");
  }

  const input = updateRolesSchema.parse(body);

  // Get all role IDs from roles table
  const { data: allRoles, error: rolesError } = await ctx.supabase
    .from("roles")
    .select("id, name");

  if (rolesError) throw new Error(rolesError.message);

  const roleMap = new Map((allRoles ?? []).map((r) => [r.name, r.id]));

  // Delete existing user roles
  const { error: deleteError } = await ctx.supabase
    .from("user_roles")
    .delete()
    .eq("profile_id", userId);

  if (deleteError) throw new Error(deleteError.message);

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

    if (insertError) throw new Error(insertError.message);
  }

  await logAdminAction(ctx, "UPDATE_USER_ROLES", userId, { roles: input.roles });

  return jsonResponse({ success: true, userId, roles: input.roles, updated: true }, ctx.corsHeaders);
}

async function handleBanUser(
  userId: string,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  if (userId === ctx.adminId) {
    throw new ValidationError("Cannot ban yourself");
  }

  const input = banUserSchema.parse(body);

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

  if (error) throw new Error(error.message);

  // Deactivate all user's listings
  await ctx.supabase
    .from("posts")
    .update({ is_active: false })
    .eq("profile_id", userId);

  await logAdminAction(ctx, "BAN_USER", userId, {
    targetEmail: targetUser.email,
    reason: input.reason,
  });

  return jsonResponse({
    success: true,
    userId,
    banned: true,
    reason: input.reason,
  }, ctx.corsHeaders);
}

async function handleUnbanUser(
  userId: string,
  ctx: AdminContext
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

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "UNBAN_USER", userId, { targetEmail: targetUser.email });

  return jsonResponse({ success: true, userId, unbanned: true }, ctx.corsHeaders);
}
