/**
 * Reviews API v1
 *
 * REST API for user reviews after food exchanges.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-reviews?userId=<id>  - Get reviews for a user
 * - POST   /api-v1-reviews               - Submit a review
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 * - X-Idempotency-Key: <uuid> (for POST)
 *
 * @module api-v1-reviews
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  created,
  paginated,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { ValidationError, ConflictError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { REVIEW, ERROR_MESSAGES } from "../_shared/validation-rules.ts";

const VERSION = "1.0.0";

// =============================================================================
// Schemas (using shared validation constants from Swift FoodshareCore)
// =============================================================================

const submitReviewSchema = z.object({
  revieweeId: z.string().uuid(), // Profile being reviewed
  postId: z.number().int().positive(),
  rating: z.number().int().min(REVIEW.rating.min).max(REVIEW.rating.max),
  feedback: z.string().max(REVIEW.comment.maxLength).optional(),
});

const querySchema = z.object({
  userId: z.string().uuid().optional(),
  postId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

type SubmitReviewBody = z.infer<typeof submitReviewSchema>;
type QueryParams = z.infer<typeof querySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * Get reviews for a user or post
 */
async function getReviews(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  const { supabase, query } = ctx;

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const cursor = query.cursor;

  let dbQuery = supabase
    .from("reviews")
    .select(`
      id,
      profile_id,
      post_id,
      reviewer_id,
      reviewed_rating,
      feedback,
      created_at,
      reviewer:reviewer_id (id, first_name, second_name, avatar_url)
    `, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (query.userId) {
    dbQuery = dbQuery.eq("profile_id", query.userId);
  }

  if (query.postId) {
    dbQuery = dbQuery.eq("post_id", parseInt(query.postId));
  }

  if (cursor) {
    dbQuery = dbQuery.lt("created_at", cursor);
  }

  const { data, error, count } = await dbQuery;

  if (error) {
    logger.error("Failed to get reviews", new Error(error.message));
    throw error;
  }

  const items = data || [];
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, -1) : items;

  return paginated(
    resultItems.map(transformReview),
    ctx,
    {
      offset: 0,
      limit,
      total: count || resultItems.length,
    }
  );
}

/**
 * Submit a review
 */
async function submitReview(ctx: HandlerContext<SubmitReviewBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Prevent self-review
  if (body.revieweeId === userId) {
    throw new ValidationError(ERROR_MESSAGES.cannotReviewSelf);
  }

  // Check for existing review (unique constraint: reviewer + reviewee + post)
  const { data: existing } = await supabase
    .from("reviews")
    .select("id")
    .eq("reviewer_id", userId)
    .eq("profile_id", body.revieweeId)
    .eq("post_id", body.postId)
    .single();

  if (existing) {
    throw new ConflictError(ERROR_MESSAGES.alreadyReviewed);
  }

  // Insert review
  const { data, error } = await supabase
    .from("reviews")
    .insert({
      profile_id: body.revieweeId,
      post_id: body.postId,
      reviewer_id: userId,
      reviewed_rating: body.rating,
      feedback: body.feedback || "",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError("You have already reviewed this exchange");
    }
    logger.error("Failed to submit review", new Error(error.message));
    throw error;
  }

  // Update reviewee's rating stats (if trigger doesn't handle it)
  // This is a fallback - ideally handled by database trigger
  const { data: stats } = await supabase
    .from("reviews")
    .select("reviewed_rating")
    .eq("profile_id", body.revieweeId);

  if (stats && stats.length > 0) {
    const totalRatings = stats.length;
    const avgRating = stats.reduce((sum, r) => sum + r.reviewed_rating, 0) / totalRatings;

    await supabase
      .from("profiles")
      .update({
        rating_count: totalRatings,
        rating_average: Math.round(avgRating * 10) / 10, // 1 decimal place
      })
      .eq("id", body.revieweeId);
  }

  logger.info("Review submitted", {
    reviewId: data.id,
    reviewerId: userId,
    revieweeId: body.revieweeId,
    postId: body.postId,
    rating: body.rating,
  });

  return created(transformReview(data), ctx);
}

// =============================================================================
// Transformers
// =============================================================================

function transformReview(data: Record<string, unknown>) {
  const reviewer = data.reviewer as Record<string, unknown> | null;

  return {
    id: data.id,
    revieweeId: data.profile_id,
    postId: data.post_id,
    reviewerId: data.reviewer_id,
    rating: data.reviewed_rating,
    feedback: data.feedback,
    createdAt: data.created_at,
    reviewer: reviewer
      ? {
          id: reviewer.id,
          name: `${reviewer.first_name || ""} ${reviewer.second_name || ""}`.trim(),
          avatarUrl: reviewer.avatar_url,
        }
      : null,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

function handleGet(ctx: HandlerContext<unknown, QueryParams>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return ok({ status: "healthy", service: "api-v1-reviews", version: VERSION, timestamp: new Date().toISOString() }, ctx);
  }

  return getReviews(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-reviews",
  version: "1.0.0",
  requireAuth: false, // GET is public, POST requires auth
  rateLimit: {
    limit: 30,
    windowMs: 60000,
    keyBy: "user",
    skip: (ctx) => ctx.request.method === "GET",
  },
  routes: {
    GET: {
      querySchema,
      handler: handleGet,
      requireAuth: false,
    },
    POST: {
      schema: submitReviewSchema,
      handler: submitReview,
      requireAuth: true,
      idempotent: true,
    },
  },
}));
