/**
 * validate-profile Edge Function
 *
 * Standalone validation endpoint for user profiles.
 * Use for real-time client-side validation before submission.
 *
 * This is the server-side single source of truth for validation,
 * matching Swift FoodshareCore validators exactly.
 *
 * POST /validate-profile
 * Body: { nickname?: string, bio?: string }
 * Response: { isValid: boolean, errors: string[] }
 *
 * No authentication required - validation is idempotent and stateless.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { validateProfile, type ValidationResult } from "../_shared/validation-rules.ts";

// =============================================================================
// Request Schema
// =============================================================================

const validateProfileSchema = z.object({
  nickname: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
});

type ValidateProfileRequest = z.infer<typeof validateProfileSchema>;

// =============================================================================
// Handler
// =============================================================================

async function handleValidateProfile(
  ctx: HandlerContext<ValidateProfileRequest>
): Promise<Response> {
  const { body } = ctx;

  // Run validation (uses shared rules matching Swift FoodshareCore)
  const result: ValidationResult = validateProfile(
    body.nickname,
    body.bio
  );

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "validate-profile",
  version: "1.0.0",
  requireAuth: false, // Validation is public
  rateLimit: {
    limit: 100, // 100 validations per minute per IP
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: validateProfileSchema,
      handler: handleValidateProfile,
    },
  },
});
