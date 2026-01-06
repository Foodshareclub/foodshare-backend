/**
 * Profile API v1
 *
 * REST API for user profile operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-profile              - Get current user's profile
 * - PUT    /api-v1-profile              - Update profile
 * - POST   /api-v1-profile?action=avatar - Upload avatar
 * - DELETE /api-v1-profile?action=avatar - Delete avatar
 * - PUT    /api-v1-profile?action=address - Update address
 * - GET    /api-v1-profile?action=address - Get address
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 * - X-Idempotency-Key: <uuid> (optional, for POST/PUT)
 * - X-Client-Platform: ios | android | web
 *
 * @module api-v1-profile
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  noContent,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { PROFILE } from "../_shared/validation-rules.ts";

// =============================================================================
// Schemas (using shared validation constants from Swift FoodshareCore)
// =============================================================================

const updateProfileSchema = z.object({
  name: z.string().min(PROFILE.nickname.minLength).max(PROFILE.nickname.maxLength).optional(),
  bio: z.string().max(PROFILE.bio.maxLength).optional(),
  phone: z.string().max(20).optional(),
  location: z.string().max(200).optional(),
  isVolunteer: z.boolean().optional(),
});

const updateAddressSchema = z.object({
  addressLine1: z.string().min(1).max(500),
  addressLine2: z.string().max(500).optional(),
  addressLine3: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  stateProvince: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMeters: z.number().positive().optional(),
});

const uploadAvatarSchema = z.object({
  // Base64-encoded image data
  imageData: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  fileName: z.string().optional(),
});

const querySchema = z.object({
  action: z.enum(["avatar", "address"]).optional(),
});

type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
type UpdateAddressBody = z.infer<typeof updateAddressSchema>;
type UploadAvatarBody = z.infer<typeof uploadAvatarSchema>;
type QueryParams = z.infer<typeof querySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * Get current user's profile
 */
async function getProfile(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(`
      id,
      first_name,
      second_name,
      display_name,
      bio,
      phone,
      location,
      avatar_url,
      is_volunteer,
      rating_count,
      rating_average,
      created_at,
      updated_at
    `)
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new NotFoundError("Profile", userId);
  }

  return ok(transformProfile(data), ctx);
}

/**
 * Get user's address
 */
async function getAddress(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const { data, error } = await supabase
    .from("address")
    .select(`
      profile_id,
      address_line_1,
      address_line_2,
      address_line_3,
      city,
      state_province,
      postal_code,
      country,
      lat,
      long,
      generated_full_address,
      radius_meters
    `)
    .eq("profile_id", userId)
    .single();

  if (error) {
    // No address found is not an error - return null
    if (error.code === "PGRST116") {
      return ok(null, ctx);
    }
    throw error;
  }

  return ok(transformAddress(data), ctx);
}

/**
 * Update profile
 */
async function updateProfile(ctx: HandlerContext<UpdateProfileBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Build update object (snake_case for database)
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.name !== undefined) {
    // Split name into first/last for the database
    const parts = body.name.trim().split(/\s+/);
    updates.first_name = parts[0] || "";
    updates.second_name = parts.slice(1).join(" ") || "";
    updates.display_name = body.name.trim();
  }
  if (body.bio !== undefined) updates.bio = body.bio;
  if (body.phone !== undefined) updates.phone = body.phone;
  if (body.location !== undefined) updates.location = body.location;
  if (body.isVolunteer !== undefined) updates.is_volunteer = body.isVolunteer;

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    logger.error("Failed to update profile", new Error(error.message));
    throw error;
  }

  logger.info("Profile updated", { userId });

  return ok(transformProfile(data), ctx);
}

/**
 * Upload avatar
 */
