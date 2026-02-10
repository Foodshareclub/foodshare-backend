/**
 * Validation utilities with enterprise-grade security
 */

import {
  EMAIL_REGEX,
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from "../config/constants.ts";

/**
 * Stricter email validation
 * - Must have local part before @
 * - Must have domain after @
 * - Domain must have at least one dot
 * - No consecutive dots
 */
export function validateEmail(email: string): boolean {
  // Basic regex check first
  if (!EMAIL_REGEX.test(email)) {
    return false;
  }

  // Additional stricter checks
  const [localPart, domain] = email.split("@");

  // Local part must exist and be non-empty
  if (!localPart || localPart.length === 0) {
    return false;
  }

  // Domain must exist, have a dot, and no consecutive dots
  if (!domain || !domain.includes(".") || domain.includes("..")) {
    return false;
  }

  // Domain parts must be valid
  const domainParts = domain.split(".");
  if (domainParts.some((part) => part.length === 0 || part.length > 63)) {
    return false;
  }

  // TLD must be at least 2 characters
  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2) {
    return false;
  }

  return true;
}

export function validateDescription(description: string): { valid: boolean; error?: string } {
  if (!description || description.trim().length === 0) {
    return { valid: false, error: "Description cannot be empty" };
  }

  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters`,
    };
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description must be less than ${MAX_DESCRIPTION_LENGTH} characters`,
    };
  }

  return { valid: true };
}

export function validateImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Check if it's a Supabase Storage URL
    const supabaseHost = (() => {
      try {
        return new URL(Deno.env.get("SUPABASE_URL") || "").hostname;
      } catch {
        return "api.foodshare.club";
      }
    })();
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname.includes(supabaseHost) || parsed.hostname === "cdn.foodshare.club") &&
      (parsed.pathname.includes("/storage/v1/object/public/") || parsed.pathname.startsWith("/"))
    );
  } catch {
    return false;
  }
}

export function validateVerificationCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * HTML entity encoding map for XSS prevention
 */
const HTML_ENTITIES: Record<string, string> = {
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
 * Escape HTML entities to prevent XSS
 * This is the safest approach - encode all potentially dangerous characters
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Sanitize text for safe display
 * Uses allowlist approach - strips all HTML and dangerous patterns
 */
export function sanitizeText(text: string): string {
  return (
    text
      // Remove all HTML tags (comprehensive pattern)
      .replace(/<[^>]*>/gi, "")
      // Remove javascript: protocol (case insensitive, with variations)
      .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, "")
      // Remove vbscript: protocol
      .replace(/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, "")
      // Remove data: protocol (can be used for XSS)
      .replace(/d\s*a\s*t\s*a\s*:/gi, "")
      // Remove event handlers (onclick, onerror, etc.)
      .replace(/on\w+\s*=/gi, "")
      // Remove expression() (IE CSS attack)
      .replace(/expression\s*\(/gi, "")
      // Remove url() in styles (can load external resources)
      .replace(/url\s*\(/gi, "")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Sanitize text while preserving allowed HTML tags (for Telegram formatting)
 * Only allows: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">
 */
export function sanitizeHtmlForTelegram(text: string): string {
  // First, escape everything
  let sanitized = escapeHtml(text);

  // Then, restore allowed Telegram HTML tags
  const allowedTags = [
    { encoded: "&lt;b&gt;", decoded: "<b>" },
    { encoded: "&lt;/b&gt;", decoded: "</b>" },
    { encoded: "&lt;i&gt;", decoded: "<i>" },
    { encoded: "&lt;/i&gt;", decoded: "</i>" },
    { encoded: "&lt;u&gt;", decoded: "<u>" },
    { encoded: "&lt;/u&gt;", decoded: "</u>" },
    { encoded: "&lt;s&gt;", decoded: "<s>" },
    { encoded: "&lt;/s&gt;", decoded: "</s>" },
    { encoded: "&lt;code&gt;", decoded: "<code>" },
    { encoded: "&lt;/code&gt;", decoded: "</code>" },
    { encoded: "&lt;pre&gt;", decoded: "<pre>" },
    { encoded: "&lt;/pre&gt;", decoded: "</pre>" },
  ];

  for (const tag of allowedTags) {
    sanitized = sanitized.replace(new RegExp(tag.encoded, "gi"), tag.decoded);
  }

  // Restore safe anchor tags (only https URLs)
  sanitized = sanitized.replace(/&lt;a href=&quot;(https:\/\/[^&]+)&quot;&gt;/gi, '<a href="$1">');
  sanitized = sanitized.replace(/&lt;\/a&gt;/gi, "</a>");

  return sanitized;
}
