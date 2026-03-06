/**
 * Validation Rules - Single Source of Truth
 *
 * AUTO-SYNCED with Swift FoodshareCore validators:
 * - foodshare-core/Sources/FoodshareCore/Validation/ListingValidator.swift
 * - foodshare-core/Sources/FoodshareCore/Validation/ProfileValidator.swift
 * - foodshare-core/Sources/FoodshareCore/Validation/ReviewValidator.swift
 * - foodshare-core/Sources/FoodshareCore/Validation/AuthValidator.swift
 *
 * IMPORTANT: Update this file when Swift validation constants change.
 * These values must match iOS, Android, and Web clients.
 */

// =============================================================================
// Listing Validation (from ListingValidator.swift)
// =============================================================================

export const LISTING = {
  title: {
    minLength: 3,
    maxLength: 100,
  },
  description: {
    maxLength: 500,
  },
  quantity: {
    min: 1,
  },
  expiration: {
    maxDays: 30,
  },
} as const;

// =============================================================================
// Profile Validation (from ProfileValidator.swift)
// =============================================================================

export const PROFILE = {
  nickname: {
    minLength: 2,
    maxLength: 50,
  },
  bio: {
    maxLength: 300,
  },
} as const;

// =============================================================================
// Review Validation (from ReviewValidator.swift)
// =============================================================================

export const REVIEW = {
  rating: {
    min: 1,
    max: 5,
  },
  comment: {
    maxLength: 500,
  },
} as const;

// =============================================================================
// Auth Validation (from AuthValidator.swift)
// =============================================================================

export const AUTH = {
  password: {
    minLength: 8,
    maxLength: 128,
  },
  email: {
    // RFC 5322 compliant email pattern
    pattern: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  },
} as const;

// =============================================================================
// Aggregate Export
// =============================================================================

export const VALIDATION = {
  listing: LISTING,
  profile: PROFILE,
  review: REVIEW,
  auth: AUTH,
} as const;

// =============================================================================
// Error Messages (matching Swift ValidationError messages)
// =============================================================================

export const ERROR_MESSAGES = {
  // Listing errors
  titleEmpty: "Title is required",
  titleTooShort: (min: number) => `Title must be at least ${min} characters`,
  titleTooLong: (max: number) => `Title cannot exceed ${max} characters`,
  descriptionEmpty: "Description is required",
  descriptionTooLong: (max: number) => `Description cannot exceed ${max} characters`,
  invalidQuantity: "Quantity must be at least 1",
  expirationInPast: "Expiration date cannot be in the past",
  expirationTooFarFuture: (days: number) =>
    `Expiration date cannot be more than ${days} days from now`,

  // Profile errors
  displayNameEmpty: "Display name is required",
  displayNameTooShort: (min: number) => `Display name must be at least ${min} characters`,
  displayNameTooLong: (max: number) => `Display name cannot exceed ${max} characters`,
  bioTooLong: (max: number) => `Bio cannot exceed ${max} characters`,

  // Review errors
  invalidRating: (min: number, max: number) => `Rating must be between ${min} and ${max}`,
  commentTooLong: (max: number) => `Comment cannot exceed ${max} characters`,
  missingReviewee: "Missing user to review",
  alreadyReviewed: "You have already reviewed this transaction",
  cannotReviewSelf: "You cannot review yourself",

  // Auth errors
  emailRequired: "Email is required",
  emailInvalid: "Please enter a valid email address",
  passwordRequired: "Password is required",
  passwordTooShort: (min: number) => `Password must be at least ${min} characters`,
  passwordTooLong: (max: number) => `Password cannot exceed ${max} characters`,
} as const;

// =============================================================================
// Validation Types
// =============================================================================

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate a listing
 */
