/**
 * Webhook Security
 *
 * Provides secure webhook signature verification for multiple providers:
 * - Meta (WhatsApp, Instagram, Facebook)
 * - Stripe
 * - GitHub
 * - Generic HMAC verification
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @module webhook-security
 */

import { logger } from "./logger.ts";

// =============================================================================
// Types
// =============================================================================

export type HashAlgorithm = "SHA-256" | "SHA-1" | "SHA-384" | "SHA-512";

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
}

export interface WebhookProviderConfig {
  /** Header name containing the signature */
  signatureHeader: string;
  /** Signature prefix (e.g., "sha256=") */
  signaturePrefix: string;
  /** Hash algorithm */
  algorithm: HashAlgorithm;
  /** Timestamp header (optional, for replay protection) */
  timestampHeader?: string;
  /** Maximum age in seconds for replay protection */
  maxAgeSeconds?: number;
}

// =============================================================================
// Provider Configurations
// =============================================================================

export const WebhookProviders = {
  /**
   * Meta Platform (WhatsApp, Instagram, Facebook)
   * Uses X-Hub-Signature-256 header with sha256= prefix
   */
  meta: {
    signatureHeader: "X-Hub-Signature-256",
    signaturePrefix: "sha256=",
    algorithm: "SHA-256",
  } as WebhookProviderConfig,

  /**
   * Stripe
   * Uses Stripe-Signature header with t=timestamp,v1=signature format
   */
  stripe: {
    signatureHeader: "Stripe-Signature",
    signaturePrefix: "v1=",
    algorithm: "SHA-256",
    timestampHeader: "t",
    maxAgeSeconds: 300, // 5 minutes
  } as WebhookProviderConfig,

  /**
   * GitHub
   * Uses X-Hub-Signature-256 header with sha256= prefix
   */
  github: {
    signatureHeader: "X-Hub-Signature-256",
    signaturePrefix: "sha256=",
    algorithm: "SHA-256",
  } as WebhookProviderConfig,

  /**
   * Generic SHA-256 HMAC
   * Uses X-Signature header with sha256= prefix
   */
  generic: {
    signatureHeader: "X-Signature",
    signaturePrefix: "sha256=",
    algorithm: "SHA-256",
  } as WebhookProviderConfig,

  /**
   * Twilio
   * Uses X-Twilio-Signature header with no prefix (base64 encoded)
   */
  twilio: {
    signatureHeader: "X-Twilio-Signature",
    signaturePrefix: "",
    algorithm: "SHA-1",
  } as WebhookProviderConfig,

  /**
   * Telegram
   * Uses X-Telegram-Bot-Api-Secret-Token header for webhook verification
   */
  telegram: {
    signatureHeader: "X-Telegram-Bot-Api-Secret-Token",
    signaturePrefix: "",
    algorithm: "SHA-256", // Not actually HMAC - simple token comparison
  } as WebhookProviderConfig,
} as const;

// =============================================================================
// Core HMAC Functions
// =============================================================================

/**
 * Compute HMAC signature
 */
