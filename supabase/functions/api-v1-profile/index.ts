/**
 * Profile API v1
 *
 * REST API for user profile operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-profile                - Get current user's profile
 * - PUT    /api-v1-profile                - Update profile
 * - POST   /api-v1-profile?action=avatar  - Upload avatar
 * - DELETE /api-v1-profile?action=avatar  - Delete avatar
 * - DELETE /api-v1-profile?action=account - Delete account (Apple compliance)
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

import { z } from "../_shared/schemas/common.ts";
import { latitudeSchema, longitudeSchema } from "../_shared/schemas/geo.ts";
import { createAPIHandler, type HandlerContext, noContent, ok } from "../_shared/api-handler.ts";
import { NotFoundError, ServerError, ValidationError } from "../_shared/errors.ts";
import { getAdminClient } from "../_shared/supabase.ts";
import { createHealthHandler } from "../_shared/health-handler.ts";
import { logger } from "../_shared/logger.ts";
import { cache, CACHE_KEYS, invalidateProfileCache } from "../_shared/cache.ts";
import { PROFILE, sanitizeHtml } from "../_shared/validation-rules.ts";
import { aggregateCounts, aggregateImpact, aggregateStats } from "../_shared/aggregation.ts";
import { formatDisplayName, transformAddress } from "../_shared/transformers.ts";

const VERSION = "1.0.0";
const healthCheck = createHealthHandler("api-v1-profile", VERSION);

// =============================================================================
// Schemas (using shared validation constants from Swift FoodshareCore)
// =============================================================================

const updateProfileSchema = z.object({
  name: z.string().min(PROFILE.nickname.minLength).max(PROFILE.nickname.maxLength).optional(),
  bio: z.string().max(PROFILE.bio.maxLength).optional(),
  phone: z.string().max(20).optional(),
  location: z.string().max(200).optional(),
  isVolunteer: z.boolean().optional(),
  profileVisibility: z.enum(["public", "friends_only", "private"]).optional(),
});

const updateAddressSchema = z.object({
  addressLine1: z.string().min(1).max(500),
  addressLine2: z.string().max(500).optional(),
  addressLine3: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  stateProvince: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().min(1).max(100),
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
  radiusMeters: z.number().positive().optional(),
});

const uploadAvatarSchema = z.object({
  // Base64-encoded image data
  imageData: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  fileName: z.string().optional(),
});

const querySchema = z.object({
  action: z.enum(["avatar", "address", "dashboard", "account", "session"]).optional(),
  includeListings: z.string().transform((v) => v === "true").optional(),
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

  // Check cache first (2-min TTL)
  const cacheKey = CACHE_KEYS.profile(userId);
  const cached = cache.get<Record<string, unknown>>(cacheKey);
  if (cached) {
    return ok(transformProfile(cached), ctx);
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
      updated_at,
      profile_visibility
    `)
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new NotFoundError("Profile", userId);
  }

  cache.set(cacheKey, data, 2 * 60 * 1000); // 2-min TTL
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
  // Sanitize text fields to prevent XSS
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.name !== undefined) {
    // Sanitize and split name into first/last for the database
    const sanitizedName = sanitizeHtml(body.name.trim());
    const parts = sanitizedName.split(/\s+/);
    updates.first_name = parts[0] || "";
    updates.second_name = parts.slice(1).join(" ") || "";
    updates.display_name = sanitizedName;
  }
  if (body.bio !== undefined) updates.bio = sanitizeHtml(body.bio);
  if (body.phone !== undefined) updates.phone = sanitizeHtml(body.phone);
  if (body.location !== undefined) updates.location = sanitizeHtml(body.location);
  if (body.isVolunteer !== undefined) updates.is_volunteer = body.isVolunteer;
  if (body.profileVisibility !== undefined) updates.profile_visibility = body.profileVisibility;

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

  // Invalidate profile cache on mutation
  invalidateProfileCache(userId);
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

  // SECURITY: Check raw imageData length BEFORE any string operations to prevent memory exhaustion.
  // A data URL prefix is at most ~40 chars, so checking the full string is safe.
  // Base64 has ~4:3 ratio (3 bytes become 4 base64 chars)
  // For 5MB limit, max base64 length is approximately 5 * 1024 * 1024 * 4 / 3 = ~6.67MB
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const MAX_BASE64_LENGTH = Math.ceil(MAX_FILE_SIZE * 4 / 3) + 100; // +100 for data URL prefix + padding

  if (body.imageData.length > MAX_BASE64_LENGTH) {
    throw new ValidationError("File too large. Maximum size is 5MB");
  }

  // Extract base64 data (strip data URL prefix if present)
  const base64Data = body.imageData.includes(",") ? body.imageData.split(",")[1] : body.imageData;

  if (base64Data.length > MAX_BASE64_LENGTH) {
    throw new ValidationError("File too large. Maximum size is 5MB");
  }

  // Now safe to decode - we've verified the size won't exhaust memory
  const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

  // Double-check actual binary size (handles edge cases in base64 encoding)
  if (binaryData.length > MAX_FILE_SIZE) {
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

  // Upload via api-v1-images for compression
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const formData = new FormData();
  formData.append("file", new Blob([binaryData], { type: body.mimeType }));
  formData.append("bucket", "avatars");
  formData.append("path", fileName);
  formData.append("generateThumbnail", "false");
  formData.append("extractEXIF", "false");
  formData.append("enableAI", "false");

  const uploadResponse = await fetch(
    `${supabaseUrl}/functions/v1/api-v1-images/upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
      },
      body: formData,
    },
  );

  if (!uploadResponse.ok) {
    const error = await uploadResponse.text();
    throw new ServerError(`Avatar upload failed: ${error}`);
  }

  const uploadResult = await uploadResponse.json();
  const publicUrl = uploadResult.data.url;

  // Clean up old avatars with DIFFERENT extensions (if any)
  const otherExtensions = Object.values(extMap).filter((e) => e !== ext);
  const oldAvatarPaths = otherExtensions.map((e) => `${userId}/avatar.${e}`);

  // Remove old avatars in background (don't await)
  supabase.storage
    .from("avatars")
    .remove(oldAvatarPaths)
    .then(({ error }) => {
      if (error) {
        logger.warn("Failed to cleanup old avatars", { userId, error: error.message });
      }
    });

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

  // Known avatar file patterns - delete all possible extensions
  const avatarPaths = [
    `${userId}/avatar.jpg`,
    `${userId}/avatar.png`,
    `${userId}/avatar.webp`,
    `${userId}/avatar.gif`,
  ];

  // Delete from avatars bucket (direct delete without listing)
  // Storage.remove silently ignores non-existent files
  await supabase.storage.from("avatars").remove(avatarPaths);

  // Also clean up legacy profiles bucket (if any) in background
  supabase.storage
    .from("profiles")
    .remove(avatarPaths)
    .then(({ error }) => {
      if (error) {
        logger.warn("Failed to cleanup legacy profile avatars", { userId, error: error.message });
      }
    });

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
 * Delete account (Apple App Store compliance)
 * Deletes user from auth.users, cascades to profiles, and cleans up storage.
 */
