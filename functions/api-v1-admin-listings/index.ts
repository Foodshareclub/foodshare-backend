/**
 * Admin Listings API
 *
 * Edge Function for admin listing management operations.
 * Provides CRUD operations for posts/listings with admin auth.
 *
 * Routes:
 * - PUT /:id - Update listing
 * - PUT /:id/activate - Activate listing
 * - PUT /:id/deactivate - Deactivate listing
 * - DELETE /:id - Delete listing
 * - PUT /:id/notes - Update admin notes
 * - POST /bulk/activate - Bulk activate
 * - POST /bulk/deactivate - Bulk deactivate
 * - POST /bulk/delete - Bulk delete
 */

import { createAPIHandler, ok, noContent, type HandlerContext } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { ForbiddenError, NotFoundError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Schemas
// =============================================================================

const updateListingSchema = z.object({
  postName: z.string().min(1).max(200).optional(),
  postDescription: z.string().max(2000).optional(),
  postType: z.enum(["food", "produce", "prepared", "other"]).optional(),
  pickupTime: z.string().optional(),
  availableHours: z.string().optional(),
  postAddress: z.string().optional(),
  isActive: z.boolean().optional(),
  adminNotes: z.string().max(1000).optional(),
});

const deactivateSchema = z.object({
  reason: z.string().max(500).optional(),
});

const bulkIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

const bulkDeactivateSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  reason: z.string().max(500).optional(),
});

const updateNotesSchema = z.object({
  notes: z.string().max(1000),
});

type UpdateListingInput = z.infer<typeof updateListingSchema>;
type BulkIdsInput = z.infer<typeof bulkIdsSchema>;
type BulkDeactivateInput = z.infer<typeof bulkDeactivateSchema>;

// =============================================================================
// Admin Auth Helper
// =============================================================================

async function requireAdmin(ctx: HandlerContext): Promise<string> {
  if (!ctx.userId) {
    throw new ForbiddenError("Authentication required");
  }

  // Check user has admin role
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
    await ctx.supabase.from("admin_audit_log").insert({
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      admin_id: adminId,
      metadata,
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

  // Route based on path
  // Expected paths:
  // /api-v1-admin-listings/:id
  // /api-v1-admin-listings/:id/activate
  // /api-v1-admin-listings/:id/deactivate
  // /api-v1-admin-listings/:id/notes
  // /api-v1-admin-listings/bulk/activate
  // /api-v1-admin-listings/bulk/deactivate
  // /api-v1-admin-listings/bulk/delete

  const functionIndex = pathParts.findIndex((p) => p === "api-v1-admin-listings");
  const subPath = pathParts.slice(functionIndex + 1);

  // Bulk operations
  if (subPath[0] === "bulk") {
    const operation = subPath[1];

    if (ctx.request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
      });
    }

    switch (operation) {
      case "activate":
        return handleBulkActivate(ctx, adminId);
      case "deactivate":
        return handleBulkDeactivate(ctx, adminId);
      case "delete":
        return handleBulkDelete(ctx, adminId);
      default:
        return new Response(JSON.stringify({ error: "Unknown bulk operation" }), {
          status: 404,
          headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
        });
    }
  }

  // Single listing operations
  const listingId = parseInt(subPath[0], 10);
  if (isNaN(listingId)) {
    return new Response(JSON.stringify({ error: "Invalid listing ID" }), {
      status: 400,
      headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
    });
  }

  const action = subPath[1];

  switch (ctx.request.method) {
    case "PUT":
      if (action === "activate") {
        return handleActivate(ctx, listingId, adminId);
      } else if (action === "deactivate") {
        return handleDeactivate(ctx, listingId, adminId);
      } else if (action === "notes") {
        return handleUpdateNotes(ctx, listingId, adminId);
      } else if (!action) {
        return handleUpdate(ctx, listingId, adminId);
      }
      break;
    case "DELETE":
      if (!action) {
        return handleDelete(ctx, listingId, adminId);
      }
      break;
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleUpdate(
  ctx: HandlerContext,
  listingId: number,
  adminId: string
): Promise<Response> {
  const input = updateListingSchema.parse(ctx.body);

  // Transform camelCase to snake_case
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.postName !== undefined) updateData.post_name = input.postName;
  if (input.postDescription !== undefined) updateData.post_description = input.postDescription;
  if (input.postType !== undefined) updateData.post_type = input.postType;
  if (input.pickupTime !== undefined) updateData.pickup_time = input.pickupTime;
  if (input.availableHours !== undefined) updateData.available_hours = input.availableHours;
  if (input.postAddress !== undefined) updateData.post_address = input.postAddress;
  if (input.isActive !== undefined) updateData.is_active = input.isActive;
  if (input.adminNotes !== undefined) updateData.admin_notes = input.adminNotes;

  const { error } = await ctx.supabase
    .from("posts")
    .update(updateData)
    .eq("id", listingId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "update_listing", "post", String(listingId), adminId, {
    updatedFields: Object.keys(input),
  });

  return ok({ listingId, updated: true }, ctx);
}

async function handleActivate(
  ctx: HandlerContext,
  listingId: number,
  adminId: string
): Promise<Response> {
  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "activate_listing", "post", String(listingId), adminId);

  return ok({ listingId, isActive: true }, ctx);
}

