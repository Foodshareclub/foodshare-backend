/**
 * CSRF Protection Middleware
 *
 * Provides protection against Cross-Site Request Forgery attacks by:
 * - Validating Origin and Referer headers
 * - Ensuring requests come from trusted sources
 * - Supporting both web and mobile app origins
 */

import { DEFAULT_ALLOWED_ORIGINS, MOBILE_ORIGINS } from "./cors.ts";

/**
 * CSRF validation result
 */
export interface CsrfValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Options for CSRF validation
 */
export interface CsrfOptions {
  /** Additional allowed origins beyond defaults */
  additionalOrigins?: string[];
  /** Whether to allow requests with no origin (mobile apps, server-to-server) */
  allowNoOrigin?: boolean;
  /** Whether to allow null origin */
  allowNullOrigin?: boolean;
  /** Whether to skip validation for GET/HEAD/OPTIONS */
  skipSafeRequests?: boolean;
}

const DEFAULT_OPTIONS: CsrfOptions = {
  additionalOrigins: [],
  allowNoOrigin: true, // Mobile apps often don't send Origin
  allowNullOrigin: true, // Some mobile WebViews send "null"
  skipSafeRequests: true,
};

/**
 * Safe HTTP methods that don't modify state
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Extract the origin from a URL string
 */
function extractOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * Check if an origin matches the allowed list
 * Uses exact matching for security (no prefix matching)
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  // Check for exact match
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check mobile origins with scheme-only patterns (file://)
  return MOBILE_ORIGINS.some((mobileOrigin) => {
    if (mobileOrigin.endsWith("//")) {
      return origin.startsWith(mobileOrigin);
    }
    return origin === mobileOrigin;
  });
}

/**
 * Validate CSRF protection for a request
 *
 * Checks that the request originates from a trusted source by examining
 * the Origin and Referer headers.
 */
export function validateCsrf(
  request: Request,
  options: CsrfOptions = {},
): CsrfValidationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const method = request.method.toUpperCase();

  // Skip validation for safe methods if configured
  if (opts.skipSafeRequests && SAFE_METHODS.has(method)) {
    return { valid: true };
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // Build allowed origins list
  const allowedOrigins = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...MOBILE_ORIGINS.filter((o) => !o.endsWith("//")), // Exclude scheme-only patterns
    ...(opts.additionalOrigins || []),
  ];

  // Handle no origin header
  if (!origin) {
    // Some mobile apps and server-to-server calls don't send Origin
    if (opts.allowNoOrigin) {
      // Fall back to Referer check if available
      if (referer) {
        const refererOrigin = extractOrigin(referer);
        if (refererOrigin && isOriginAllowed(refererOrigin, allowedOrigins)) {
          return { valid: true };
        }
        return { valid: false, reason: "Referer origin not allowed" };
      }
      return { valid: true };
    }
    return { valid: false, reason: "Missing Origin header" };
  }

  // Handle null origin
  if (origin === "null") {
    if (opts.allowNullOrigin) {
      return { valid: true };
    }
    return { valid: false, reason: "Null origin not allowed" };
  }

  // Validate origin against allowed list
  if (isOriginAllowed(origin, allowedOrigins)) {
    return { valid: true };
  }

  return { valid: false, reason: `Origin not allowed: ${origin}` };
}

/**
 * CSRF middleware for use with createAPIHandler
 *
 * Returns a function that validates CSRF and throws if invalid
 */
export function csrfMiddleware(
  options: CsrfOptions = {},
): (request: Request) => void {
  return (request: Request) => {
    const result = validateCsrf(request, options);
    if (!result.valid) {
      throw new CsrfError(result.reason || "CSRF validation failed");
    }
  };
}

/**
 * CSRF validation error
 */
export class CsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

/**
 * Check if we should validate CSRF for this request
 * Useful for conditional validation
 */
export function shouldValidateCsrf(request: Request): boolean {
  const method = request.method.toUpperCase();
  return !SAFE_METHODS.has(method);
}

/**
 * Generate CSRF token (for double-submit cookie pattern if needed)
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Validate CSRF token (for double-submit cookie pattern if needed)
 */
export function validateCsrfToken(
  token: string | null,
  expectedToken: string,
): boolean {
  if (!token || !expectedToken) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  if (token.length !== expectedToken.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }

  return result === 0;
}
