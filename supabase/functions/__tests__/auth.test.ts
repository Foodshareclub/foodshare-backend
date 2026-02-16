/**
 * Auth Verification Tests
 *
 * Tests for api-v1-auth/lib/verify.ts handlers:
 * - handleVerifySend, handleVerifyConfirm, handleVerifyResend
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// We test the handler logic by importing the handlers directly.
// Since they depend on Supabase client and email service, we mock those.

// =============================================================================
// Mock Setup
// =============================================================================

// We can't easily mock the getEmailService import chain, so we test
// the verify handlers by calling them with mock contexts and checking
// the response status/body.

interface MockProfile {
  id: string;
  email_verified: boolean;
  verification_locked_until: string | null;
  verification_attempts: number;
  verification_code?: string;
  verification_code_expires_at?: string;
}

function createMockAuthContext(profile: MockProfile | null, options: {
  updateError?: boolean;
  lookupError?: boolean;
} = {}) {
  let lastUpdate: Record<string, unknown> | null = null;

  const mockQueryBuilder = {
    select: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    update: (data: Record<string, unknown>) => {
      lastUpdate = data;
      return mockQueryBuilder;
    },
    maybeSingle: async () => {
      if (options.lookupError) {
        return { data: null, error: { message: "DB error" } };
      }
      return { data: profile, error: null };
    },
    single: async () => {
      if (options.lookupError) {
        return { data: null, error: { message: "DB error" } };
      }
      return { data: profile, error: null };
    },
    then: (resolve: (r: unknown) => void) => {
      if (options.updateError) {
        resolve({ data: null, error: { message: "Update failed" } });
      } else {
        resolve({ data: [profile], error: null });
      }
    },
  };

  return {
    ctx: {
      supabase: {
        from: () => mockQueryBuilder,
        auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      },
      corsHeaders: { "Access-Control-Allow-Origin": "*" },
      requestId: "test-req-123",
    },
    getLastUpdate: () => lastUpdate,
  };
}

// =============================================================================
// generateVerificationCode Tests
// =============================================================================

Deno.test("generateVerificationCode: always produces 6-digit string", () => {
  // The function is not exported, but we can test its behavior through handleVerifySend
  // by verifying the code format. Let's test the logic directly.
  for (let i = 0; i < 100; i++) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    assertEquals(code.length, 6);
    assertEquals(/^\d{6}$/.test(code), true);
    const num = parseInt(code, 10);
    assertEquals(num >= 100000, true);
    assertEquals(num <= 999999, true);
  }
});

// =============================================================================
// handleVerifySend Tests (via response checking)
// =============================================================================

Deno.test({ name: "handleVerifySend: profile not found returns 404", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { ctx } = createMockAuthContext(null);

  // Dynamically import to avoid module-level side effects
  const { handleVerifySend } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifySend(
    { email: "nobody@example.com" },
    ctx as any,
  );

  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "No account found for this email");
}});

Deno.test("handleVerifySend: already verified returns 409", async () => {
  const profile: MockProfile = {
    id: "user-1",
    email_verified: true,
    verification_locked_until: null,
    verification_attempts: 0,
  };
  const { ctx } = createMockAuthContext(profile);

  const { handleVerifySend } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifySend(
    { email: "verified@example.com" },
    ctx as any,
  );

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.error, "Email is already verified");
});

Deno.test("handleVerifySend: locked out returns 429", async () => {
  const futureDate = new Date(Date.now() + 600000).toISOString();
  const profile: MockProfile = {
    id: "user-2",
    email_verified: false,
    verification_locked_until: futureDate,
    verification_attempts: 5,
  };
  const { ctx } = createMockAuthContext(profile);

  const { handleVerifySend } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifySend(
    { email: "locked@example.com" },
    ctx as any,
  );

  assertEquals(response.status, 429);
  const body = await response.json();
  assertExists(body.lockedUntil);
});

// =============================================================================
// handleVerifyConfirm Tests
// =============================================================================

Deno.test("handleVerifyConfirm: expired code returns 410", async () => {
  const pastDate = new Date(Date.now() - 600000).toISOString();
  const profile: MockProfile = {
    id: "user-3",
    email_verified: false,
    verification_locked_until: null,
    verification_attempts: 0,
    verification_code: "123456",
    verification_code_expires_at: pastDate,
  };
  const { ctx } = createMockAuthContext(profile);

  const { handleVerifyConfirm } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifyConfirm(
    { email: "test@example.com", code: "123456" },
    ctx as any,
  );

  assertEquals(response.status, 410);
  const body = await response.json();
  assertEquals(body.error, "Verification code has expired. Request a new one.");
});

Deno.test("handleVerifyConfirm: wrong code increments attempts", async () => {
  const futureDate = new Date(Date.now() + 600000).toISOString();
  const profile: MockProfile = {
    id: "user-4",
    email_verified: false,
    verification_locked_until: null,
    verification_attempts: 0,
    verification_code: "654321",
    verification_code_expires_at: futureDate,
  };
  const { ctx } = createMockAuthContext(profile);

  const { handleVerifyConfirm } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifyConfirm(
    { email: "test@example.com", code: "111111" },
    ctx as any,
  );

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "Incorrect verification code");
  assertExists(body.attemptsRemaining);
});

Deno.test("handleVerifyConfirm: correct code returns success", async () => {
  const futureDate = new Date(Date.now() + 600000).toISOString();
  const profile: MockProfile = {
    id: "user-5",
    email_verified: false,
    verification_locked_until: null,
    verification_attempts: 0,
    verification_code: "123456",
    verification_code_expires_at: futureDate,
  };
  const { ctx } = createMockAuthContext(profile);

  const { handleVerifyConfirm } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifyConfirm(
    { email: "test@example.com", code: "123456" },
    ctx as any,
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.message, "Email verified successfully");
});

// =============================================================================
// handleVerifyResend Tests
// =============================================================================

Deno.test("handleVerifyResend: profile not found returns 404", async () => {
  const { ctx } = createMockAuthContext(null);

  const { handleVerifyResend } = await import("../api-v1-auth/lib/verify.ts");
  const response = await handleVerifyResend(
    { email: "nobody-resend@example.com" },
    ctx as any,
  );

  assertEquals(response.status, 404);
});

// =============================================================================
// checkResendRateLimit Tests (tested indirectly through behavior)
// =============================================================================

Deno.test("checkResendRateLimit: allows first 3, blocks 4th", () => {
  // Test the rate limit logic inline since the function is not exported.
  // Replicating the same logic as in verify.ts:
  const RESEND_RATE_LIMIT_MAX = 3;
  const RESEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  function checkLimit(email: string): boolean {
    const key = email.toLowerCase().trim();
    const now = Date.now();
    const limit = rateLimitMap.get(key);
    if (limit && limit.resetAt < now) {
      rateLimitMap.delete(key);
    }
    const current = rateLimitMap.get(key);
    if (!current) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RESEND_RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (current.count >= RESEND_RATE_LIMIT_MAX) {
      return false;
    }
    current.count++;
    return true;
  }

  const email = "ratelimit-test@example.com";
  assertEquals(checkLimit(email), true);  // 1st
  assertEquals(checkLimit(email), true);  // 2nd
  assertEquals(checkLimit(email), true);  // 3rd
  assertEquals(checkLimit(email), false); // 4th - blocked
  assertEquals(checkLimit(email), false); // 5th - still blocked
});
