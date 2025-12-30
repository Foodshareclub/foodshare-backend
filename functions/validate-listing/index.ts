/**
 * validate-listing Edge Function
 *
 * Server-side validation for listing creation with additional security checks.
 * - Profanity/spam detection (via RPC)
 * - URL/link detection (via RPC)
 * - Structural validation (via RPC)
 *
 * Usage from iOS/Android/Web:
 * POST /validate-listing
 * Body: { title, description?, images, postType, latitude, longitude, ... }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Request Schema
// =============================================================================

const validateListingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  images: z.array(z.string().url()).min(1).max(10),
  postType: z.enum(["food", "non_food"]),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  pickupAddress: z.string().max(500).nullable().optional(),
  pickupTime: z.string().max(200).nullable().optional(),
});

type ValidateListingRequest = z.infer<typeof validateListingSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface ValidationErrorItem {
  field: string;
  code: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationErrorItem[];
  sanitized?: Record<string, unknown>;
}

// =============================================================================
// Service Client (for RPC calls)
// =============================================================================

function createServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, supabaseKey);
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleValidateListing(ctx: HandlerContext<ValidateListingRequest>): Promise<Response> {
  const { body, corsHeaders } = ctx;
  const supabase = createServiceClient();

  // -------------------------------------------------------------------------
  // 1. Content moderation via server-side RPC
  // -------------------------------------------------------------------------
  const { data: contentValidation, error: contentError } = await supabase.rpc(
    "validate_listing_content",
    {
      p_title: body.title,
      p_description: body.description,
    }
  );

  if (contentError) {
    logger.error("Content validation RPC error", new Error(contentError.message));
    // Fall through to structural validation
  } else if (contentValidation && !contentValidation.valid) {
    // Content moderation failed
    return new Response(
      JSON.stringify({
        valid: false,
        errors: contentValidation.errors,
        sanitized: null,
      } satisfies ValidationResult),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // -------------------------------------------------------------------------
  // 2. Structural validation via RPC
  // -------------------------------------------------------------------------
  const { data, error: rpcError } = await supabase.rpc("validate_listing", {
    p_title: body.title,
    p_description: body.description,
    p_images: body.images,
    p_post_type: body.postType,
    p_latitude: body.latitude,
    p_longitude: body.longitude,
    p_pickup_address: body.pickupAddress,
    p_pickup_time: body.pickupTime,
  });

  if (rpcError) {
    logger.error("RPC error validating listing", new Error(rpcError.message));
    throw new ValidationError("Validation service unavailable");
  }

  // Parse RPC result
  const result: ValidationResult = typeof data === "string" ? JSON.parse(data) : data;

  // Return validation result
  return new Response(JSON.stringify(result), {
    status: result.valid ? 200 : 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "validate-listing",
  version: "2.0.0",
  requireAuth: false, // Public validation endpoint
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 validations per minute per IP
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: validateListingSchema,
      handler: handleValidateListing,
    },
  },
});
