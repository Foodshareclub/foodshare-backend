/**
 * Admin Listings Handler
 *
 * Handles all listing-related admin operations.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { logger } from "../../_shared/logger.ts";
import type { AdminContext } from "../index.ts";

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
    await ctx.supabase.from("admin_audit_log").insert({
      action,
      resource_type: "post",
      resource_id: resourceId,
      admin_id: ctx.adminId,
      metadata,
    });
  } catch (error) {
    logger.warn("Failed to log admin action", { action, error });
  }
}

// =============================================================================
// Route Handler
// =============================================================================

export async function handleListingsRoute(
  segments: string[],
  method: string,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  // Bulk operations: /listings/bulk/:operation
  if (segments[0] === "bulk") {
    const operation = segments[1];

    if (method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, ctx.corsHeaders, 405);
    }

    switch (operation) {
      case "activate":
        return handleBulkActivate(body, ctx);
      case "deactivate":
        return handleBulkDeactivate(body, ctx);
      case "delete":
        return handleBulkDelete(body, ctx);
      default:
        return jsonResponse({ error: "Unknown bulk operation" }, ctx.corsHeaders, 404);
    }
  }

  // Single listing operations: /listings/:id/:action?
  const listingId = parseInt(segments[0], 10);
  if (isNaN(listingId)) {
    return jsonResponse({ error: "Invalid listing ID" }, ctx.corsHeaders, 400);
  }

  const action = segments[1];

  switch (method) {
    case "PUT":
      if (action === "activate") return handleActivate(listingId, ctx);
      if (action === "deactivate") return handleDeactivate(listingId, body, ctx);
      if (action === "notes") return handleUpdateNotes(listingId, body, ctx);
      if (!action) return handleUpdate(listingId, body, ctx);
      break;
    case "DELETE":
      if (!action) return handleDelete(listingId, ctx);
      break;
  }

  return jsonResponse({ error: "Not found" }, ctx.corsHeaders, 404);
}

// =============================================================================
// Handlers
// =============================================================================

async function handleUpdate(
  listingId: number,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  const input = updateListingSchema.parse(body);

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

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "update_listing", String(listingId), {
    updatedFields: Object.keys(input),
  });

  return jsonResponse({ success: true, listingId, updated: true }, ctx.corsHeaders);
}

async function handleActivate(listingId: number, ctx: AdminContext): Promise<Response> {
  const { error } = await ctx.supabase
    .from("posts")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "activate_listing", String(listingId));

  return jsonResponse({ success: true, listingId, isActive: true }, ctx.corsHeaders);
}

async function handleDeactivate(
  listingId: number,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  const input = z.object({ reason: z.string().max(500).optional() }).parse(body || {});

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: false,
      admin_notes: input.reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "deactivate_listing", String(listingId), { reason: input.reason });

  return jsonResponse({ success: true, listingId, isActive: false }, ctx.corsHeaders);
}

async function handleDelete(listingId: number, ctx: AdminContext): Promise<Response> {
  const { error } = await ctx.supabase.from("posts").delete().eq("id", listingId);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "delete_listing", String(listingId));

  return new Response(null, { status: 204, headers: ctx.corsHeaders });
}

async function handleUpdateNotes(
  listingId: number,
  body: unknown,
  ctx: AdminContext
): Promise<Response> {
  const input = updateNotesSchema.parse(body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({ admin_notes: input.notes, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "update_admin_notes", String(listingId));

  return jsonResponse({ success: true, listingId, notesUpdated: true }, ctx.corsHeaders);
}

async function handleBulkActivate(body: unknown, ctx: AdminContext): Promise<Response> {
  const input = bulkIdsSchema.parse(body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .in("id", input.ids);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "bulk_activate_listings", input.ids.join(","), {
    count: input.ids.length,
  });

  return jsonResponse({ success: true, activated: input.ids.length, ids: input.ids }, ctx.corsHeaders);
}

async function handleBulkDeactivate(body: unknown, ctx: AdminContext): Promise<Response> {
  const input = bulkDeactivateSchema.parse(body);

  const { error } = await ctx.supabase
    .from("posts")
    .update({
      is_active: false,
      admin_notes: input.reason || null,
      updated_at: new Date().toISOString(),
    })
    .in("id", input.ids);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "bulk_deactivate_listings", input.ids.join(","), {
    count: input.ids.length,
    reason: input.reason,
  });

  return jsonResponse({ success: true, deactivated: input.ids.length, ids: input.ids }, ctx.corsHeaders);
}

async function handleBulkDelete(body: unknown, ctx: AdminContext): Promise<Response> {
  const input = bulkIdsSchema.parse(body);

  const { error } = await ctx.supabase.from("posts").delete().in("id", input.ids);

  if (error) throw new Error(error.message);

  await logAdminAction(ctx, "bulk_delete_listings", input.ids.join(","), {
    count: input.ids.length,
  });

  return jsonResponse({ success: true, deleted: input.ids.length, ids: input.ids }, ctx.corsHeaders);
}
