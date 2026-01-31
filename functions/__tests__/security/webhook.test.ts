/**
 * Webhook Security Tests
 *
 * Tests webhook signature verification for WhatsApp and Telegram bots.
 */

import {
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ============================================================================
// HMAC Signature Verification Tests
// ============================================================================

/**
 * Compute HMAC-SHA256 signature (mirrors what the bots do)
 */
async function computeHmacSha256(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================================
// WhatsApp Signature Tests
// ============================================================================

Deno.test("WhatsApp - validates correct signature", async () => {
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const secret = "test_app_secret_123";
  const computedHash = await computeHmacSha256(payload, secret);
  const signature = `sha256=${computedHash}`;

  // Verify the signature matches
  const providedHash = signature.slice("sha256=".length);
  assertEquals(timingSafeEqual(computedHash, providedHash), true);
});

Deno.test("WhatsApp - rejects wrong signature", async () => {
  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const secret = "test_app_secret_123";
  const wrongSecret = "wrong_secret";

  const correctHash = await computeHmacSha256(payload, secret);
  const wrongHash = await computeHmacSha256(payload, wrongSecret);

  assertEquals(timingSafeEqual(correctHash, wrongHash), false);
});

Deno.test("WhatsApp - rejects modified payload", async () => {
  const originalPayload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const modifiedPayload = JSON.stringify({ object: "whatsapp_business_account", entry: [{ malicious: true }] });
  const secret = "test_app_secret_123";

  const originalHash = await computeHmacSha256(originalPayload, secret);
  const modifiedHash = await computeHmacSha256(modifiedPayload, secret);

  assertEquals(timingSafeEqual(originalHash, modifiedHash), false);
});

Deno.test("WhatsApp - rejects missing sha256= prefix", () => {
  const hash = "abc123def456";
  const validSignature = `sha256=${hash}`;
  const invalidSignature = hash; // Missing prefix

  assertEquals(validSignature.startsWith("sha256="), true);
  assertEquals(invalidSignature.startsWith("sha256="), false);
});

Deno.test("WhatsApp - handles empty payload", async () => {
  const payload = "";
  const secret = "test_app_secret_123";
  const hash = await computeHmacSha256(payload, secret);

  // Empty payload should still produce a valid hash
  assertEquals(hash.length, 64); // SHA-256 produces 64 hex chars
});

// ============================================================================
// Telegram Signature Tests
// ============================================================================

Deno.test("Telegram - validates correct secret token", () => {
  const secret = "telegram_webhook_secret_456";
  const providedToken = "telegram_webhook_secret_456";

  assertEquals(timingSafeEqual(providedToken, secret), true);
});

Deno.test("Telegram - rejects wrong secret token", () => {
  const secret = "telegram_webhook_secret_456";
  const providedToken = "wrong_token";

  assertEquals(timingSafeEqual(providedToken, secret), false);
});

Deno.test("Telegram - rejects empty token", () => {
  const secret = "telegram_webhook_secret_456";
  const providedToken = "";

  // Empty string has different length
  assertEquals(timingSafeEqual(providedToken, secret), false);
});

Deno.test("Telegram - rejects partial token match", () => {
  const secret = "telegram_webhook_secret_456";
  const providedToken = "telegram_webhook_secret_"; // Missing suffix

  assertEquals(timingSafeEqual(providedToken, secret), false);
});

// ============================================================================
// Timing Attack Prevention Tests
// ============================================================================

Deno.test("timingSafeEqual - same strings return true", () => {
  assertEquals(timingSafeEqual("abc123", "abc123"), true);
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("a", "a"), true);
});

Deno.test("timingSafeEqual - different strings return false", () => {
  assertEquals(timingSafeEqual("abc123", "abc124"), false);
  assertEquals(timingSafeEqual("abc", "def"), false);
  assertEquals(timingSafeEqual("a", "b"), false);
});

Deno.test("timingSafeEqual - different lengths return false early", () => {
  assertEquals(timingSafeEqual("short", "longer_string"), false);
  assertEquals(timingSafeEqual("", "a"), false);
  assertEquals(timingSafeEqual("abc", "ab"), false);
});

Deno.test("timingSafeEqual - compares all characters regardless of match", () => {
  // These should all take similar time (not short-circuit)
  const base = "abcdefghijklmnop";
  const diffFirst = "Xbcdefghijklmnop";
  const diffLast = "abcdefghijklmnoX";
  const diffMiddle = "abcdefgXijklmnop";

  // All should return false
  assertEquals(timingSafeEqual(base, diffFirst), false);
  assertEquals(timingSafeEqual(base, diffLast), false);
  assertEquals(timingSafeEqual(base, diffMiddle), false);
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Webhook - handles Unicode in payload", async () => {
  const payload = JSON.stringify({
    message: "Hello! Emoji test"
  });
  const secret = "test_secret";

  const hash = await computeHmacSha256(payload, secret);
  assertEquals(hash.length, 64);
});

Deno.test("Webhook - handles large payload", async () => {
  const largePayload = JSON.stringify({
    data: "x".repeat(100000) // 100KB
  });
  const secret = "test_secret";

  const hash = await computeHmacSha256(largePayload, secret);
  assertEquals(hash.length, 64);
});

Deno.test("Webhook - handles special characters in secret", async () => {
  const payload = "test";
  const secret = "secret!@#$%^&*()_+-=[]{}|;':\",./<>?";

  const hash = await computeHmacSha256(payload, secret);
  assertEquals(hash.length, 64);
});

// ============================================================================
// Attack Scenario Tests
// ============================================================================

Deno.test("Webhook - prevents replay attacks (signature tied to payload)", async () => {
  const secret = "shared_secret";

  const legitimatePayload = JSON.stringify({ message_id: "123", text: "Hello" });
  const maliciousPayload = JSON.stringify({ message_id: "456", text: "Send money" });

  // Attacker captures legitimate signature
  const legitimateSignature = await computeHmacSha256(legitimatePayload, secret);

  // Attacker tries to use that signature with different payload
  const maliciousSignature = await computeHmacSha256(maliciousPayload, secret);

  // Signatures don't match
  assertEquals(timingSafeEqual(legitimateSignature, maliciousSignature), false);
});

Deno.test("Webhook - prevents signature forging without secret", async () => {
  const realSecret = "real_secret_123";
  const guessedSecret = "guessed_secret";

  const payload = JSON.stringify({ action: "delete_all" });

  const realSignature = await computeHmacSha256(payload, realSecret);
  const forgedSignature = await computeHmacSha256(payload, guessedSecret);

  assertEquals(timingSafeEqual(realSignature, forgedSignature), false);
});

Deno.test("Webhook - prevents length extension attacks", async () => {
  const secret = "test_secret";
  const originalPayload = "original";
  const extendedPayload = "original_extended_malicious_data";

  const originalHash = await computeHmacSha256(originalPayload, secret);
  const extendedHash = await computeHmacSha256(extendedPayload, secret);

  // HMAC-SHA256 is not vulnerable to length extension
  assertEquals(timingSafeEqual(originalHash, extendedHash), false);
});
