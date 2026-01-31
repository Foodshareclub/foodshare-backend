/**
 * validate-listing Edge Function
 *
 * Standalone validation endpoint for food listings.
 * Use for real-time client-side validation before submission.
 *
 * This is the server-side single source of truth for validation,
 * matching Swift FoodshareCore validators exactly.
 *
 * POST /validate-listing
 * Body: { title: string, description?: string, quantity?: number }
 * Response: { isValid: boolean, errors: string[] }
 *
 * No authentication required - validation is idempotent and stateless.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { validateListing, type ValidationResult } from "../_shared/validation-rules.ts";

// =============================================================================
// Request Schema
// =============================================================================

const validateListingSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(""),
  quantity: z.number().int().optional().default(1),
  expiresAt: z.string().datetime().optional(),
});

type ValidateListingRequest = z.infer<typeof validateListingSchema>;

// =============================================================================
// Handler
// =============================================================================

async function handleValidateListing(
  ctx: HandlerContext<ValidateListingRequest>
): Promise<Response> {
  const { body } = ctx;

  // Parse expiration date if provided
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;

  // Run validation (uses shared rules matching Swift FoodshareCore)
  const result: ValidationResult = validateListing(
    body.title,
    body.description || "",
    body.quantity || 1,
    expiresAt
  );

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "validate-listing",
  version: "1.0.0",
  requireAuth: false, // Validation is public
  rateLimit: {
    limit: 100, // 100 validations per minute per IP
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: validateListingSchema,
      handler: handleValidateListing,
    },
  },
});
