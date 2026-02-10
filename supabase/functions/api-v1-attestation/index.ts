/**
 * Unified Attestation API v1
 *
 * Enterprise-grade device integrity verification consolidating ALL attestation operations:
 * - iOS App Attest: Initial device registration
 * - iOS Assertion: Subsequent request verification
 * - iOS DeviceCheck: Fallback for older devices
 * - Android Play Integrity: Primary Android verification
 * - Android SafetyNet: Deprecated fallback
 *
 * Routes:
 * - GET    /health           - Health check
 * - GET    /certificate-pins - Dynamic SSL certificate pins
 * - POST   /                 - Verify attestation (auto-detects platform)
 * - POST   /ios              - iOS attestation only
 * - POST   /android          - Android attestation only
 *
 * @module api-v1-attestation
 * @version 1.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { parseRoute } from "../_shared/routing.ts";
import { AppError, ValidationError } from "../_shared/errors.ts";

// Lib imports
import type { AttestationResponse } from "./lib/types.ts";
import { androidAttestationSchema, iosAttestationSchema } from "./lib/types.ts";
import { BUNDLE_ID, verifyAppAttest } from "./lib/app-attest.ts";
import { verifyAssertion } from "./lib/assertion.ts";
import { verifyDeviceCheck } from "./lib/device-check.ts";
import { ANDROID_PACKAGE_NAME, verifyPlayIntegrity, verifySafetyNet } from "./lib/android.ts";
import {
  calculateTrustLevel,
  generateDeviceId,
  getDeviceRecord,
  updateDeviceRecord,
} from "./lib/device-record.ts";
import { handleCertificatePins } from "./lib/cert-pinning.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-attestation";

// =============================================================================
// Route Handlers
// =============================================================================

async function handleIOSAttestation(
  body: z.infer<typeof iosAttestationSchema>,
  ctx: HandlerContext,
): Promise<Response> {
  const { supabase } = ctx;
  const bundleId = body.bundleId || BUNDLE_ID;

  if (body.type === "attestation") {
    if (!body.keyId || !body.attestation || !body.challenge) {
      throw new ValidationError(
        "Missing required App Attest fields: keyId, attestation, challenge",
      );
    }

    const result = await verifyAppAttest(body.keyId, body.attestation, body.challenge, bundleId);
    const trustLevel = calculateTrustLevel(result.verified, result.riskScore, 1);

    const deviceId = await updateDeviceRecord(
      supabase,
      body.keyId,
      result.verified,
      trustLevel,
      result.publicKey || null,
      0,
      result.riskScore,
      "ios",
    );

    return ok({
      verified: result.verified,
      trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      platform: "ios",
    } as AttestationResponse, ctx);
  }

  if (body.type === "assertion") {
    if (!body.keyId || !body.assertion || !body.clientDataHash) {
      throw new ValidationError(
        "Missing required assertion fields: keyId, assertion, clientDataHash",
      );
    }

    const deviceRecord = await getDeviceRecord(supabase, body.keyId);
    if (!deviceRecord) {
      return ok({
        verified: false,
        trustLevel: "unknown",
        message: "Device not registered. Please perform attestation first.",
        platform: "ios",
      } as AttestationResponse, ctx);
    }

    if (!deviceRecord.public_key) {
      return ok({
        verified: false,
        trustLevel: "unknown",
        message: "Device public key not available",
        platform: "ios",
      } as AttestationResponse, ctx);
    }

    const result = await verifyAssertion(
      body.keyId,
      body.assertion,
      body.clientDataHash,
      deviceRecord.assertion_counter,
      deviceRecord.public_key,
    );

    const trustLevel = calculateTrustLevel(
      result.verified,
      result.riskScore,
      deviceRecord.verification_count + 1,
    );

    const deviceId = await updateDeviceRecord(
      supabase,
      body.keyId,
      result.verified,
      trustLevel,
      null,
      result.newCounter,
      result.riskScore,
      "ios",
    );

    return ok({
      verified: result.verified,
      trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      platform: "ios",
    } as AttestationResponse, ctx);
  }

  if (body.type === "device_check") {
    if (!body.token) {
      throw new ValidationError("Missing DeviceCheck token");
    }

    const result = await verifyDeviceCheck(body.token);

    const encoder = new TextEncoder();
    const data = encoder.encode(body.token);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const keyId = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 32);

    const deviceId = await updateDeviceRecord(
      supabase,
      keyId,
      result.verified,
      result.trustLevel,
      null,
      0,
      result.riskScore,
      "ios",
    );

    return ok({
      verified: result.verified,
      trustLevel: result.trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      platform: "ios",
    } as AttestationResponse, ctx);
  }

  throw new ValidationError(`Unknown iOS attestation type: ${body.type}`);
}

async function handleAndroidAttestation(
  body: z.infer<typeof androidAttestationSchema>,
  ctx: HandlerContext,
): Promise<Response> {
  const { supabase } = ctx;
  const packageName = body.packageName || ANDROID_PACKAGE_NAME;

  if (body.type === "integrity") {
    const result = await verifyPlayIntegrity(body.integrityToken, body.nonce, packageName);

    const keyId = await generateDeviceId(body.integrityToken);
    const deviceId = await updateDeviceRecord(
      supabase,
      keyId,
      result.verified,
      result.trustLevel,
      null,
      0,
      result.riskScore,
      "android",
      result.verdicts,
    );

    return ok({
      verified: result.verified,
      trustLevel: result.trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      platform: "android",
      verdicts: result.verdicts,
    } as AttestationResponse, ctx);
  }

  if (body.type === "safetynet") {
    const result = await verifySafetyNet(body.integrityToken);

    const keyId = await generateDeviceId(body.integrityToken);
    const deviceId = await updateDeviceRecord(
      supabase,
      keyId,
      result.verified,
      result.trustLevel,
      null,
      0,
      result.riskScore,
      "android",
    );

    return ok({
      verified: result.verified,
      trustLevel: result.trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      platform: "android",
    } as AttestationResponse, ctx);
  }

  throw new ValidationError(`Unknown Android attestation type: ${body.type}`);
}

// =============================================================================
// GET / POST Route Handlers (for createAPIHandler)
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);

  // Health check
  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      platforms: ["ios", "android"],
      types: {
        ios: ["attestation", "assertion", "device_check"],
        android: ["integrity", "safetynet"],
      },
      routes: ["health", "certificate-pins", "ios", "android"],
    }, ctx);
  }

  // Certificate pins
  if (route.resource === "certificate-pins") {
    return handleCertificatePins(ctx.request, ctx.corsHeaders);
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);
  const body = ctx.body || {};

  // Route to platform-specific handler
  if (route.resource === "ios") {
    const parsed = iosAttestationSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join(", "));
    }
    return handleIOSAttestation(parsed.data, ctx);
  }

  if (route.resource === "android") {
    const parsed = androidAttestationSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join(", "));
    }
    return handleAndroidAttestation(parsed.data, ctx);
  }

  // Auto-detect platform from type
  if (route.resource === "") {
    const iosParsed = iosAttestationSchema.safeParse(body);
    if (iosParsed.success) {
      return handleIOSAttestation(iosParsed.data, ctx);
    }

    const androidParsed = androidAttestationSchema.safeParse(body);
    if (androidParsed.success) {
      return handleAndroidAttestation(androidParsed.data, ctx);
    }

    throw new ValidationError(
      "Invalid attestation request. Provide iOS type (attestation/assertion/device_check) or Android type (integrity/safetynet)",
    );
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

// =============================================================================
// API Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: SERVICE,
  version: VERSION,
  requireAuth: false,
  csrf: false,
  rateLimit: {
    limit: 30,
    windowMs: 60_000,
    keyBy: "ip",
  },
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
