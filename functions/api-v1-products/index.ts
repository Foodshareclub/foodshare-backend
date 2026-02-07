/**
 * Products API v1
 *
 * Unified REST API for product/listing operations.
 * Consolidates api-v1-listings into this single endpoint.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-products              - List products with filters
 * - GET    /api-v1-products?id=<id>      - Get single product
 * - GET    /api-v1-products?mode=feed    - Aggregated feed with counts
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
import { cache } from "../_shared/cache.ts";
import { sanitizeHtml, LISTING, parseIntSafe, parseFloatSafe, parseFloatSafeWithBounds } from "../_shared/validation-rules.ts";
import { validateProductImageUrls } from "../_shared/storage-urls.ts";
import {
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  type CompositeCursor,
} from "../_shared/pagination.ts";
import { aggregateCounts } from "../_shared/aggregation.ts";

const VERSION = "2.0.0";

// =============================================================================
// Schemas
// =============================================================================

const createProductSchema = z.object({
  title: z.string().min(LISTING.title.minLength).max(LISTING.title.maxLength),
  description: z.string().max(LISTING.description.maxLength).optional(),
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
  title: z.string().min(LISTING.title.minLength).max(LISTING.title.maxLength).optional(),
  description: z.string().max(LISTING.description.maxLength).optional(),
  images: z.array(z.string().url()).min(1).max(5).optional(),
  pickupAddress: z.string().max(500).optional(),
  pickupTime: z.string().max(200).optional(),
  categoryId: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  isActive: z.boolean().optional(),
  version: z.number().int().positive(), // Required for optimistic locking
});

const listQuerySchema = z.object({
  mode: z.enum(["feed"]).optional(),
  id: z.string().optional(),
  include: z.string().optional(), // e.g., "owner,related"
  postType: z.enum(["food", "non-food", "request"]).optional(),
  categoryId: z.string().optional(),
  lat: z.string().optional(),
  lng: z.string().optional(),
  radius: z.string().optional(),
  radiusKm: z.string().optional(), // alias for radius (feed compat)
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
 * Aggregated feed with unread counts (ported from api-v1-listings)
 * Returns nearby listings + notification/message/request counts in a single call.
 */
async function getFeed(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const lat = parseFloatSafe(query.lat, 0);
  const lng = parseFloatSafe(query.lng, 0);
  const radiusKm = parseFloatSafeWithBounds(query.radiusKm || query.radius, 0.1, 1000, 50);
  const limit = parseIntSafe(query.limit, 20);

  const [listings, counts] = await Promise.all([
    supabase.rpc("get_nearby_posts", {
      user_lat: lat,
      user_lng: lng,
      radius_km: radiusKm,
      result_limit: limit,
    }),
    aggregateCounts(supabase, userId),
  ]);

  if (listings.error) {
    logger.error("Feed query failed", new Error(listings.error.message));
    throw listings.error;
  }

  return ok({ listings: listings.data || [], counts }, ctx);
}

/**
 * List products with filters and composite cursor pagination
 * Uses (timestamp, id) composite cursor for precise pagination
 */
async function listProducts(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, query } = ctx;

  // Cache public list queries for 60 seconds (keyed by query params)
  const cacheKey = `products:list:${JSON.stringify(query)}`;
  interface CachedListResult {
    items: Record<string, unknown>[];
    total: number;
    nextCursor: string | null;
    limit: number;
  }
  const cached = cache.get<CachedListResult>(cacheKey);
  if (cached) {
    return paginated(cached.items, ctx, {
      offset: 0,
      limit: cached.limit,
      total: cached.total,
      nextCursor: cached.nextCursor,
    });
  }

  // Use safe numeric parsing with bounds to prevent invalid values
  const limit = normalizeLimit(parseIntSafe(query.limit, 20), 50);
  const postType = query.postType;
  const categoryId = query.categoryId ? parseIntSafe(query.categoryId) : undefined;
  const lat = query.lat ? parseFloatSafe(query.lat) : undefined;
  const lng = query.lng ? parseFloatSafe(query.lng) : undefined;
  // Radius bounds: 0.1km minimum, 1000km maximum (500mi), default 10km
  const radius = parseFloatSafeWithBounds(query.radius, 0.1, 1000, 10);
  const userId = query.userId;

  // Decode composite cursor (timestamp + id)
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  // Build query
  let dbQuery = supabase
    .from("posts_with_location")
    .select("*", { count: "exact" })
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false }) // Secondary sort for tie-breaking
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

  // Apply composite cursor for precise pagination
  // This handles items with the same timestamp by using ID as tie-breaker
  if (cursor) {
    // Get items that are either:
    // 1. Created before the cursor timestamp, OR
    // 2. Created at the same timestamp but with a smaller ID
    dbQuery = dbQuery.or(
      `created_at.lt.${cursor.timestamp},and(created_at.eq.${cursor.timestamp},id.lt.${cursor.id})`
    );
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
      p_cursor: cursor ? cursor.timestamp : null,
      p_cursor_id: cursor ? cursor.id : null,
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

  // Generate next cursor from last item
  const lastItem = resultItems[resultItems.length - 1];
  const nextCursor = hasMore && lastItem
    ? encodeCursor({
        timestamp: lastItem.created_at,
        id: String(lastItem.id),
      })
    : null;

  const transformedItems = resultItems.map(transformProduct);

  // Cache the result for 60 seconds
  cache.set(cacheKey, {
    items: transformedItems,
    total: count || resultItems.length,
    nextCursor,
    limit,
  }, 60_000);

  return paginated(
    transformedItems,
    ctx,
    {
      offset: 0,
      limit,
      total: count || resultItems.length,
      nextCursor,
    }
  );
}

/**
 * Get single product by ID
 */