async function uploadAvatar(ctx: HandlerContext<UploadAvatarBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Decode base64 image
  const base64Data = body.imageData.includes(",")
    ? body.imageData.split(",")[1]
    : body.imageData;

  const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

  // Validate size (5MB max)
  if (binaryData.length > 5 * 1024 * 1024) {
    throw new ValidationError("File too large. Maximum size is 5MB");
  }

  // Determine file extension
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = extMap[body.mimeType] || "jpg";
  const fileName = `${userId}/avatar.${ext}`;

  // Delete existing avatars first
  const { data: existingFiles } = await supabase.storage
    .from("avatars")
    .list(userId);

  if (existingFiles && existingFiles.length > 0) {
    const filePaths = existingFiles.map((f) => `${userId}/${f.name}`);
    await supabase.storage.from("avatars").remove(filePaths);
  }

  // Upload new avatar
  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(fileName, binaryData, {
      contentType: body.mimeType,
      upsert: true,
    });

  if (uploadError) {
    logger.error("Failed to upload avatar", new Error(uploadError.message));
    throw uploadError;
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("avatars")
    .getPublicUrl(fileName);

  const publicUrl = urlData.publicUrl;

  // Update profile with avatar URL
  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      avatar_url: publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (updateError) {
    logger.error("Failed to update profile with avatar", new Error(updateError.message));
    throw updateError;
  }

  logger.info("Avatar uploaded", { userId, fileName });

  return ok({ url: publicUrl }, ctx);
}

/**
 * Delete avatar
 */
async function deleteAvatar(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Delete from avatars bucket
  const { data: avatarFiles } = await supabase.storage
    .from("avatars")
    .list(userId);

  if (avatarFiles && avatarFiles.length > 0) {
    const filePaths = avatarFiles.map((f) => `${userId}/${f.name}`);
    await supabase.storage.from("avatars").remove(filePaths);
  }

  // Also check profiles bucket (legacy)
  const { data: profileFiles } = await supabase.storage
    .from("profiles")
    .list(userId);

  if (profileFiles && profileFiles.length > 0) {
    const filePaths = profileFiles.map((f) => `${userId}/${f.name}`);
    await supabase.storage.from("profiles").remove(filePaths);
  }

  // Update profile to remove avatar URL
  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      avatar_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (updateError) {
    logger.error("Failed to update profile", new Error(updateError.message));
    throw updateError;
  }

  logger.info("Avatar deleted", { userId });

  return noContent(ctx);
}

/**
 * Update address (upsert pattern)
 */
async function updateAddress(ctx: HandlerContext<UpdateAddressBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Build full address string
  const addressParts = [
    body.addressLine1,
    body.addressLine2,
    body.addressLine3,
    body.city,
    body.stateProvince,
    body.postalCode,
    body.country,
  ].filter(Boolean);
  const generatedFullAddress = addressParts.join(", ");

  // Check if address exists
  const { data: existing } = await supabase
    .from("address")
    .select("profile_id")
    .eq("profile_id", userId)
    .single();

  const addressData = {
    profile_id: userId,
    address_line_1: body.addressLine1,
    address_line_2: body.addressLine2 || "",
    address_line_3: body.addressLine3 || "",
    city: body.city,
    state_province: body.stateProvince || "",
    postal_code: body.postalCode || "",
    country: body.country,
    lat: body.lat ?? null,
    long: body.lng ?? null,
    generated_full_address: generatedFullAddress,
    radius_meters: body.radiusMeters ?? null,
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing) {
    // Update existing
    const { data, error } = await supabase
      .from("address")
      .update(addressData)
      .eq("profile_id", userId)
      .select()
      .single();

    if (error) {
      logger.error("Failed to update address", new Error(error.message));
      throw error;
    }
    result = data;
  } else {
    // Insert new
    const { data, error } = await supabase
      .from("address")
      .insert(addressData)
      .select()
      .single();

    if (error) {
      logger.error("Failed to create address", new Error(error.message));
      throw error;
    }
    result = data;
  }

  logger.info("Address updated", { userId });

  return ok(transformAddress(result), ctx);
}

// =============================================================================
// Transformers
// =============================================================================

function transformProfile(data: Record<string, unknown>) {
  return {
    id: data.id,
    name: data.display_name || `${data.first_name || ""} ${data.second_name || ""}`.trim(),
    firstName: data.first_name,
    lastName: data.second_name,
    bio: data.bio,
    phone: data.phone,
    location: data.location,
    avatarUrl: data.avatar_url,
    isVolunteer: data.is_volunteer,
    ratingCount: data.rating_count,
    ratingAverage: data.rating_average,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

function transformAddress(data: Record<string, unknown>) {
  return {
    profileId: data.profile_id,
    addressLine1: data.address_line_1,
    addressLine2: data.address_line_2,
    addressLine3: data.address_line_3,
    city: data.city,
    stateProvince: data.state_province,
    postalCode: data.postal_code,
    country: data.country,
    lat: data.lat,
    lng: data.long,
    fullAddress: data.generated_full_address,
    radiusMeters: data.radius_meters,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  if (ctx.query.action === "address") {
    return getAddress(ctx);
  }
  return getProfile(ctx);
}

async function handlePut(ctx: HandlerContext<UpdateProfileBody | UpdateAddressBody, QueryParams>): Promise<Response> {
  if (ctx.query.action === "address") {
    return updateAddress(ctx as HandlerContext<UpdateAddressBody, QueryParams>);
  }
  return updateProfile(ctx as HandlerContext<UpdateProfileBody, QueryParams>);
}

async function handlePost(ctx: HandlerContext<UploadAvatarBody, QueryParams>): Promise<Response> {
  if (ctx.query.action === "avatar") {
    return uploadAvatar(ctx);
  }
  throw new ValidationError("Invalid action. Use ?action=avatar for uploads");
}

async function handleDelete(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  if (ctx.query.action === "avatar") {
    return deleteAvatar(ctx);
  }
  throw new ValidationError("Invalid action. Use ?action=avatar for deletion");
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-profile",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema,
      handler: handleGet,
    },
    PUT: {
      querySchema,
      handler: handlePut,
      idempotent: true,
    },
    POST: {
      schema: uploadAvatarSchema,
      querySchema,
      handler: handlePost,
      idempotent: true,
    },
    DELETE: {
      querySchema,
      handler: handleDelete,
    },
  },
});
