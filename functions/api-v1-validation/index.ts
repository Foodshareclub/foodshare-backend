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
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError } from "../_shared/errors.ts";
import { parseRoute, type ParsedRoute } from "../_shared/routing.ts";
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
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  switch (route.resource) {
    case "health":
    case "":
      return ok({
        status: "healthy",
        version: VERSION,
        service: SERVICE,
        timestamp: new Date().toISOString(),
        endpoints: ["listing", "profile", "review", "email", "password", "batch", "rules"],
      }, ctx);

    case "rules":
      return ok({
        success: true,
        rules: VALIDATION,
        version: VERSION,
      }, ctx);

    default:
      throw new ValidationError(`Not found: ${route.resource}`);
  }
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);
  const body = ctx.body;

  try {
    switch (route.resource) {
      case "listing":
        return ok(handleValidateListing(body), ctx);
      case "profile":
        return ok(handleValidateProfile(body), ctx);
      case "review":
        return ok(handleValidateReview(body), ctx);
      case "email":
        return ok(handleValidateEmail(body), ctx);
      case "password":
        return ok(handleValidatePassword(body), ctx);
      case "batch":
        return ok(handleBatchValidation(body), ctx);
      default:
        throw new ValidationError(`Not found: ${route.resource}`);
    }
  } catch (error) {
    // Handle Zod validation errors as ValidationError
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        "Validation failed",
        error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }))
      );
    }
    throw error;
  }
}

// =============================================================================
// API Handler
// =============================================================================

export default createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 60,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
});
