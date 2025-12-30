/**
 * Products API v1
 *
 * Unified REST API for product/listing operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-products              - List products with filters
 * - GET    /api-v1-products?id=<id>      - Get single product
 * - POST   /api-v1-products              - Create product
 * - PUT    /api-v1-products?id=<id>      - Update product
 * - DELETE /api-v1-products?id=<id>      - Delete product
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 * - X-Idempotency-Key: <uuid> (optional, for POST/PUT)
 * - X-Client-Platform: ios | android | web
 *
 * @module api-v1-products
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  created,
  noContent,
  paginated,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { NotFoundError, ValidationError, ConflictError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Schemas
// =============================================================================

const createProductSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(2000).optional(),
  images: z.array(z.string().url()).min(1).max(5),
  postType: z.enum(["food", "non-food", "request"]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pickupAddress: z.string().max(500).optional(),
  pickupTime: z.string().max(200).optional(),
  categoryId: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateProductSchema = z.object({
  title: z.string().min(3).max(100).optional(),
  description: z.string().max(2000).optional(),
  images: z.array(z.string().url()).min(1).max(5).optional(),
  pickupAddress: z.string().max(500).optional(),
  pickupTime: z.string().max(200).optional(),
  categoryId: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(), // Required for optimistic locking
});

const listQuerySchema = z.object({
  postType: z.enum(["food", "non-food", "request"]).optional(),
  categoryId: z.string().optional(),
  lat: z.string().optional(),
  lng: z.string().optional(),
  radius: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
  userId: z.string().uuid().optional(),
});

type CreateProductBody = z.infer<typeof createProductSchema>;
type UpdateProductBody = z.infer<typeof updateProductSchema>;
type ListQuery = z.infer<typeof listQuerySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * List products with filters and cursor pagination
 */
async function listProducts(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const postType = query.postType;
  const categoryId = query.categoryId ? parseInt(query.categoryId) : undefined;
  const lat = query.lat ? parseFloat(query.lat) : undefined;
  const lng = query.lng ? parseFloat(query.lng) : undefined;
  const radius = query.radius ? parseFloat(query.radius) : 10; // km
  const cursor = query.cursor;
  const userId = query.userId;

  // Build query
  let dbQuery = supabase
    .from("posts_with_location")
    .select("*", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(limit + 1); // Fetch one extra for hasMore

  if (postType) {
    dbQuery = dbQuery.eq("post_type", postType);
  }

  if (categoryId) {
    dbQuery = dbQuery.eq("category_id", categoryId);
  }

  if (userId) {
    dbQuery = dbQuery.eq("profile_id", userId);
  }

  if (cursor) {
    dbQuery = dbQuery.lt("created_at", cursor);
  }

  // Location-based filtering (if coordinates provided)
  if (lat !== undefined && lng !== undefined) {
    // Use PostGIS ST_DWithin for efficient radius query
    dbQuery = dbQuery.rpc("nearby_posts", {
      p_lat: lat,
      p_lng: lng,
      p_radius_km: radius,
      p_post_type: postType || null,
      p_limit: limit + 1,
      p_cursor: cursor || null,
    });
  }

  const { data, error, count } = await dbQuery;

  if (error) {
    logger.error("Failed to list products", new Error(error.message));
    throw error;
  }

  const items = data || [];
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, -1) : items;

  return paginated(
    resultItems.map(transformProduct),
    ctx,
    {
      offset: 0,
      limit,
      total: count || resultItems.length,
    }
  );
}

/**
 * Get single product by ID
 */
async function getProduct(ctx: HandlerContext): Promise<Response> {
  const { supabase, query } = ctx;
  const productId = (query as Record<string, string>).id;

  if (!productId) {
    throw new ValidationError("Product ID is required");
  }

  const { data, error } = await supabase
    .from("posts_with_location")
    .select(`
      *,
      profile:profiles!posts_profile_id_fkey(
        id,
        display_name,
        avatar_url,
        created_at
      ),
      category:categories(id, name, icon)
    `)
    .eq("id", productId)
    .single();

  if (error || !data) {
    throw new NotFoundError("Product", productId);
  }

  return ok(transformProductDetail(data), ctx);
}

/**
 * Create new product
 */
async function createProduct(ctx: HandlerContext<CreateProductBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Validate content using server-side RPC
  const { data: validation, error: validationError } = await supabase.rpc(
    "validate_listing_content",
    {
      p_title: body.title,
      p_description: body.description || "",
    }
  );

  if (validationError) {
    logger.warn("Content validation failed", { error: validationError.message });
  }

  if (validation && !validation.is_valid) {
    throw new ValidationError("Content validation failed", validation.issues);
  }

  // Create product
  const { data, error } = await supabase
    .from("posts")
    .insert({
      profile_id: userId,
      post_name: body.title,
      post_description: body.description,
      images: body.images,
      post_type: body.postType,
      latitude: body.latitude,
      longitude: body.longitude,
      pickup_address: body.pickupAddress,
      pickup_time: body.pickupTime,
      category_id: body.categoryId,
      expires_at: body.expiresAt,
      is_active: true,
      version: 1,
    })
    .select()
    .single();

  if (error) {
    logger.error("Failed to create product", new Error(error.message));
    throw error;
  }

  logger.info("Product created", { productId: data.id, userId });

  return created(transformProduct(data), ctx);
}

