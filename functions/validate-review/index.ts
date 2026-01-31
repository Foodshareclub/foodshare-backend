/**
 * validate-review Edge Function
 *
 * Standalone validation endpoint for user reviews.
 * Use for real-time client-side validation before submission.
 *
 * This is the server-side single source of truth for validation,
 * matching Swift FoodshareCore validators exactly.
 *
 * POST /validate-review
 * Body: { rating: number, comment?: string, revieweeId?: string }
 * Response: { isValid: boolean, errors: string[] }
 *
 * No authentication required - validation is idempotent and stateless.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { validateReview, type ValidationResult } from "../_shared/validation-rules.ts";

// =============================================================================
// Request Schema
// =============================================================================

const validateReviewSchema = z.object({
  rating: z.number().int(),
  comment: z.string().optional().nullable(),
  revieweeId: z.string().uuid().optional().nullable(),
});

type ValidateReviewRequest = z.infer<typeof validateReviewSchema>;

// =============================================================================
// Handler
// =============================================================================

async function handleValidateReview(
  ctx: HandlerContext<ValidateReviewRequest>
): Promise<Response> {
  const { body } = ctx;

  // Run validation (uses shared rules matching Swift FoodshareCore)
  const result: ValidationResult = validateReview(
    body.rating,
    body.comment,
    body.revieweeId
  );

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "validate-review",
  version: "1.0.0",
  requireAuth: false, // Validation is public
  rateLimit: {
    limit: 100, // 100 validations per minute per IP
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: validateReviewSchema,
      handler: handleValidateReview,
    },
  },
});
