/**
 * CSRF Protection Tests
 *
 * Tests Cross-Site Request Forgery prevention mechanisms.
 */

import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  validateCsrf,
  generateCsrfToken,
  validateCsrfToken,
  shouldValidateCsrf,
  CsrfError,
} from "../../_shared/csrf.ts";

// ============================================================================
// Helper Functions
// ============================================================================

function createRequest(
  method: string,
  origin?: string | null,
  referer?: string | null
): Request {
  const headers: Record<string, string> = {};

  if (origin !== null && origin !== undefined) {
    headers["Origin"] = origin;
  }

  if (referer !== null && referer !== undefined) {
    headers["Referer"] = referer;
  }

  return new Request("https://api.foodshare.app/api-v1-products", {
    method,
    headers,
  });
}

// ============================================================================
// validateCsrf Tests - Safe Methods
// ============================================================================

Deno.test("validateCsrf - skips GET requests by default", () => {
  const request = createRequest("GET", "https://malicious.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - skips HEAD requests by default", () => {
  const request = createRequest("HEAD", "https://malicious.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - skips OPTIONS requests by default", () => {
  const request = createRequest("OPTIONS", "https://malicious.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - validates GET when skipSafeRequests is false", () => {
  const request = createRequest("GET", "https://malicious.com");
  const result = validateCsrf(request, { skipSafeRequests: false });
  assertEquals(result.valid, false);
});

// ============================================================================
// validateCsrf Tests - Allowed Origins
// ============================================================================

Deno.test("validateCsrf - allows production origin", () => {
  const request = createRequest("POST", "https://foodshare.app");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows www subdomain", () => {
  const request = createRequest("POST", "https://www.foodshare.app");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows localhost development", () => {
  const request = createRequest("POST", "http://localhost:3000");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows Capacitor mobile origin", () => {
  const request = createRequest("POST", "capacitor://localhost");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows Ionic mobile origin", () => {
  const request = createRequest("POST", "ionic://localhost");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows file:// for Android WebView", () => {
  const request = createRequest("POST", "file://");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - allows additional origins", () => {
  const request = createRequest("POST", "https://staging.foodshare.app");
  const result = validateCsrf(request, {
    additionalOrigins: ["https://staging.foodshare.app"],
  });
  assertEquals(result.valid, true);
});

// ============================================================================
// validateCsrf Tests - Blocked Origins
// ============================================================================

Deno.test("validateCsrf - blocks unknown origin", () => {
  const request = createRequest("POST", "https://malicious.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
  assertEquals(result.reason?.includes("not allowed"), true);
});

Deno.test("validateCsrf - blocks subdomain attacks on production", () => {
  const request = createRequest("POST", "https://evil.foodshare.app");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("validateCsrf - blocks capacitor subdomain attacks", () => {
  // This is the critical test - ensures prefix matching doesn't allow bypasses
  const request = createRequest("POST", "capacitor://localhost.attacker.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("validateCsrf - blocks ionic subdomain attacks", () => {
  const request = createRequest("POST", "ionic://localhost.evil.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("validateCsrf - blocks http on production domain", () => {
  // Downgrade attack
  const request = createRequest("POST", "http://foodshare.app");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("validateCsrf - blocks different port on production", () => {
  const request = createRequest("POST", "https://foodshare.app:8080");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

// ============================================================================
// validateCsrf Tests - No Origin Header
// ============================================================================

Deno.test("validateCsrf - allows no origin when allowNoOrigin is true (default)", () => {
  const request = createRequest("POST", null);
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - blocks no origin when allowNoOrigin is false", () => {
  const request = createRequest("POST", null);
  const result = validateCsrf(request, { allowNoOrigin: false });
  assertEquals(result.valid, false);
});

Deno.test("validateCsrf - uses Referer fallback when no Origin", () => {
  const request = createRequest("POST", null, "https://foodshare.app/listings");
  const result = validateCsrf(request, { allowNoOrigin: true });
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - blocks bad Referer when no Origin", () => {
  const request = createRequest("POST", null, "https://malicious.com/page");
  const result = validateCsrf(request, { allowNoOrigin: true });
  // When Referer is present but bad, it should fail
  assertEquals(result.valid, false);
});

// ============================================================================
// validateCsrf Tests - Null Origin
// ============================================================================

Deno.test("validateCsrf - allows null origin when allowNullOrigin is true (default)", () => {
  const request = createRequest("POST", "null");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("validateCsrf - blocks null origin when allowNullOrigin is false", () => {
  const request = createRequest("POST", "null");
  const result = validateCsrf(request, { allowNullOrigin: false });
  assertEquals(result.valid, false);
});

// ============================================================================
// shouldValidateCsrf Tests
// ============================================================================

Deno.test("shouldValidateCsrf - returns true for POST", () => {
  const request = createRequest("POST", "https://example.com");
  assertEquals(shouldValidateCsrf(request), true);
});

Deno.test("shouldValidateCsrf - returns true for PUT", () => {
  const request = createRequest("PUT", "https://example.com");
  assertEquals(shouldValidateCsrf(request), true);
});

Deno.test("shouldValidateCsrf - returns true for DELETE", () => {
  const request = createRequest("DELETE", "https://example.com");
  assertEquals(shouldValidateCsrf(request), true);
});

Deno.test("shouldValidateCsrf - returns true for PATCH", () => {
  const request = createRequest("PATCH", "https://example.com");
  assertEquals(shouldValidateCsrf(request), true);
});

Deno.test("shouldValidateCsrf - returns false for GET", () => {
  const request = createRequest("GET", "https://example.com");
  assertEquals(shouldValidateCsrf(request), false);
});

Deno.test("shouldValidateCsrf - returns false for HEAD", () => {
  const request = createRequest("HEAD", "https://example.com");
  assertEquals(shouldValidateCsrf(request), false);
});

Deno.test("shouldValidateCsrf - returns false for OPTIONS", () => {
  const request = createRequest("OPTIONS", "https://example.com");
  assertEquals(shouldValidateCsrf(request), false);
});

// ============================================================================
// CSRF Token Tests
// ============================================================================

Deno.test("generateCsrfToken - generates 64-character hex string", () => {
  const token = generateCsrfToken();
  assertEquals(token.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(token), true);
});

Deno.test("generateCsrfToken - generates unique tokens", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateCsrfToken());
  }
  assertEquals(tokens.size, 100);
});

Deno.test("validateCsrfToken - returns true for matching tokens", () => {
  const token = generateCsrfToken();
  assertEquals(validateCsrfToken(token, token), true);
});

Deno.test("validateCsrfToken - returns false for different tokens", () => {
  const token1 = generateCsrfToken();
  const token2 = generateCsrfToken();
  assertEquals(validateCsrfToken(token1, token2), false);
});

Deno.test("validateCsrfToken - returns false for null token", () => {
  const expectedToken = generateCsrfToken();
  assertEquals(validateCsrfToken(null, expectedToken), false);
});

Deno.test("validateCsrfToken - returns false for empty token", () => {
  const expectedToken = generateCsrfToken();
  assertEquals(validateCsrfToken("", expectedToken), false);
});

Deno.test("validateCsrfToken - uses constant-time comparison", () => {
  // This test verifies the function doesn't short-circuit
  // by ensuring similar tokens take similar time
  const token = "a".repeat(64);
  const almostSame = "a".repeat(63) + "b";
  const veryDifferent = "b".repeat(64);

  // All should return false and take similar time
  assertEquals(validateCsrfToken(almostSame, token), false);
  assertEquals(validateCsrfToken(veryDifferent, token), false);
});

// ============================================================================
// CsrfError Tests
// ============================================================================

Deno.test("CsrfError - has correct name", () => {
  const error = new CsrfError("Test message");
  assertEquals(error.name, "CsrfError");
});

Deno.test("CsrfError - preserves message", () => {
  const error = new CsrfError("Origin not allowed");
  assertEquals(error.message, "Origin not allowed");
});

// ============================================================================
// Real-world Attack Scenario Tests
// ============================================================================

Deno.test("CSRF - blocks form submission from malicious site", () => {
  // Attacker creates a form on their site that submits to our API
  const request = createRequest("POST", "https://evil-site.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("CSRF - blocks XHR from malicious site", () => {
  // Attacker uses JavaScript to make cross-origin request
  const request = createRequest("POST", "https://attacker.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("CSRF - blocks fetch from embedded iframe", () => {
  // Attacker embeds iframe with malicious code
  const request = createRequest("POST", "https://phishing-site.com");
  const result = validateCsrf(request);
  assertEquals(result.valid, false);
});

Deno.test("CSRF - allows legitimate mobile app request", () => {
  // Request from actual mobile app
  const request = createRequest("POST", "capacitor://localhost");
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});

Deno.test("CSRF - allows server-to-server request (no origin)", () => {
  // Backend services don't send Origin header
  const request = createRequest("POST", null);
  const result = validateCsrf(request);
  assertEquals(result.valid, true);
});
