/**
 * Unified Validation API v1
 *
 * Enterprise-grade validation API consolidating ALL validation operations:
 * - Listings: Title, description, quantity, expiration
 * - Profiles: Nickname, bio
 * - Reviews: Rating, comment
 * - Email: Format validation
 * - Password: Strength evaluation
 *
 * Routes:
 * - GET    /health           - Health check
 * - GET    /rules            - Get validation rules (for client sync)
 * - POST   /listing          - Validate listing
 * - POST   /profile          - Validate profile
 * - POST   /review           - Validate review
 * - POST   /email            - Validate email
 * - POST   /password         - Validate password with strength
 * - POST   /batch            - Batch validate multiple entities
 *
 * No authentication required - validation is idempotent and stateless.
 *
 * @module api-v1-validation
 * @version 1.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import {
  validateListing,
  validateProfile,
  validateReview,
  validateEmailEnhanced,
  validatePassword,
  evaluatePasswordStrength,
  VALIDATION,
  type ValidationResult,
} from "../_shared/validation-rules.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-validation";

// =============================================================================
// Request Schemas
// =============================================================================

const listingSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(""),
  quantity: z.number().int().optional().default(1),
  expiresAt: z.string().datetime().optional(),
});

const profileSchema = z.object({
  nickname: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
});

const reviewSchema = z.object({
  rating: z.number().int(),
  comment: z.string().optional().nullable(),
  revieweeId: z.string().uuid().optional().nullable(),
});

const emailSchema = z.object({
  email: z.string(),
});

const passwordSchema = z.object({
  password: z.string(),
});

const batchSchema = z.object({
  validations: z.array(z.object({
    type: z.enum(["listing", "profile", "review", "email", "password"]),
    data: z.record(z.unknown()),
  })).min(1).max(20),
});

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400,
  requestId?: string
): Response {
  return jsonResponse({ success: false, error, requestId }, corsHeaders, status);
}

// =============================================================================
// Route Parser
// =============================================================================

interface ParsedRoute {
  endpoint: string;
  method: string;
}

function parseRoute(url: URL, method: string): ParsedRoute {
  const path = url.pathname
    .replace(/^\/api-v1-validation\/?/, "")
    .replace(/^\/*/, "");

  return { endpoint: path || "health", method };
}

// =============================================================================
// Validation Handlers
// =============================================================================

function handleValidateListing(body: unknown): ValidationResult {
  const data = listingSchema.parse(body);
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : undefined;

  return validateListing(
    data.title,
    data.description || "",
    data.quantity || 1,
    expiresAt
  );
}

function handleValidateProfile(body: unknown): ValidationResult {
  const data = profileSchema.parse(body);
  return validateProfile(data.nickname, data.bio);
}

function handleValidateReview(body: unknown): ValidationResult {
  const data = reviewSchema.parse(body);
  return validateReview(data.rating, data.comment, data.revieweeId);
}

function handleValidateEmail(body: unknown): ValidationResult {
  const data = emailSchema.parse(body);
  return validateEmailEnhanced(data.email);
}

interface PasswordValidationResult extends ValidationResult {
  strength: number;
  strengthLabel: string;
}

function handleValidatePassword(body: unknown): PasswordValidationResult {
  const data = passwordSchema.parse(body);
  const result = validatePassword(data.password);
  const strength = evaluatePasswordStrength(data.password);

  const strengthLabels = ["None", "Weak", "Medium", "Strong", "Very Strong"];

  return {
    ...result,
    strength,
    strengthLabel: strengthLabels[strength] || "Unknown",
  };
}

interface BatchValidationItem {
  type: string;
  isValid: boolean;
  errors: string[];
  strength?: number;
  strengthLabel?: string;
}

function handleBatchValidation(body: unknown): { results: BatchValidationItem[] } {
  const data = batchSchema.parse(body);

  const results = data.validations.map((item) => {
    try {
      let result: ValidationResult | PasswordValidationResult;

      switch (item.type) {
        case "listing":
          result = handleValidateListing(item.data);
          break;
        case "profile":
          result = handleValidateProfile(item.data);
          break;
        case "review":
          result = handleValidateReview(item.data);
          break;
        case "email":
          result = handleValidateEmail(item.data);
          break;
        case "password":
          result = handleValidatePassword(item.data);
          break;
        default:
          return { type: item.type, isValid: false, errors: [`Unknown validation type: ${item.type}`] };
      }

      return { type: item.type, ...result };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { type: item.type, isValid: false, errors: [err.message] };
    }
  });

  return { results };
}

// =============================================================================
// Main Router
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const requestId = crypto.randomUUID();
  const corsHeaders = getCorsHeaders(req);
  const url = new URL(req.url);
  const route = parseRoute(url, req.method);

  try {
    // GET endpoints (no body parsing)
    if (route.method === "GET") {
      switch (route.endpoint) {
        case "health":
        case "":
          return jsonResponse({
            status: "healthy",
            version: VERSION,
            service: SERVICE,
            timestamp: new Date().toISOString(),
            endpoints: ["listing", "profile", "review", "email", "password", "batch", "rules"],
          }, corsHeaders);

        case "rules":
          return jsonResponse({
            success: true,
            rules: VALIDATION,
            version: VERSION,
          }, corsHeaders);

        default:
          return errorResponse("Not found", corsHeaders, 404, requestId);
      }
    }

    // POST endpoints (require body)
    if (route.method === "POST") {
      const body = await req.json().catch(() => ({}));

      switch (route.endpoint) {
        case "listing":
          return jsonResponse(handleValidateListing(body), corsHeaders);

        case "profile":
          return jsonResponse(handleValidateProfile(body), corsHeaders);

        case "review":
          return jsonResponse(handleValidateReview(body), corsHeaders);

        case "email":
          return jsonResponse(handleValidateEmail(body), corsHeaders);

        case "password":
          return jsonResponse(handleValidatePassword(body), corsHeaders);

        case "batch":
          return jsonResponse(handleBatchValidation(body), corsHeaders);

        default:
          return errorResponse("Not found", corsHeaders, 404, requestId);
      }
    }

    return errorResponse("Method not allowed", corsHeaders, 405, requestId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    // Handle Zod validation errors
    if (err.name === "ZodError") {
      const zodError = error as z.ZodError;
      return jsonResponse({
        isValid: false,
        errors: zodError.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        requestId,
      }, corsHeaders, 400);
    }

    logger.error("Validation request failed", err, { requestId, path: url.pathname });

    return jsonResponse({
      success: false,
      error: err.message,
      requestId,
    }, corsHeaders, 500);
  }
});