/**
 * Update product with optimistic locking
 */
async function updateProduct(ctx: HandlerContext<UpdateProductBody>): Promise<Response> {
  const { supabase, userId, body, query } = ctx;
  const productId = (query as Record<string, string>).id;

  if (!productId) {
    throw new ValidationError("Product ID is required");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Check ownership and current version
  const { data: existing, error: fetchError } = await supabase
    .from("posts")
    .select("id, profile_id, version")
    .eq("id", productId)
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError("Product", productId);
  }

  if (existing.profile_id !== userId) {
    throw new ValidationError("You can only update your own products");
  }

  // Optimistic locking check
  if (existing.version !== body.version) {
    throw new ConflictError(
      "Product was modified by another request. Please refresh and try again.",
      { currentVersion: existing.version, expectedVersion: body.version }
    );
  }

  // Build update object
  const updates: Record<string, unknown> = {
    version: existing.version + 1,
    updated_at: new Date().toISOString(),
  };

  if (body.title !== undefined) updates.post_name = body.title;
  if (body.description !== undefined) updates.post_description = body.description;
  if (body.images !== undefined) updates.images = body.images;
  if (body.pickupAddress !== undefined) updates.pickup_address = body.pickupAddress;
  if (body.pickupTime !== undefined) updates.pickup_time = body.pickupTime;
  if (body.categoryId !== undefined) updates.category_id = body.categoryId;
  if (body.expiresAt !== undefined) updates.expires_at = body.expiresAt;
  if (body.isActive !== undefined) updates.is_active = body.isActive;

  // Update with version check in WHERE clause
  const { data, error } = await supabase
    .from("posts")
    .update(updates)
    .eq("id", productId)
    .eq("version", body.version) // Double-check version
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows returned - version mismatch
      throw new ConflictError("Product was modified during update");
    }
    logger.error("Failed to update product", new Error(error.message));
    throw error;
  }

  logger.info("Product updated", { productId, userId, newVersion: data.version });

  return ok(transformProduct(data), ctx);
}

/**
 * Delete product (soft delete)
 */
async function deleteProduct(ctx: HandlerContext): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const productId = (query as Record<string, string>).id;

  if (!productId) {
    throw new ValidationError("Product ID is required");
  }

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Check ownership
  const { data: existing, error: fetchError } = await supabase
    .from("posts")
    .select("id, profile_id")
    .eq("id", productId)
    .single();

  if (fetchError || !existing) {
    throw new NotFoundError("Product", productId);
  }

  if (existing.profile_id !== userId) {
    throw new ValidationError("You can only delete your own products");
  }

  // Soft delete
  const { error } = await supabase
    .from("posts")
    .update({
      is_active: false,
      deleted_at: new Date().toISOString(),
    })
    .eq("id", productId);

  if (error) {
    logger.error("Failed to delete product", new Error(error.message));
    throw error;
  }

  logger.info("Product deleted", { productId, userId });

  return noContent(ctx);
}

// =============================================================================
// Transformers
// =============================================================================

function transformProduct(data: Record<string, unknown>) {
  return {
    id: data.id,
    title: data.post_name,
    description: data.post_description,
    images: data.images,
    postType: data.post_type,
    location: {
      lat: data.latitude,
      lng: data.longitude,
      address: data.pickup_address,
    },
    pickupTime: data.pickup_time,
    categoryId: data.category_id,
    isActive: data.is_active,
    expiresAt: data.expires_at,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    version: data.version,
    userId: data.profile_id,
  };
}

function transformProductDetail(data: Record<string, unknown>) {
  const base = transformProduct(data);
  const profile = data.profile as Record<string, unknown> | null;
  const category = data.category as Record<string, unknown> | null;

  return {
    ...base,
    user: profile
      ? {
          id: profile.id,
          displayName: profile.display_name,
          avatarUrl: profile.avatar_url,
          memberSince: profile.created_at,
        }
      : null,
    category: category
      ? {
          id: category.id,
          name: category.name,
          icon: category.icon,
        }
      : null,
  };
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * Route to appropriate handler based on query params
 */
async function handleGet(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const productId = (ctx.query as Record<string, string>).id;

  if (productId) {
    return getProduct(ctx);
  }

  return listProducts(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-products",
  version: "2.0.0",
  requireAuth: false, // Allow public listing, auth checked per-route
  rateLimit: {
    limit: 100,
    windowMs: 60000, // 100 requests per minute
    keyBy: "ip",
    skip: (ctx) => ctx.request.method === "GET", // Don't rate limit reads
  },
  routes: {
    GET: {
      querySchema: listQuerySchema,
      handler: handleGet,
      requireAuth: false, // Public read
    },
    POST: {
      schema: createProductSchema,
      handler: createProduct,
      requireAuth: true,
      idempotent: true,
    },
    PUT: {
      schema: updateProductSchema,
      handler: updateProduct,
      requireAuth: true,
      idempotent: true,
    },
    DELETE: {
      handler: deleteProduct,
      requireAuth: true,
    },
  },
});
