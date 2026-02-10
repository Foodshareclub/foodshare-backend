/**
 * Input Validation Security Tests
 *
 * Tests for numeric input safety, email validation, and boundary conditions.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  parseFloatSafe,
  parseFloatSafeWithBounds,
  parseIntSafe,
  parseIntSafeWithBounds,
  validateEmailEnhanced,
} from "../../_shared/validation-rules.ts";

// ============================================================================
// parseIntSafe Tests
// ============================================================================

Deno.test("parseIntSafe - parses valid integers", () => {
  assertEquals(parseIntSafe("42"), 42);
  assertEquals(parseIntSafe("0"), 0);
  assertEquals(parseIntSafe("-10"), -10);
  assertEquals(parseIntSafe("1000000"), 1000000);
});

Deno.test("parseIntSafe - handles number input", () => {
  assertEquals(parseIntSafe(42), 42);
  assertEquals(parseIntSafe(42.9), 42); // Truncates
  assertEquals(parseIntSafe(-10.5), -10);
});

Deno.test("parseIntSafe - returns default for invalid input", () => {
  assertEquals(parseIntSafe("not a number"), 0);
  assertEquals(parseIntSafe(""), 0);
  assertEquals(parseIntSafe("abc123"), 0);
  assertEquals(parseIntSafe("12.34.56"), 12); // Partial parse
});

Deno.test("parseIntSafe - returns default for null/undefined", () => {
  assertEquals(parseIntSafe(null), 0);
  assertEquals(parseIntSafe(undefined), 0);
});

Deno.test("parseIntSafe - uses custom default value", () => {
  assertEquals(parseIntSafe("invalid", 10), 10);
  assertEquals(parseIntSafe(null, -1), -1);
});

Deno.test("parseIntSafe - handles NaN number input", () => {
  assertEquals(parseIntSafe(NaN), 0);
  assertEquals(parseIntSafe(NaN, 5), 5);
});

Deno.test("parseIntSafe - handles edge cases", () => {
  assertEquals(parseIntSafe("  42  "), 42); // Whitespace trimmed by parseInt
  assertEquals(parseIntSafe("+42"), 42);
  assertEquals(parseIntSafe("0x10"), 0); // Hex not parsed with radix 10
});

// ============================================================================
// parseFloatSafe Tests
// ============================================================================

Deno.test("parseFloatSafe - parses valid floats", () => {
  assertEquals(parseFloatSafe("3.14"), 3.14);
  assertEquals(parseFloatSafe("0.001"), 0.001);
  assertEquals(parseFloatSafe("-10.5"), -10.5);
  assertEquals(parseFloatSafe("1e10"), 1e10);
});

Deno.test("parseFloatSafe - handles number input", () => {
  assertEquals(parseFloatSafe(3.14), 3.14);
  assertEquals(parseFloatSafe(-0.5), -0.5);
});

Deno.test("parseFloatSafe - returns default for invalid input", () => {
  assertEquals(parseFloatSafe("not a number"), 0);
  assertEquals(parseFloatSafe(""), 0);
  assertEquals(parseFloatSafe("abc"), 0);
});

Deno.test("parseFloatSafe - returns default for NaN", () => {
  assertEquals(parseFloatSafe(NaN), 0);
  assertEquals(parseFloatSafe("NaN"), 0);
});

Deno.test("parseFloatSafe - returns default for Infinity", () => {
  assertEquals(parseFloatSafe(Infinity), 0);
  assertEquals(parseFloatSafe(-Infinity), 0);
  assertEquals(parseFloatSafe("Infinity"), 0);
});

Deno.test("parseFloatSafe - handles null/undefined", () => {
  assertEquals(parseFloatSafe(null), 0);
  assertEquals(parseFloatSafe(undefined), 0);
  assertEquals(parseFloatSafe(null, 1.5), 1.5);
});

// ============================================================================
// parseIntSafeWithBounds Tests
// ============================================================================

Deno.test("parseIntSafeWithBounds - clamps to minimum", () => {
  assertEquals(parseIntSafeWithBounds("-100", 0, 100), 0);
  assertEquals(parseIntSafeWithBounds("0", 1, 100), 1);
});

Deno.test("parseIntSafeWithBounds - clamps to maximum", () => {
  assertEquals(parseIntSafeWithBounds("200", 0, 100), 100);
  assertEquals(parseIntSafeWithBounds("1000000", 0, 50), 50);
});

Deno.test("parseIntSafeWithBounds - allows values in range", () => {
  assertEquals(parseIntSafeWithBounds("50", 0, 100), 50);
  assertEquals(parseIntSafeWithBounds("0", 0, 100), 0);
  assertEquals(parseIntSafeWithBounds("100", 0, 100), 100);
});

Deno.test("parseIntSafeWithBounds - uses default for invalid input", () => {
  assertEquals(parseIntSafeWithBounds("invalid", 0, 100), 0); // Default is min
  assertEquals(parseIntSafeWithBounds("invalid", 0, 100, 50), 50);
});

Deno.test("parseIntSafeWithBounds - handles pagination limits", () => {
  // Common use case: limit parameter
  assertEquals(parseIntSafeWithBounds("0", 1, 100), 1);
  assertEquals(parseIntSafeWithBounds("500", 1, 100), 100);
  assertEquals(parseIntSafeWithBounds("20", 1, 100), 20);
});

// ============================================================================
// parseFloatSafeWithBounds Tests
// ============================================================================

Deno.test("parseFloatSafeWithBounds - clamps to minimum", () => {
  assertEquals(parseFloatSafeWithBounds("-10.5", 0, 100), 0);
  assertEquals(parseFloatSafeWithBounds("0.05", 0.1, 100), 0.1);
});

Deno.test("parseFloatSafeWithBounds - clamps to maximum", () => {
  assertEquals(parseFloatSafeWithBounds("150.5", 0, 100), 100);
});

Deno.test("parseFloatSafeWithBounds - allows values in range", () => {
  assertEquals(parseFloatSafeWithBounds("50.5", 0, 100), 50.5);
});

Deno.test("parseFloatSafeWithBounds - handles radius parameter", () => {
  // Common use case: search radius in km
  assertEquals(parseFloatSafeWithBounds("0", 0.1, 100, 10), 0.1);
  assertEquals(parseFloatSafeWithBounds("500", 0.1, 100, 10), 100);
  assertEquals(parseFloatSafeWithBounds("invalid", 0.1, 100, 10), 10);
});

Deno.test("parseFloatSafeWithBounds - handles latitude/longitude", () => {
  // Latitude: -90 to 90
  assertEquals(parseFloatSafeWithBounds("-100", -90, 90, 0), -90);
  assertEquals(parseFloatSafeWithBounds("100", -90, 90, 0), 90);
  assertEquals(parseFloatSafeWithBounds("51.5074", -90, 90, 0), 51.5074);

  // Longitude: -180 to 180
  assertEquals(parseFloatSafeWithBounds("-200", -180, 180, 0), -180);
  assertEquals(parseFloatSafeWithBounds("200", -180, 180, 0), 180);
});

// ============================================================================
// validateEmailEnhanced Tests
// ============================================================================

Deno.test("validateEmailEnhanced - accepts valid emails", () => {
  const validEmails = [
    "test@example.com",
    "user.name@domain.org",
    "user+tag@example.co.uk",
    "firstname.lastname@company.com",
    "email@subdomain.domain.com",
  ];

  for (const email of validEmails) {
    const result = validateEmailEnhanced(email);
    assertEquals(result.isValid, true, `Should accept: ${email}`);
  }
});

Deno.test("validateEmailEnhanced - rejects invalid formats", () => {
  const invalidEmails = [
    "notanemail",
    "@nodomain.com",
    "noat.com",
    "spaces in@email.com",
    "double@@at.com",
  ];

  for (const email of invalidEmails) {
    const result = validateEmailEnhanced(email);
    assertEquals(result.isValid, false, `Should reject: ${email}`);
  }
});

Deno.test("validateEmailEnhanced - rejects consecutive dots", () => {
  const result = validateEmailEnhanced("user..name@example.com");
  assertEquals(result.isValid, false);
  assertEquals(result.errors.some((e) => e.includes("consecutive")), true);
});

Deno.test("validateEmailEnhanced - rejects overly long domains", () => {
  const longDomain = "a".repeat(254) + ".com";
  const result = validateEmailEnhanced(`test@${longDomain}`);
  assertEquals(result.isValid, false);
});

Deno.test("validateEmailEnhanced - rejects numeric-only TLD", () => {
  const result = validateEmailEnhanced("test@example.123");
  assertEquals(result.isValid, false);
});

Deno.test("validateEmailEnhanced - rejects single-char TLD", () => {
  const result = validateEmailEnhanced("test@example.x");
  assertEquals(result.isValid, false);
});

Deno.test("validateEmailEnhanced - handles empty input", () => {
  const result = validateEmailEnhanced("");
  assertEquals(result.isValid, false);
  assertEquals(result.errors.length > 0, true);
});

Deno.test("validateEmailEnhanced - trims and lowercases", () => {
  const result = validateEmailEnhanced("  TEST@EXAMPLE.COM  ");
  assertEquals(result.isValid, true);
});

// ============================================================================
// Boundary Condition Tests
// ============================================================================

Deno.test("Boundary - maximum integer values", () => {
  assertEquals(parseIntSafe(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assertEquals(parseIntSafe(String(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
});

Deno.test("Boundary - floating point precision", () => {
  // Test that we don't introduce precision errors
  const result = parseFloatSafe("0.1");
  assertEquals(result, 0.1);

  const result2 = parseFloatSafe("0.3");
  assertEquals(result2, 0.3);
});

Deno.test("Boundary - very small floats", () => {
  assertEquals(parseFloatSafe("1e-10"), 1e-10);
  assertEquals(parseFloatSafe("0.0000001"), 0.0000001);
});

Deno.test("Boundary - scientific notation", () => {
  assertEquals(parseFloatSafe("1e5"), 100000);
  assertEquals(parseFloatSafe("1.5e-3"), 0.0015);
  assertEquals(parseIntSafe("1e5"), 100000);
});

// ============================================================================
// Attack Vector Tests
// ============================================================================

Deno.test("Attack - prototype pollution via __proto__", () => {
  // Parsing should not execute code or access prototypes
  assertEquals(parseIntSafe("__proto__"), 0);
  assertEquals(parseFloatSafe("constructor"), 0);
});

Deno.test("Attack - numeric overflow handling", () => {
  // Should not crash on huge numbers
  assertEquals(parseFloatSafe("1e309"), 0); // Infinity
  assertEquals(parseFloatSafe("-1e309"), 0); // -Infinity
});

Deno.test("Attack - special string injection", () => {
  assertEquals(parseIntSafe("42; DROP TABLE users;"), 42);
  assertEquals(parseFloatSafe("3.14; rm -rf /"), 3.14);
});

Deno.test("Attack - null byte injection", () => {
  assertEquals(parseIntSafe("42\x0099"), 42);
  assertEquals(parseFloatSafe("3.14\x00malicious"), 3.14);
});

Deno.test("Attack - unicode numeric lookalikes", () => {
  // Full-width digits (won't parse as integers)
  assertEquals(parseIntSafe("123"), 0); // Full-width 123
  assertEquals(parseIntSafe("42"), 42); // Regular ASCII
});

// ============================================================================
// Real-world Scenario Tests
// ============================================================================

Deno.test("Scenario - pagination parameters", () => {
  // Typical pagination: page number and limit
  const page = parseIntSafeWithBounds("0", 1, 1000, 1);
  const limit = parseIntSafeWithBounds("100000", 1, 50, 20);

  assertEquals(page, 1); // Clamped to minimum
  assertEquals(limit, 50); // Clamped to maximum
});

Deno.test("Scenario - geolocation search radius", () => {
  // User input for search radius in km
  const radius1 = parseFloatSafeWithBounds("invalid", 0.1, 100, 10);
  const radius2 = parseFloatSafeWithBounds("-5", 0.1, 100, 10);
  const radius3 = parseFloatSafeWithBounds("500", 0.1, 100, 10);

  assertEquals(radius1, 10); // Default
  assertEquals(radius2, 0.1); // Clamped to min
  assertEquals(radius3, 100); // Clamped to max
});

Deno.test("Scenario - price filtering", () => {
  // User input for price range
  const minPrice = parseFloatSafeWithBounds("-10", 0, 10000, 0);
  const maxPrice = parseFloatSafeWithBounds("NaN", 0, 10000, 10000);

  assertEquals(minPrice, 0);
  assertEquals(maxPrice, 10000);
});

Deno.test("Scenario - quantity validation", () => {
  // Product quantity must be positive integer
  const qty1 = parseIntSafeWithBounds("0", 1, 999, 1);
  const qty2 = parseIntSafeWithBounds("5.5", 1, 999, 1);
  const qty3 = parseIntSafeWithBounds("50", 1, 999, 1);

  assertEquals(qty1, 1); // Minimum 1
  assertEquals(qty2, 5); // Truncated to int, valid
  assertEquals(qty3, 50);
});

Deno.test("Scenario - category ID from URL", () => {
  // Category ID from URL query string
  const categoryId = parseIntSafe("abc", undefined);
  assertEquals(categoryId, 0); // Safe fallback

  const validCategoryId = parseIntSafe("42");
  assertEquals(validCategoryId, 42);
});