export function validateListing(
  title: string,
  description: string,
  quantity: number = 1,
  expiresAt?: Date,
): ValidationResult {
  const errors: string[] = [];
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  // Title validation
  if (!trimmedTitle) {
    errors.push(ERROR_MESSAGES.titleEmpty);
  } else if (trimmedTitle.length < LISTING.title.minLength) {
    errors.push(ERROR_MESSAGES.titleTooShort(LISTING.title.minLength));
  } else if (trimmedTitle.length > LISTING.title.maxLength) {
    errors.push(ERROR_MESSAGES.titleTooLong(LISTING.title.maxLength));
  }

  // Description validation
  if (trimmedDescription.length > LISTING.description.maxLength) {
    errors.push(ERROR_MESSAGES.descriptionTooLong(LISTING.description.maxLength));
  }

  // Quantity validation
  if (quantity < LISTING.quantity.min) {
    errors.push(ERROR_MESSAGES.invalidQuantity);
  }

  // Expiration validation
  if (expiresAt) {
    const now = new Date();
    if (expiresAt < now) {
      errors.push(ERROR_MESSAGES.expirationInPast);
    } else {
      const maxExpiration = new Date(now);
      maxExpiration.setDate(maxExpiration.getDate() + LISTING.expiration.maxDays);
      if (expiresAt > maxExpiration) {
        errors.push(ERROR_MESSAGES.expirationTooFarFuture(LISTING.expiration.maxDays));
      }
    }
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validate a profile
 */
export function validateProfile(
  nickname: string | null | undefined,
  bio: string | null | undefined,
): ValidationResult {
  const errors: string[] = [];

  // Nickname validation
  if (nickname) {
    const trimmed = nickname.trim();
    if (trimmed) {
      if (trimmed.length < PROFILE.nickname.minLength) {
        errors.push(ERROR_MESSAGES.displayNameTooShort(PROFILE.nickname.minLength));
      } else if (trimmed.length > PROFILE.nickname.maxLength) {
        errors.push(ERROR_MESSAGES.displayNameTooLong(PROFILE.nickname.maxLength));
      }
    }
  }

  // Bio validation
  if (bio) {
    const trimmed = bio.trim();
    if (trimmed.length > PROFILE.bio.maxLength) {
      errors.push(ERROR_MESSAGES.bioTooLong(PROFILE.bio.maxLength));
    }
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validate a review
 */
export function validateReview(
  rating: number,
  comment?: string | null,
  revieweeId?: string | null,
): ValidationResult {
  const errors: string[] = [];

  // Rating validation
  if (rating < REVIEW.rating.min || rating > REVIEW.rating.max) {
    errors.push(ERROR_MESSAGES.invalidRating(REVIEW.rating.min, REVIEW.rating.max));
  }

  // Comment validation
  if (comment) {
    const trimmed = comment.trim();
    if (trimmed.length > REVIEW.comment.maxLength) {
      errors.push(ERROR_MESSAGES.commentTooLong(REVIEW.comment.maxLength));
    }
  }

  // Reviewee validation
  if (revieweeId !== undefined && revieweeId !== null && !revieweeId) {
    errors.push(ERROR_MESSAGES.missingReviewee);
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validate email format
 */
export function validateEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed) return false;
  return AUTH.email.pattern.test(trimmed);
}

/**
 * Validate password
 */
export function validatePassword(password: string): ValidationResult {
  const errors: string[] = [];

  if (!password) {
    errors.push(ERROR_MESSAGES.passwordRequired);
  } else if (password.length < AUTH.password.minLength) {
    errors.push(ERROR_MESSAGES.passwordTooShort(AUTH.password.minLength));
  } else if (password.length > AUTH.password.maxLength) {
    errors.push(ERROR_MESSAGES.passwordTooLong(AUTH.password.maxLength));
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Password strength levels (matching Swift PasswordStrength enum)
 */
export enum PasswordStrength {
  None = 0,
  Weak = 1,
  Medium = 2,
  Strong = 3,
  VeryStrong = 4,
}

/**
 * Evaluate password strength (matching Swift algorithm)
 */
export function evaluatePasswordStrength(password: string): PasswordStrength {
  if (!password) return PasswordStrength.None;
  if (password.length < AUTH.password.minLength) return PasswordStrength.Weak;

  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  const strengthScore = [hasUppercase, hasLowercase, hasNumber, hasSpecial]
    .filter(Boolean).length;

  switch (strengthScore) {
    case 0:
    case 1:
      return PasswordStrength.Weak;
    case 2:
      return PasswordStrength.Medium;
    case 3:
      return PasswordStrength.Strong;
    default:
      return PasswordStrength.VeryStrong;
  }
}

// =============================================================================
// XSS Prevention - HTML Sanitization
// =============================================================================

/**
 * HTML entities to escape for XSS prevention
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
  "`": "&#x60;",
  "=": "&#x3D;",
};

/**
 * Patterns that indicate potential XSS attacks
 */
const XSS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi, // onclick=, onerror=, etc.
  /data:\s*text\/html/gi,
  /vbscript:/gi,
  /expression\s*\(/gi,
];

/**
 * Sanitize a string by escaping HTML special characters
 * Prevents XSS attacks when user input is rendered in HTML context
 */
export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return "";

  return input.replace(/[&<>"'`=/]/g, (char) => HTML_ESCAPE_MAP[char] || char);
}

/**
 * Remove dangerous HTML/JS patterns from a string
 * More aggressive than sanitizeHtml - actually strips dangerous content
 */
export function stripDangerousContent(input: string | null | undefined): string {
  if (!input) return "";

  let result = input;

  // Remove script tags and their content
  for (const pattern of XSS_PATTERNS) {
    result = result.replace(pattern, "");
  }

  // Remove any remaining HTML tags
  result = result.replace(/<[^>]*>/g, "");

  return result.trim();
}

/**
 * Check if a string contains potential XSS patterns
 */
export function containsXssPatterns(input: string | null | undefined): boolean {
  if (!input) return false;

  return XSS_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

/**
 * Recursively sanitize all string values in an object
 * Useful for sanitizing entire request bodies
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  options: {
    stripDangerous?: boolean;
    excludeKeys?: string[];
  } = {},
): T {
  const { stripDangerous = false, excludeKeys = [] } = options;

  const sanitize = (value: unknown, key?: string): unknown => {
    // Skip excluded keys
    if (key && excludeKeys.includes(key)) {
      return value;
    }

    if (typeof value === "string") {
      return stripDangerous ? stripDangerousContent(value) : sanitizeHtml(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = sanitize(v, k);
      }
      return result;
    }

    return value;
  };

  return sanitize(obj) as T;
}

// =============================================================================
// Numeric Input Safety
// =============================================================================

/**
 * Safely parse an integer with NaN protection
 * Returns defaultValue if parsing fails or result is NaN
 */
export function parseIntSafe(
  value: string | number | null | undefined,
  defaultValue: number = 0,
): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === "number") return Number.isNaN(value) ? defaultValue : Math.floor(value);

  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Safely parse a float with NaN protection
 * Returns defaultValue if parsing fails or result is NaN/Infinity
 */
export function parseFloatSafe(
  value: string | number | null | undefined,
  defaultValue: number = 0,
): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === "number") {
    return Number.isNaN(value) || !Number.isFinite(value) ? defaultValue : value;
  }

  const parsed = parseFloat(value);
  return Number.isNaN(parsed) || !Number.isFinite(parsed) ? defaultValue : parsed;
}

/**
 * Safely parse an integer with bounds checking
 * Clamps the result to the specified range
 */
export function parseIntSafeWithBounds(
  value: string | number | null | undefined,
  min: number,
  max: number,
  defaultValue?: number,
): number {
  const effectiveDefault = defaultValue ?? min;
  const parsed = parseIntSafe(value, effectiveDefault);
  return Math.max(min, Math.min(max, parsed));
}

/**
 * Safely parse a float with bounds checking
 * Clamps the result to the specified range
 */
export function parseFloatSafeWithBounds(
  value: string | number | null | undefined,
  min: number,
  max: number,
  defaultValue?: number,
): number {
  const effectiveDefault = defaultValue ?? min;
  const parsed = parseFloatSafe(value, effectiveDefault);
  return Math.max(min, Math.min(max, parsed));
}

// =============================================================================
// Email Validation Enhancement
// =============================================================================

/**
 * Enhanced email validation with additional checks
 * - No consecutive dots
 * - Valid domain length
 * - Valid TLD
 */
export function validateEmailEnhanced(email: string): ValidationResult {
  const errors: string[] = [];
  const trimmed = email.trim().toLowerCase();

  if (!trimmed) {
    errors.push(ERROR_MESSAGES.emailRequired);
    return { isValid: false, errors };
  }

  // Basic format check
  if (!AUTH.email.pattern.test(trimmed)) {
    errors.push(ERROR_MESSAGES.emailInvalid);
    return { isValid: false, errors };
  }

  // No consecutive dots
  if (/\.{2,}/.test(trimmed)) {
    errors.push("Email cannot contain consecutive dots");
    return { isValid: false, errors };
  }

  // Check domain part
  const [, domain] = trimmed.split("@");
  if (domain) {
    // Domain length check (max 253 chars per RFC)
    if (domain.length > 253) {
      errors.push("Email domain is too long");
      return { isValid: false, errors };
    }

    // TLD validation (at least 2 chars, no numbers only)
    const tld = domain.split(".").pop() || "";
    if (tld.length < 2 || /^\d+$/.test(tld)) {
      errors.push("Email has invalid top-level domain");
      return { isValid: false, errors };
    }
  }

  return { isValid: true, errors: [] };
}

export default VALIDATION;