async function getProduct(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, query, userId } = ctx;
  const productId = query.id;

  if (!productId) {
    throw new ValidationError("Product ID is required");
  }

  const includes = query.include?.split(",").map(s => s.trim()) || [];
  const includeOwner = includes.includes("owner");
  const includeRelated = includes.includes("related");

  // Build profile select fields
  const profileFields = includeOwner
    ? "id, display_name, avatar_url, created_at, bio, rating_average, rating_count, is_volunteer"
    : "id, display_name, avatar_url, created_at";

  // Base product query
  const { data, error } = await supabase
    .from("posts_with_location")
    .select(`
      *,
      profile:profiles!posts_profile_id_fkey(${profileFields}),
      category:categories(id, name, icon)
    `)
    .eq("id", productId)
    .single();

  if (error || !data) {
    throw new NotFoundError("Product", productId);
  }

  const result: any = transformProductDetail(data);

  // Add related listings if requested
  if (includeRelated && data.latitude && data.longitude) {
    const { data: related } = await supabase
      .from("posts_with_location")
      .select("id, title, images, post_type, created_at, latitude, longitude")
      .neq("id", productId)
      .eq("status", "active")
      .or(`category_id.eq.${data.category_id},post_type.eq.${data.post_type}`)
      .limit(6);

    if (related) {
      result.relatedListings = related.map(r => ({
        id: r.id,
        title: r.title,
        imageUrl: r.images?.[0],
        postType: r.post_type,
        createdAt: r.created_at,
      }));
    }
  }

  // Add user interaction state if authenticated
  if (userId && includeOwner) {
    const { data: favorite } = await supabase
      .from("favorites")
      .select("id")
      .eq("user_id", userId)
      .eq("post_id", productId)
      .single();

    result.isFavorited = !!favorite;
    result.canContact = userId !== data.profile_id;
  }

  return ok(result, ctx);
}

/**
 * Create new product
 */
async function createProduct(ctx: HandlerContext<CreateProductBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Validate image URLs belong to our storage
  const imageCheck = validateProductImageUrls(body.images);
  if (!imageCheck.valid) {
    throw new ValidationError(
      "All image URLs must be uploaded through our image API",
      { invalidUrls: imageCheck.invalidUrls }
    );
  }

  // Sanitize user inputs to prevent XSS
  const sanitizedTitle = sanitizeHtml(body.title);
  const sanitizedDescription = body.description ? sanitizeHtml(body.description) : undefined;
  const sanitizedPickupAddress = body.pickupAddress ? sanitizeHtml(body.pickupAddress) : undefined;
  const sanitizedPickupTime = body.pickupTime ? sanitizeHtml(body.pickupTime) : undefined;

  // Validate content using server-side RPC
  const { data: validation, error: validationError } = await supabase.rpc(
    "validate_listing_content",
    {
      p_title: sanitizedTitle,
      p_description: sanitizedDescription || "",
    }
  );

  if (validationError) {
    logger.warn("Content validation failed", { error: validationError.message });
  }

  if (validation && !validation.is_valid) {
    throw new ValidationError("Content validation failed", validation.issues);
  }

  // Create product with sanitized inputs
  const { data, error } = await supabase
    .from("posts")
    .insert({
      profile_id: userId,
      post_name: sanitizedTitle,
      post_description: sanitizedDescription,
      images: body.images,
      post_type: body.postType,
      latitude: body.latitude,
      longitude: body.longitude,
      pickup_address: sanitizedPickupAddress,
      pickup_time: sanitizedPickupTime,
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

  // Fire-and-forget notification for nearby users
  try {
    EdgeRuntime.waitUntil(
      supabase.functions.invoke("api-v1-notifications", {
        body: {
          route: "trigger/new-listing",
          food_item_id: data.id,
          user_id: userId,
          latitude: data.latitude,
          longitude: data.longitude,
          post_name: data.post_name,
          post_type: data.post_type,
        },
      }).catch((err: unknown) => {
        logger.warn("Failed to trigger new-listing notification", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  } catch {
    // EdgeRuntime.waitUntil may not be available in all environments
  }

  return created(transformProduct(data), ctx);
}

/**
 * Update product with optimistic locking
 */
async function updateProduct(ctx: HandlerContext<UpdateProductBody, ListQuery>): Promise<Response> {
  const { supabase, userId, body, query } = ctx;
  const productId = query.id;

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

  // Validate image URLs belong to our storage (when provided)
  if (body.images !== undefined) {
    const imageCheck = validateProductImageUrls(body.images);
    if (!imageCheck.valid) {
      throw new ValidationError(
        "All image URLs must be uploaded through our image API",
        { invalidUrls: imageCheck.invalidUrls }
      );
    }
  }

  // Build update object with sanitized values
  const updates: Record<string, unknown> = {
    version: existing.version + 1,
    updated_at: new Date().toISOString(),
  };

  // Sanitize text fields to prevent XSS
  if (body.title !== undefined) updates.post_name = sanitizeHtml(body.title);
  if (body.description !== undefined) updates.post_description = sanitizeHtml(body.description);
  if (body.images !== undefined) updates.images = body.images;
  if (body.pickupAddress !== undefined) updates.pickup_address = sanitizeHtml(body.pickupAddress);
  if (body.pickupTime !== undefined) updates.pickup_time = sanitizeHtml(body.pickupTime);
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
async function deleteProduct(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const productId = query.id;

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
  // Return raw database format (snake_case) for web compatibility
  return data;
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
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return ok({ status: "healthy", service: "api-v1-products", version: VERSION, timestamp: new Date().toISOString() }, ctx);
  }

  if (ctx.query.mode === "feed") {
    return getFeed(ctx);
  }

  if (ctx.query.id) {
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