async function handleDeactivate(
  ctx: HandlerContext,
  listingId: number,
  adminId: string
): Promise<Response> {
  const input = deactivateSchema.parse(ctx.body || {});

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: false,
      admin_notes: input.reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "deactivate_listing", "post", String(listingId), adminId, {
    reason: input.reason,
  });

  return ok({ listingId, isActive: false }, ctx);
}

async function handleDelete(
  ctx: HandlerContext,
  listingId: number,
  adminId: string
): Promise<Response> {
  const { error } = await ctx.supabase.from("posts").delete().eq("id", listingId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "delete_listing", "post", String(listingId), adminId);

  return noContent(ctx);
}

async function handleUpdateNotes(
  ctx: HandlerContext,
  listingId: number,
  adminId: string
): Promise<Response> {
  const input = updateNotesSchema.parse(ctx.body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      admin_notes: input.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "update_admin_notes", "post", String(listingId), adminId);

  return ok({ listingId, notesUpdated: true }, ctx);
}

async function handleBulkActivate(
  ctx: HandlerContext,
  adminId: string
): Promise<Response> {
  const input = bulkIdsSchema.parse(ctx.body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .in("id", input.ids);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "bulk_activate_listings", "post", input.ids.join(","), adminId, {
    count: input.ids.length,
  });

  return ok({ activated: input.ids.length, ids: input.ids }, ctx);
}

async function handleBulkDeactivate(
  ctx: HandlerContext,
  adminId: string
): Promise<Response> {
  const input = bulkDeactivateSchema.parse(ctx.body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: false,
      admin_notes: input.reason || null,
      updated_at: new Date().toISOString(),
    })
    .in("id", input.ids);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "bulk_deactivate_listings", "post", input.ids.join(","), adminId, {
    count: input.ids.length,
    reason: input.reason,
  });

  return ok({ deactivated: input.ids.length, ids: input.ids }, ctx);
}

async function handleBulkDelete(
  ctx: HandlerContext,
  adminId: string
): Promise<Response> {
  const input = bulkIdsSchema.parse(ctx.body);

  const { error } = await ctx.supabase.from("posts").delete().in("id", input.ids);

  if (error) {
    throw new Error(error.message);
  }

  await logAdminAction(ctx, "bulk_delete_listings", "post", input.ids.join(","), adminId, {
    count: input.ids.length,
  });

  return ok({ deleted: input.ids.length, ids: input.ids }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "admin-listings-api",
  requireAuth: true,
  rateLimit: {
    limit: 120,
    windowMs: 60000, // 120 requests per minute for admins
    keyBy: "user",
  },
  routes: {
    PUT: { handler: handleRequest },
    POST: { handler: handleRequest },
    DELETE: { handler: handleRequest },
  },
});