async function deleteAccount(ctx: HandlerContext): Promise<Response> {
  const { userId } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  logger.info("Deleting user", { userId });

  const supabaseAdmin = getAdminClient();

  // Clean up avatars
  try {
    const { data: avatarFiles } = await supabaseAdmin.storage.from("avatars").list(userId);
    if (avatarFiles?.length) {
      await supabaseAdmin.storage.from("avatars").remove(
        avatarFiles.map((f) => `${userId}/${f.name}`),
      );
      logger.info("Deleted avatar files", { count: avatarFiles.length });
    }
  } catch (error) {
    logger.warn("Storage cleanup error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Clean up post images
  try {
    const { data: postImages } = await supabaseAdmin.storage.from("post-images").list(userId);
    if (postImages?.length) {
      await supabaseAdmin.storage.from("post-images").remove(
        postImages.map((f) => `${userId}/${f.name}`),
      );
      logger.info("Deleted post images", { count: postImages.length });
    }
  } catch (error) {
    logger.warn("Post images cleanup error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Delete user from auth (cascades to profiles)
  const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

  if (deleteError) {
    logger.error("Failed to delete user", new Error(deleteError.message));
    throw new ValidationError("Failed to delete account. Please try again.");
  }

  logger.info("User deleted successfully", { userId });

  return ok({
    success: true,
    message: "Account deleted successfully",
    deletedUserId: userId,
  }, ctx);
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
    name: formatDisplayName(data),
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
    profileVisibility: data.profile_visibility || "public",
  };
}

// transformAddress imported from _shared/transformers.ts

// =============================================================================
// Route Handlers
// =============================================================================

/**
 * Get session info (lightweight endpoint for locale caching)
 * Replaces /bff/session-info
 */
async function getSession(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId } = ctx;

  if (!userId) {
    return ok({ userId: null, locale: "en", localeSource: "default" }, ctx);
  }

  // Get minimal session data
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, preferred_locale")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return ok({ userId, locale: "en", localeSource: "default" }, ctx);
  }

  return ok({
    userId: data.id,
    displayName: data.display_name,
    avatarUrl: data.avatar_url,
    locale: data.preferred_locale || "en",
    localeSource: data.preferred_locale ? "database" : "default",
  }, ctx);
}

function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return healthCheck(ctx);
  }

  if (ctx.query.action === "session") {
    return getSession(ctx);
  }
  if (ctx.query.action === "dashboard") {
    return getDashboard(ctx);
  }
  if (ctx.query.action === "address") {
    return getAddress(ctx);
  }
  return getProfile(ctx);
}

/**
 * Get dashboard (aggregated profile + stats + counts)
 * Replaces /bff/dashboard
 */
async function getDashboard(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Parallel aggregation
  const [profile, stats, impact, counts] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).single(),
    aggregateStats(supabase, userId),
    aggregateImpact(supabase, userId),
    aggregateCounts(supabase, userId),
  ]);

  // Optional: recent listings
  let recentListings = [];
  if (query.includeListings) {
    const { data } = await supabase
      .from("posts")
      .select("id, title, images, status, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5);
    recentListings = data || [];
  }

  return ok({
    user: profile.data,
    stats,
    impact,
    counts,
    recentListings,
  }, ctx);
}

function handlePut(
  ctx: HandlerContext<UpdateProfileBody | UpdateAddressBody, QueryParams>,
): Promise<Response> {
  if (ctx.query.action === "address") {
    return updateAddress(ctx as HandlerContext<UpdateAddressBody, QueryParams>);
  }
  return updateProfile(ctx as HandlerContext<UpdateProfileBody, QueryParams>);
}

function handlePost(ctx: HandlerContext<UploadAvatarBody, QueryParams>): Promise<Response> {
  if (ctx.query.action === "avatar") {
    return uploadAvatar(ctx);
  }
  throw new ValidationError("Invalid action. Use ?action=avatar for uploads");
}

function handleDelete(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  if (ctx.query.action === "avatar") {
    return deleteAvatar(ctx);
  }
  if (ctx.query.action === "account") {
    return deleteAccount(ctx);
  }
  throw new ValidationError("Invalid action. Use ?action=avatar or ?action=account");
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-profile",
  version: "1.0.0",
  requireAuth: true,
  csrf: true,
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
}));