export async function computeHmac(
  payload: string,
  secret: string,
  algorithm: HashAlgorithm = "SHA-256"
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  // Convert to hex
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute HMAC and return as base64 (for providers like Twilio)
 */
export async function computeHmacBase64(
  payload: string,
  secret: string,
  algorithm: HashAlgorithm = "SHA-256"
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  // Convert to base64
  return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// =============================================================================
// Provider-Specific Verification
// =============================================================================

/**
 * Verify Meta platform webhook signature (WhatsApp, Instagram, Facebook)
 *
 * @example
 * ```typescript
 * const isValid = await verifyMetaWebhook(rawBody, req.headers, appSecret);
 * if (!isValid) {
 *   return new Response("Invalid signature", { status: 401 });
 * }
 * ```
 */
export async function verifyMetaWebhook(
  payload: string,
  headers: Headers,
  secret: string
): Promise<WebhookVerificationResult> {
  const signature = headers.get(WebhookProviders.meta.signatureHeader);

  if (!signature) {
    return { valid: false, error: "Missing signature header" };
  }

  if (!signature.startsWith(WebhookProviders.meta.signaturePrefix)) {
    return { valid: false, error: "Invalid signature format" };
  }

  const providedHash = signature.slice(WebhookProviders.meta.signaturePrefix.length);
  const computedHash = await computeHmac(payload, secret, WebhookProviders.meta.algorithm);

  if (!constantTimeCompare(computedHash, providedHash)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Verify Stripe webhook signature with timestamp validation
 *
 * @example
 * ```typescript
 * const result = await verifyStripeWebhook(rawBody, req.headers, endpointSecret);
 * if (!result.valid) {
 *   return new Response(result.error, { status: 401 });
 * }
 * ```
 */
export async function verifyStripeWebhook(
  payload: string,
  headers: Headers,
  secret: string
): Promise<WebhookVerificationResult> {
  const signatureHeader = headers.get(WebhookProviders.stripe.signatureHeader);

  if (!signatureHeader) {
    return { valid: false, error: "Missing Stripe-Signature header" };
  }

  // Parse Stripe signature header: t=timestamp,v1=signature
  const parts = signatureHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signature = parts.find((p) => p.startsWith("v1="))?.slice(3);

  if (!timestamp || !signature) {
    return { valid: false, error: "Invalid Stripe-Signature format" };
  }

  // Check timestamp for replay protection
  const timestampSeconds = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  const maxAge = WebhookProviders.stripe.maxAgeSeconds || 300;

  if (Math.abs(now - timestampSeconds) > maxAge) {
    return { valid: false, error: "Webhook timestamp too old" };
  }

  // Compute expected signature
  // Stripe uses: timestamp + "." + payload
  const signedPayload = `${timestamp}.${payload}`;
  const computedHash = await computeHmac(signedPayload, secret, WebhookProviders.stripe.algorithm);

  if (!constantTimeCompare(computedHash, signature)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Verify GitHub webhook signature
 *
 * @example
 * ```typescript
 * const result = await verifyGitHubWebhook(rawBody, req.headers, webhookSecret);
 * if (!result.valid) {
 *   return new Response(result.error, { status: 401 });
 * }
 * ```
 */
export async function verifyGitHubWebhook(
  payload: string,
  headers: Headers,
  secret: string
): Promise<WebhookVerificationResult> {
  const signature = headers.get(WebhookProviders.github.signatureHeader);

  if (!signature) {
    return { valid: false, error: "Missing X-Hub-Signature-256 header" };
  }

  if (!signature.startsWith(WebhookProviders.github.signaturePrefix)) {
    return { valid: false, error: "Invalid signature format" };
  }

  const providedHash = signature.slice(WebhookProviders.github.signaturePrefix.length);
  const computedHash = await computeHmac(payload, secret, WebhookProviders.github.algorithm);

  if (!constantTimeCompare(computedHash, providedHash)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

/**
 * Verify Telegram webhook secret token
 * Telegram uses a simple token comparison (not HMAC)
 *
 * @example
 * ```typescript
 * const result = verifyTelegramWebhook(req.headers, webhookSecret);
 * if (!result.valid) {
 *   return new Response(result.error, { status: 401 });
 * }
 * ```
 */
export function verifyTelegramWebhook(
  headers: Headers,
  secret: string
): WebhookVerificationResult {
  const token = headers.get(WebhookProviders.telegram.signatureHeader);

  if (!token) {
    return { valid: false, error: "Missing X-Telegram-Bot-Api-Secret-Token header" };
  }

  if (!constantTimeCompare(token, secret)) {
    return { valid: false, error: "Secret token mismatch" };
  }

  return { valid: true };
}

// =============================================================================
// Generic HMAC Verification
// =============================================================================

/**
 * Verify HMAC signature with configurable options
 *
 * @example
 * ```typescript
 * const result = await verifyHmacSignature(payload, signature, secret, {
 *   algorithm: "SHA-256",
 *   prefix: "sha256=",
 * });
 * ```
 */
export async function verifyHmacSignature(
  payload: string,
  signature: string | null,
  secret: string,
  options?: {
    algorithm?: HashAlgorithm;
    prefix?: string;
    base64?: boolean;
  }
): Promise<WebhookVerificationResult> {
  if (!signature) {
    return { valid: false, error: "Missing signature" };
  }

  const algorithm = options?.algorithm || "SHA-256";
  const prefix = options?.prefix || "";
  const isBase64 = options?.base64 || false;

  // Remove prefix if present
  let providedHash = signature;
  if (prefix && signature.startsWith(prefix)) {
    providedHash = signature.slice(prefix.length);
  }

  // Compute expected hash
  const computedHash = isBase64
    ? await computeHmacBase64(payload, secret, algorithm)
    : await computeHmac(payload, secret, algorithm);

  if (!constantTimeCompare(computedHash, providedHash)) {
    return { valid: false, error: "Signature mismatch" };
  }

  return { valid: true };
}

// =============================================================================
// Webhook Verification Middleware Helper
// =============================================================================

/**
 * Create a webhook verification middleware for a specific provider
 *
 * @example
 * ```typescript
 * const verifyMeta = createWebhookVerifier("meta", () => Deno.env.get("WHATSAPP_APP_SECRET")!);
 *
 * Deno.serve(async (req) => {
 *   const rawBody = await req.text();
 *   const result = await verifyMeta(rawBody, req.headers);
 *   if (!result.valid) {
 *     return new Response("Unauthorized", { status: 401 });
 *   }
 *   // Process webhook...
 * });
 * ```
 */
export function createWebhookVerifier(
  provider: keyof typeof WebhookProviders,
  getSecret: () => string
): (payload: string, headers: Headers) => Promise<WebhookVerificationResult> {
  const config = WebhookProviders[provider];

  return async (payload: string, headers: Headers) => {
    const secret = getSecret();
    if (!secret) {
      logger.warn(`Webhook secret not configured for ${provider}`);
      // Fail open in development, fail closed in production
      const isDev = Deno.env.get("ENVIRONMENT") === "development";
      return isDev
        ? { valid: true }
        : { valid: false, error: "Webhook secret not configured" };
    }

    switch (provider) {
      case "meta":
        return verifyMetaWebhook(payload, headers, secret);
      case "stripe":
        return verifyStripeWebhook(payload, headers, secret);
      case "github":
        return verifyGitHubWebhook(payload, headers, secret);
      case "telegram":
        // Telegram uses simple token comparison, not HMAC
        return verifyTelegramWebhook(headers, secret);
      default:
        // Generic HMAC verification
        const signature = headers.get(config.signatureHeader);
        return verifyHmacSignature(payload, signature, secret, {
          algorithm: config.algorithm,
          prefix: config.signaturePrefix,
        });
    }
  };
}

// =============================================================================
// Webhook Challenge Response (Meta verification)
// =============================================================================

/**
 * Handle Meta webhook verification challenge (GET request)
 *
 * @example
 * ```typescript
 * if (req.method === "GET") {
 *   return handleMetaWebhookChallenge(req, verifyToken);
 * }
 * ```
 */
export function handleMetaWebhookChallenge(
  request: Request,
  verifyToken: string
): Response | null {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === verifyToken && challenge) {
    logger.info("Webhook verification challenge passed");
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  logger.warn("Webhook verification challenge failed", {
    mode,
    tokenMatch: token === verifyToken,
    hasChallenge: !!challenge,
  });

  return new Response("Verification failed", { status: 403 });
}
