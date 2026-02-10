/**
 * Unified Validation Microservice
 * Phase 1: Single validation Edge Function for all entity types
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Validation rules (synced with Swift FoodshareCore)
const VALIDATION_RULES = {
  listing: {
    title: { minLength: 3, maxLength: 100, required: true },
    description: { maxLength: 500, required: false },
    quantity: { min: 1, required: false },
    expirationMaxDays: 30,
  },
  profile: {
    displayName: { minLength: 2, maxLength: 50, required: true },
    bio: { maxLength: 200, required: false },
  },
  review: {
    rating: { min: 1, max: 5, required: true },
    comment: { maxLength: 500, required: false },
  },
  auth: {
    email: { required: true },
    password: { minLength: 8, required: true },
  },
  message: {
    content: { maxLength: 2000, required: true },
  },
  forum: {
    title: { minLength: 5, maxLength: 150, required: true },
    content: { maxLength: 5000, required: false },
  },
  search: {
    query: { maxLength: 200, required: false },
    distance: { min: 0, max: 100, required: false },
  },
};

interface ValidationRequest {
  entityType: "listing" | "profile" | "review" | "auth" | "message" | "forum" | "search";
  data: Record<string, unknown>;
  context?: {
    platform?: "ios" | "android" | "web";
    appVersion?: string;
    userId?: string;
    locale?: string;
  };
}

interface ValidationError {
  field: string;
  code: string;
  message: string;
}

interface ValidationWarning {
  field: string;
  code: string;
  message: string;
}

interface ValidationResponse {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  sanitized: Record<string, string>;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { entityType, data, context } = await req.json() as ValidationRequest;

    if (!entityType || !data) {
      return new Response(
        JSON.stringify({ error: "Missing entityType or data" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const result = validateEntity(entityType, data, context);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Validation error:", error);
    return new Response(
      JSON.stringify({ error: "Validation failed", message: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

function validateEntity(
  entityType: string,
  data: Record<string, unknown>,
  _context?: ValidationRequest["context"],
): ValidationResponse {
  switch (entityType) {
    case "listing":
      return validateListing(data);
    case "profile":
      return validateProfile(data);
    case "review":
      return validateReview(data);
    case "auth":
      return validateAuth(data);
    case "message":
      return validateMessage(data);
    case "forum":
      return validateForum(data);
    case "search":
      return validateSearch(data);
    default:
      return {
        isValid: false,
        errors: [{
          field: "entityType",
          code: "UNKNOWN",
          message: `Unknown entity type: ${entityType}`,
        }],
        warnings: [],
        sanitized: {},
      };
  }
}

function validateListing(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.listing;

  // Title
  const title = sanitizeString(data.title);
  sanitized.title = title;

  if (!title) {
    errors.push({ field: "title", code: "REQUIRED", message: "Title is required" });
  } else if (title.length < rules.title.minLength) {
    errors.push({
      field: "title",
      code: "TOO_SHORT",
      message: `Title must be at least ${rules.title.minLength} characters`,
    });
  } else if (title.length > rules.title.maxLength) {
    errors.push({
      field: "title",
      code: "TOO_LONG",
      message: `Title cannot exceed ${rules.title.maxLength} characters`,
    });
  }

  if (title && isAllCaps(title)) {
    warnings.push({
      field: "title",
      code: "ALL_CAPS",
      message: "Consider using normal capitalization",
    });
  }

  // Description
  const description = sanitizeString(data.description);
  sanitized.description = description;

  if (description && description.length > rules.description.maxLength) {
    errors.push({
      field: "description",
      code: "TOO_LONG",
      message: `Description cannot exceed ${rules.description.maxLength} characters`,
    });
  }
  if (description && description.length < 20) {
    warnings.push({
      field: "description",
      code: "TOO_SHORT",
      message: "Consider adding more details",
    });
  }

  // Quantity
  const quantity = typeof data.quantity === "number" ? data.quantity : 1;
  if (quantity < rules.quantity.min) {
    errors.push({ field: "quantity", code: "INVALID", message: "Quantity must be at least 1" });
  }

  // Expiration
  if (data.expiresAt) {
    const expiresAt = new Date(data.expiresAt as string);
    const now = new Date();
    if (expiresAt < now) {
      errors.push({
        field: "expiresAt",
        code: "IN_PAST",
        message: "Expiration date cannot be in the past",
      });
    } else {
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + rules.expirationMaxDays);
      if (expiresAt > maxDate) {
        errors.push({
          field: "expiresAt",
          code: "TOO_FAR",
          message: `Expiration cannot be more than ${rules.expirationMaxDays} days away`,
        });
      }
    }

    // Warning for very short expiration
    const hoursUntil = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursUntil < 2) {
      warnings.push({ field: "expiresAt", code: "VERY_SOON", message: "Item expires very soon" });
    }
  }

  // Location
  if (data.latitude !== undefined && data.longitude !== undefined) {
    const lat = data.latitude as number;
    const lng = data.longitude as number;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      errors.push({ field: "location", code: "INVALID", message: "Invalid location coordinates" });
    }
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

function validateProfile(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.profile;

  // Display name
  const displayName = sanitizeString(data.displayName);
  sanitized.displayName = displayName;

  if (!displayName) {
    errors.push({ field: "displayName", code: "REQUIRED", message: "Display name is required" });
  } else if (displayName.length < rules.displayName.minLength) {
    errors.push({
      field: "displayName",
      code: "TOO_SHORT",
      message: `Display name must be at least ${rules.displayName.minLength} characters`,
    });
  } else if (displayName.length > rules.displayName.maxLength) {
    errors.push({
      field: "displayName",
      code: "TOO_LONG",
      message: `Display name cannot exceed ${rules.displayName.maxLength} characters`,
    });
  }

  // Bio
  const bio = sanitizeString(data.bio);
  sanitized.bio = bio;

  if (bio && bio.length > rules.bio.maxLength) {
    errors.push({
      field: "bio",
      code: "TOO_LONG",
      message: `Bio cannot exceed ${rules.bio.maxLength} characters`,
    });
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

function validateReview(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.review;

  // Rating
  const rating = typeof data.rating === "number" ? data.rating : null;
  if (rating === null) {
    errors.push({ field: "rating", code: "REQUIRED", message: "Rating is required" });
  } else if (rating < rules.rating.min || rating > rules.rating.max) {
    errors.push({
      field: "rating",
      code: "OUT_OF_RANGE",
      message: `Rating must be between ${rules.rating.min} and ${rules.rating.max}`,
    });
  }

  // Comment
  const comment = sanitizeString(data.comment);
  sanitized.comment = comment;

  if (comment && comment.length > rules.comment.maxLength) {
    errors.push({
      field: "comment",
      code: "TOO_LONG",
      message: `Comment cannot exceed ${rules.comment.maxLength} characters`,
    });
  }
  if (comment && comment.length < 10) {
    warnings.push({ field: "comment", code: "TOO_SHORT", message: "Consider adding more detail" });
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

function validateAuth(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const rules = VALIDATION_RULES.auth;

  // Email
  const email = sanitizeString(data.email);
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}$/;

  if (!email) {
    errors.push({ field: "email", code: "REQUIRED", message: "Email is required" });
  } else if (!emailRegex.test(email)) {
    errors.push({
      field: "email",
      code: "INVALID_FORMAT",
      message: "Please enter a valid email address",
    });
  }

  // Password
  const password = String(data.password || "");
  if (!password) {
    errors.push({ field: "password", code: "REQUIRED", message: "Password is required" });
  } else if (password.length < rules.password.minLength) {
    errors.push({
      field: "password",
      code: "TOO_SHORT",
      message: `Password must be at least ${rules.password.minLength} characters`,
    });
  } else {
    // Check password strength
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);

    if (!hasUpper || !hasLower || !hasDigit) {
      warnings.push({
        field: "password",
        code: "WEAK",
        message: "Consider using a stronger password",
      });
    }
  }

  // Password confirmation
  if (data.confirmPassword !== undefined && password !== data.confirmPassword) {
    errors.push({ field: "confirmPassword", code: "MISMATCH", message: "Passwords do not match" });
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized: {} };
}

function validateMessage(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.message;

  const content = sanitizeString(data.content);
  sanitized.content = content;

  if (!content) {
    errors.push({ field: "content", code: "REQUIRED", message: "Message cannot be empty" });
  } else if (content.length > rules.content.maxLength) {
    errors.push({
      field: "content",
      code: "TOO_LONG",
      message: `Message cannot exceed ${rules.content.maxLength} characters`,
    });
  }

  return { isValid: errors.length === 0, errors, warnings: [], sanitized };
}

function validateForum(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.forum;

  // Title
  const title = sanitizeString(data.title);
  sanitized.title = title;

  if (!title) {
    errors.push({ field: "title", code: "REQUIRED", message: "Title is required" });
  } else if (title.length < rules.title.minLength) {
    errors.push({
      field: "title",
      code: "TOO_SHORT",
      message: `Title must be at least ${rules.title.minLength} characters`,
    });
  } else if (title.length > rules.title.maxLength) {
    errors.push({
      field: "title",
      code: "TOO_LONG",
      message: `Title cannot exceed ${rules.title.maxLength} characters`,
    });
  }

  // Content
  const content = sanitizeString(data.content);
  sanitized.content = content;

  if (content && content.length > rules.content.maxLength) {
    errors.push({
      field: "content",
      code: "TOO_LONG",
      message: `Content cannot exceed ${rules.content.maxLength} characters`,
    });
  }

  return { isValid: errors.length === 0, errors, warnings: [], sanitized };
}

function validateSearch(data: Record<string, unknown>): ValidationResponse {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const sanitized: Record<string, string> = {};
  const rules = VALIDATION_RULES.search;

  // Query
  const query = sanitizeString(data.query);
  sanitized.query = query;

  if (query && query.length > rules.query.maxLength) {
    errors.push({
      field: "query",
      code: "TOO_LONG",
      message: `Search query cannot exceed ${rules.query.maxLength} characters`,
    });
  }
  if (query && query.length < 2) {
    warnings.push({
      field: "query",
      code: "TOO_SHORT",
      message: "Try a more specific search term",
    });
  }

  // Distance
  if (data.distance !== undefined) {
    const distance = data.distance as number;
    if (distance < rules.distance.min || distance > rules.distance.max) {
      errors.push({
        field: "distance",
        code: "OUT_OF_RANGE",
        message: `Distance must be between ${rules.distance.min} and ${rules.distance.max} km`,
      });
    }
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

// Helper functions
function sanitizeString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/[<>]/g, ""); // Remove angle brackets
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}
