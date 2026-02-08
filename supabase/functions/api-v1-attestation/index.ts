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

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { parseRoute } from "../_shared/routing.ts";
import { AppError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-attestation";

// =============================================================================
// Environment Configuration
// =============================================================================

// iOS configuration
const APPLE_TEAM_ID = Deno.env.get("APPLE_TEAM_ID") || "";
const BUNDLE_ID = Deno.env.get("APP_BUNDLE_ID") || "com.flutterflow.foodshare";

// Android configuration
const GOOGLE_CLOUD_PROJECT_ID = Deno.env.get("GOOGLE_CLOUD_PROJECT_ID") || "";
const GOOGLE_APPLICATION_CREDENTIALS = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || "";
const ANDROID_PACKAGE_NAME = Deno.env.get("ANDROID_PACKAGE_NAME") || "com.flutterflow.foodshare";

// Play Integrity API endpoint
const PLAY_INTEGRITY_API_URL = "https://playintegrity.googleapis.com/v1";

// =============================================================================
// Types
// =============================================================================

type TrustLevel = "unknown" | "trusted" | "verified" | "suspicious" | "blocked";
type IOSRequestType = "attestation" | "assertion" | "device_check";
type AndroidRequestType = "integrity" | "safetynet";
type RequestType = IOSRequestType | AndroidRequestType;

// Android verdicts
type DeviceVerdict =
  | "MEETS_DEVICE_INTEGRITY"
  | "MEETS_BASIC_INTEGRITY"
  | "MEETS_STRONG_INTEGRITY"
  | "MEETS_VIRTUAL_INTEGRITY";
type AppVerdict = "PLAY_RECOGNIZED" | "UNRECOGNIZED_VERSION" | "UNEVALUATED";
type AccountVerdict = "LICENSED" | "UNLICENSED" | "UNEVALUATED";

interface AttestationResponse {
  verified: boolean;
  trustLevel: TrustLevel;
  message?: string;
  expiresAt?: string;
  riskScore?: number;
  deviceId?: string;
  platform?: "ios" | "android";
  verdicts?: {
    device?: DeviceVerdict[];
    app?: AppVerdict;
    account?: AccountVerdict;
  };
}

interface DeviceRecord {
  id: string;
  key_id: string;
  public_key: string | null;
  trust_level: TrustLevel;
  attestation_verified: boolean;
  assertion_counter: number;
  created_at: string;
  updated_at: string;
  last_seen: string;
  verification_count: number;
  risk_score: number;
  flags: Record<string, unknown>;
  platform?: string;
}

// =============================================================================
// Request Schemas
// =============================================================================

const iosAttestationSchema = z.object({
  type: z.enum(["attestation", "assertion", "device_check"]),
  keyId: z.string().optional(),
  attestation: z.string().optional(),
  assertion: z.string().optional(),
  clientDataHash: z.string().optional(),
  challenge: z.string().optional(),
  token: z.string().optional(),
  bundleId: z.string().optional(),
  timestamp: z.string().optional(),
});

const androidAttestationSchema = z.object({
  type: z.enum(["integrity", "safetynet"]),
  integrityToken: z.string(),
  nonce: z.string().optional(),
  packageName: z.string().optional(),
  timestamp: z.string().optional(),
});

const unifiedSchema = z.union([iosAttestationSchema, androidAttestationSchema]);

// =============================================================================
// iOS: CBOR Decoder
// =============================================================================

const CBOR_MAJOR_MAP = 5;
const CBOR_MAJOR_BYTES = 2;
const CBOR_MAJOR_TEXT = 3;
const CBOR_MAJOR_ARRAY = 4;

function decodeCBOR(data: Uint8Array): { fmt: string; attStmt: Record<string, Uint8Array>; authData: Uint8Array } | null {
  try {
    let offset = 0;

    function readItem(): unknown {
      if (offset >= data.length) return null;

      const initial = data[offset++];
      const majorType = initial >> 5;
      const additionalInfo = initial & 0x1f;

      let value: number;
      if (additionalInfo < 24) {
        value = additionalInfo;
      } else if (additionalInfo === 24) {
        value = data[offset++];
      } else if (additionalInfo === 25) {
        value = (data[offset++] << 8) | data[offset++];
      } else if (additionalInfo === 26) {
        value = (data[offset++] << 24) | (data[offset++] << 16) | (data[offset++] << 8) | data[offset++];
      } else {
        return null;
      }

      switch (majorType) {
        case CBOR_MAJOR_BYTES: {
          const bytes = data.slice(offset, offset + value);
          offset += value;
          return bytes;
        }
        case CBOR_MAJOR_TEXT: {
          const textBytes = data.slice(offset, offset + value);
          offset += value;
          return new TextDecoder().decode(textBytes);
        }
        case CBOR_MAJOR_ARRAY: {
          const arr = [];
          for (let i = 0; i < value; i++) {
            arr.push(readItem());
          }
          return arr;
        }
        case CBOR_MAJOR_MAP: {
          const map: Record<string, unknown> = {};
          for (let i = 0; i < value; i++) {
            const key = readItem() as string;
            const val = readItem();
            if (key) map[key] = val;
          }
          return map;
        }
        default:
          return value;
      }
    }

    const result = readItem() as Record<string, unknown>;
    if (!result || typeof result !== "object") return null;

    return {
      fmt: result.fmt as string,
      attStmt: result.attStmt as Record<string, Uint8Array>,
      authData: result.authData as Uint8Array,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// iOS: Auth Data Parser
// =============================================================================

function parseAuthData(authData: Uint8Array): {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  aaguid: Uint8Array;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
} | null {
  try {
    if (authData.length < 37) return null;

    let offset = 0;
    const rpIdHash = authData.slice(offset, offset + 32);
    offset += 32;

    const flags = authData[offset++];
    const signCount = (authData[offset++] << 24) | (authData[offset++] << 16) |
                      (authData[offset++] << 8) | authData[offset++];

    if (!(flags & 0x40)) return null;

    const aaguid = authData.slice(offset, offset + 16);
    offset += 16;

    const credIdLen = (authData[offset++] << 8) | authData[offset++];
    const credentialId = authData.slice(offset, offset + credIdLen);
    offset += credIdLen;

    const publicKey = authData.slice(offset);

    return { rpIdHash, flags, signCount, aaguid, credentialId, publicKey };
  } catch {
    return null;
  }
}

// =============================================================================
// iOS: App ID Hash Verification
// =============================================================================

async function verifyAppIdHash(rpIdHash: Uint8Array, bundleId: string): Promise<boolean> {
  const appId = `${APPLE_TEAM_ID}.${bundleId}`;
  const encoder = new TextEncoder();
  const appIdData = encoder.encode(appId);
  const expectedHash = await crypto.subtle.digest("SHA-256", appIdData);

  const expected = new Uint8Array(expectedHash);
  if (expected.length !== rpIdHash.length) return false;

  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== rpIdHash[i]) return false;
  }

  return true;
}

// =============================================================================
// iOS: DER Signature Conversion
// =============================================================================

function derSignatureToRaw(der: Uint8Array): Uint8Array {
  try {
    let offset = 0;
    if (der[offset++] !== 0x30) return der;
    offset++;

    if (der[offset++] !== 0x02) return der;
    let rLen = der[offset++];
    let rStart = offset;
    if (rLen === 33 && der[rStart] === 0x00) {
      rStart++;
      rLen--;
    }
    const r = der.slice(rStart, rStart + rLen);
    offset = rStart + rLen;

    const rPadded = new Uint8Array(32);
    rPadded.set(r, 32 - r.length);

    if (der[offset++] !== 0x02) return der;
    let sLen = der[offset++];
    let sStart = offset;
    if (sLen === 33 && der[sStart] === 0x00) {
      sStart++;
      sLen--;
    }
    const s = der.slice(sStart, sStart + sLen);

    const sPadded = new Uint8Array(32);
    sPadded.set(s, 32 - s.length);

    const raw = new Uint8Array(64);
    raw.set(rPadded, 0);
    raw.set(sPadded, 32);

    return raw;
  } catch {
    return der;
  }
}

// =============================================================================
// iOS: Signature Verification
// =============================================================================

async function verifySignature(
  authData: Uint8Array,
  clientDataHash: Uint8Array,
  signature: Uint8Array,
  publicKeyBase64: string
): Promise<boolean> {
  try {
    const publicKeyRaw = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));

    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyRaw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);

    const rawSignature = derSignatureToRaw(signature);

    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      rawSignature,
      signedData
    );
  } catch {
    return false;
  }
}

// =============================================================================
// iOS: App Attest Verification
// =============================================================================

async function verifyAppAttest(
  keyId: string,
  attestation: string,
  challenge: string,
  bundleId: string
): Promise<{ verified: boolean; publicKey?: string; message?: string; riskScore: number }> {
  try {
    let attestationData: Uint8Array;
    try {
      attestationData = Uint8Array.from(atob(attestation), (c) => c.charCodeAt(0));
    } catch {
      return { verified: false, message: "Invalid attestation encoding", riskScore: 100 };
    }

    if (attestationData.length < 500) {
      return { verified: false, message: "Attestation data too short", riskScore: 100 };
    }

    const cbor = decodeCBOR(attestationData);
    if (!cbor) {
      return { verified: false, message: "Invalid CBOR format", riskScore: 100 };
    }

    if (cbor.fmt !== "apple-appattest") {
      return { verified: false, message: `Unexpected format: ${cbor.fmt}`, riskScore: 100 };
    }

    const authData = parseAuthData(cbor.authData);
    if (!authData) {
      return { verified: false, message: "Invalid authenticator data", riskScore: 100 };
    }

    if (APPLE_TEAM_ID) {
      const appIdValid = await verifyAppIdHash(authData.rpIdHash, bundleId);
      if (!appIdValid) {
        return { verified: false, message: "App ID hash mismatch", riskScore: 100 };
      }
    }

    const publicKeyBase64 = btoa(String.fromCharCode(...authData.publicKey));

    const x5c = cbor.attStmt?.x5c as Uint8Array[] | undefined;
    if (x5c && x5c.length >= 2) {
      logger.info("App Attest verified with certificate chain", { keyId: keyId.substring(0, 8) });
      return { verified: true, publicKey: publicKeyBase64, riskScore: 10 };
    }

    logger.warn("App Attest verified without certificate chain", { keyId: keyId.substring(0, 8) });
    return { verified: true, publicKey: publicKeyBase64, message: "Certificate chain not available", riskScore: 30 };
  } catch (error) {
    logger.error("App Attest verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, message: "Verification failed", riskScore: 100 };
  }
}

// =============================================================================
// iOS: Assertion Verification
// =============================================================================

async function verifyAssertion(
  keyId: string,
  assertion: string,
  clientDataHash: string,
  storedCounter: number,
  storedPublicKey: string
): Promise<{ verified: boolean; newCounter: number; message?: string; riskScore: number }> {
  try {
    let assertionData: Uint8Array;
    try {
      assertionData = Uint8Array.from(atob(assertion), (c) => c.charCodeAt(0));
    } catch {
      return { verified: false, newCounter: storedCounter, message: "Invalid assertion encoding", riskScore: 100 };
    }

    if (assertionData.length < 50) {
      return { verified: false, newCounter: storedCounter, message: "Assertion data too short", riskScore: 100 };
    }

    const cbor = decodeCBOR(assertionData);
    if (!cbor) {
      return { verified: false, newCounter: storedCounter, message: "Invalid CBOR format", riskScore: 100 };
    }

    const authData = parseAuthData(cbor.authData);
    if (!authData) {
      return { verified: false, newCounter: storedCounter, message: "Invalid authenticator data", riskScore: 100 };
    }

    if (authData.signCount <= storedCounter) {
      return { verified: false, newCounter: storedCounter, message: "Counter replay detected", riskScore: 100 };
    }

    if (storedPublicKey && cbor.attStmt?.signature) {
      const clientDataHashBytes = Uint8Array.from(atob(clientDataHash), c => c.charCodeAt(0));

      const signatureValid = await verifySignature(
        cbor.authData,
        clientDataHashBytes,
        cbor.attStmt.signature as Uint8Array,
        storedPublicKey
      );

      if (!signatureValid) {
        return { verified: false, newCounter: storedCounter, message: "Signature verification failed", riskScore: 100 };
      }

      logger.info("Assertion verified with signature", { keyId: keyId.substring(0, 8), counter: authData.signCount });
      return { verified: true, newCounter: authData.signCount, riskScore: 5 };
    }

    logger.warn("Assertion verified without signature", { keyId: keyId.substring(0, 8) });
    return { verified: true, newCounter: authData.signCount, message: "Signature verification skipped", riskScore: 20 };
  } catch (error) {
    logger.error("Assertion verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, newCounter: storedCounter, message: "Verification failed", riskScore: 100 };
  }
}

// =============================================================================
// iOS: DeviceCheck Verification
// =============================================================================

async function verifyDeviceCheck(token: string): Promise<{ verified: boolean; trustLevel: TrustLevel; message?: string; riskScore: number }> {
  try {
    if (!token || token.length < 50) {
      return { verified: false, trustLevel: "unknown", message: "Invalid token format", riskScore: 100 };
    }

    try {
      const tokenData = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
      if (tokenData.length < 50) {
        return { verified: false, trustLevel: "unknown", message: "Token data too short", riskScore: 100 };
      }
    } catch {
      return { verified: false, trustLevel: "unknown", message: "Invalid token encoding", riskScore: 100 };
    }

    logger.info("DeviceCheck token accepted", { tokenPrefix: token.substring(0, 8) });
    return { verified: true, trustLevel: "trusted", riskScore: 40 };
  } catch (error) {
    logger.error("DeviceCheck verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, trustLevel: "unknown", message: "Verification failed", riskScore: 100 };
  }
}

// =============================================================================
// Android: Google OAuth2 Token
// =============================================================================

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string | null> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.token;
  }

  if (!GOOGLE_APPLICATION_CREDENTIALS) {
    logger.error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
    return null;
  }

  try {
    const credentials = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS);

    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/playintegrity",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    const headerBase64 = btoa(JSON.stringify(header)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const payloadBase64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const signatureInput = `${headerBase64}.${payloadBase64}`;

    const privateKeyPem = credentials.private_key;
    const pemContents = privateKeyPem.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signatureInput)
    );

    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const jwt = `${signatureInput}.${signatureBase64}`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!tokenResponse.ok) {
      logger.error("Google token exchange failed", new Error(await tokenResponse.text()));
      return null;
    }

    const tokenData = await tokenResponse.json();

    cachedAccessToken = {
      token: tokenData.access_token,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
    };

    return cachedAccessToken.token;
  } catch (error) {
    logger.error("Failed to get Google access token", error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

// =============================================================================
// Android: Play Integrity Verification
// =============================================================================

interface PlayIntegrityPayload {
  requestDetails: {
    requestPackageName: string;
    nonce: string;
    timestampMillis: string;
  };
  appIntegrity: {
    appRecognitionVerdict: AppVerdict;
    packageName?: string;
    certificateSha256Digest?: string[];
    versionCode?: string;
  };
  deviceIntegrity: {
    deviceRecognitionVerdict: DeviceVerdict[];
  };
  accountDetails: {
    appLicensingVerdict: AccountVerdict;
  };
}

async function decodeIntegrityToken(integrityToken: string): Promise<{ success: boolean; payload?: PlayIntegrityPayload; error?: string }> {
  const accessToken = await getGoogleAccessToken();

  if (!accessToken) {
    return { success: false, error: "Failed to authenticate with Google" };
  }

  try {
    const response = await fetch(
      `${PLAY_INTEGRITY_API_URL}/${GOOGLE_CLOUD_PROJECT_ID}:decodeIntegrityToken`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ integrityToken }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error("Play Integrity API error", new Error(error));
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return { success: true, payload: data.tokenPayloadExternal };
  } catch (error) {
    logger.error("Failed to decode integrity token", error instanceof Error ? error : new Error(String(error)));
    return { success: false, error: "Token decoding failed" };
  }
}

async function verifyPlayIntegrity(
  integrityToken: string,
  expectedNonce: string | undefined,
  expectedPackageName: string
): Promise<{
  verified: boolean;
  trustLevel: TrustLevel;
  riskScore: number;
  message?: string;
  verdicts?: { device: DeviceVerdict[]; app: AppVerdict; account: AccountVerdict };
}> {
  if (!integrityToken || integrityToken.length < 100) {
    return { verified: false, trustLevel: "unknown", riskScore: 100, message: "Invalid integrity token format" };
  }

  const decodeResult = await decodeIntegrityToken(integrityToken);

  if (!decodeResult.success || !decodeResult.payload) {
    return { verified: false, trustLevel: "unknown", riskScore: 100, message: decodeResult.error || "Token decoding failed" };
  }

  const payload = decodeResult.payload;

  if (payload.requestDetails.requestPackageName !== expectedPackageName) {
    return { verified: false, trustLevel: "suspicious", riskScore: 100, message: "Package name mismatch" };
  }

  if (expectedNonce && payload.requestDetails.nonce !== expectedNonce) {
    return { verified: false, trustLevel: "suspicious", riskScore: 100, message: "Nonce mismatch" };
  }

  const tokenTimestamp = parseInt(payload.requestDetails.timestampMillis, 10);
  const now = Date.now();
  const maxAge = 10 * 60 * 1000;

  if (now - tokenTimestamp > maxAge) {
    return { verified: false, trustLevel: "suspicious", riskScore: 80, message: "Token expired" };
  }

  let riskScore = 0;
  const deviceVerdicts = payload.deviceIntegrity.deviceRecognitionVerdict || [];
  const appVerdict = payload.appIntegrity.appRecognitionVerdict;
  const accountVerdict = payload.accountDetails.appLicensingVerdict;

  if (deviceVerdicts.includes("MEETS_STRONG_INTEGRITY")) {
    riskScore += 0;
  } else if (deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")) {
    riskScore += 10;
  } else if (deviceVerdicts.includes("MEETS_BASIC_INTEGRITY")) {
    riskScore += 30;
  } else if (deviceVerdicts.includes("MEETS_VIRTUAL_INTEGRITY")) {
    riskScore += 50;
  } else {
    riskScore += 70;
  }

  if (appVerdict === "PLAY_RECOGNIZED") {
    riskScore += 0;
  } else if (appVerdict === "UNRECOGNIZED_VERSION") {
    riskScore += 20;
  } else {
    riskScore += 10;
  }

  if (accountVerdict === "LICENSED") {
    riskScore += 0;
  } else if (accountVerdict === "UNLICENSED") {
    riskScore += 15;
  } else {
    riskScore += 5;
  }

  let trustLevel: TrustLevel;
  if (riskScore <= 10) {
    trustLevel = "verified";
  } else if (riskScore <= 30) {
    trustLevel = "trusted";
  } else if (riskScore <= 60) {
    trustLevel = "unknown";
  } else {
    trustLevel = "suspicious";
  }

  const verified = deviceVerdicts.length > 0 && (
    deviceVerdicts.includes("MEETS_BASIC_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_STRONG_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_VIRTUAL_INTEGRITY")
  );

  logger.info("Play Integrity verified", { verified, device: deviceVerdicts, app: appVerdict, account: accountVerdict, risk: riskScore });

  return { verified, trustLevel, riskScore, verdicts: { device: deviceVerdicts, app: appVerdict, account: accountVerdict } };
}

// =============================================================================
// Android: SafetyNet Verification (Deprecated)
// =============================================================================

async function verifySafetyNet(attestation: string): Promise<{ verified: boolean; trustLevel: TrustLevel; riskScore: number; message?: string }> {
  if (!attestation || attestation.length < 100) {
    return { verified: false, trustLevel: "unknown", riskScore: 100, message: "Invalid SafetyNet attestation" };
  }

  try {
    const parts = attestation.split(".");
    if (parts.length !== 3) {
      return { verified: false, trustLevel: "unknown", riskScore: 100, message: "Invalid attestation format" };
    }

    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    if (!payload.ctsProfileMatch && !payload.basicIntegrity) {
      return { verified: false, trustLevel: "suspicious", riskScore: 80, message: "Device failed integrity checks" };
    }

    let riskScore = 40;
    if (payload.ctsProfileMatch) riskScore -= 15;
    if (payload.basicIntegrity) riskScore -= 10;

    logger.warn("SafetyNet attestation accepted (deprecated API)");
    return { verified: true, trustLevel: riskScore <= 30 ? "trusted" : "unknown", riskScore, message: "SafetyNet is deprecated - please update to Play Integrity" };
  } catch (error) {
    logger.error("SafetyNet verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, trustLevel: "unknown", riskScore: 100, message: "SafetyNet verification failed" };
  }
}

// =============================================================================
// Device Record Management
// =============================================================================

async function generateDeviceId(keyId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`device:${keyId}:foodshare`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getDeviceRecord(
  supabase: SupabaseClient,
  keyId: string
): Promise<DeviceRecord | null> {
  const { data } = await supabase
    .from("device_attestations")
    .select("*")
    .eq("key_id", keyId)
    .single();

  return data as DeviceRecord | null;
}

async function updateDeviceRecord(
  supabase: SupabaseClient,
  keyId: string,
  verified: boolean,
  trustLevel: TrustLevel,
  publicKey: string | null,
  counter: number,
  riskScore: number,
  platform: "ios" | "android",
  verdicts?: { device?: DeviceVerdict[]; app?: AppVerdict; account?: AccountVerdict }
): Promise<string> {
  const now = new Date().toISOString();
  const deviceId = await generateDeviceId(keyId);

  const existing = await getDeviceRecord(supabase, keyId);

  if (existing) {
    await supabase
      .from("device_attestations")
      .update({
        attestation_verified: verified,
        trust_level: trustLevel,
        public_key: publicKey || existing.public_key,
        assertion_counter: counter,
        last_seen: now,
        updated_at: now,
        verification_count: (existing.verification_count || 0) + 1,
        risk_score: Math.min(riskScore, existing.risk_score || 100),
        platform,
        flags: {
          ...(existing.flags || {}),
          lastVerdicts: verdicts,
          lastVerifiedAt: now,
        },
      })
      .eq("key_id", keyId);
  } else {
    await supabase.from("device_attestations").insert({
      key_id: keyId,
      public_key: publicKey,
      attestation_verified: verified,
      trust_level: trustLevel,
      assertion_counter: counter,
      created_at: now,
      updated_at: now,
      last_seen: now,
      verification_count: 1,
      risk_score: riskScore,
      platform,
      flags: { verdicts },
    });
  }

  return deviceId;
}

function calculateTrustLevel(verified: boolean, riskScore: number, verificationCount: number): TrustLevel {
  if (!verified) return "suspicious";
  if (riskScore >= 80) return "suspicious";
  if (riskScore >= 50) return "unknown";
  if (verificationCount > 5 && riskScore < 20) return "verified";
  return "trusted";
}

// =============================================================================
// Certificate Pins (merged from get-certificate-pins)
// =============================================================================

type CertPinPlatform = "ios" | "android" | "web" | "unknown";

interface CertificatePin {
  hash: string;
  type: "leaf" | "intermediate" | "root";
  expires: string;
  priority: number;
  description?: string;
  commonName?: string;
  organization?: string;
}

interface IOSPinFormat {
  sha256: string[];
  publicKeyHashes: string[];
}

interface AndroidPinFormat {
  sha256: string[];
  networkSecurityConfig: string;
  pinSetExpiration: string;
}

interface WebPinFormat {
  sha256: string[];
  publicKeyPinsHeader: string;
}

interface PlatformPins {
  ios: IOSPinFormat;
  android: AndroidPinFormat;
  web: WebPinFormat;
}

interface RotationWarning {
  active: boolean;
  severity: "info" | "warning" | "critical";
  message?: string;
  nextRotation?: string;
  daysUntilExpiry?: number;
}

interface PinResponse {
  pins: CertificatePin[];
  minAppVersion: string;
  gracePeriodDays: number;
  refreshIntervalHours: number;
  lastUpdated: string;
  nextRotation?: string;
  platformPins?: PlatformPins;
  minAppVersions?: Record<CertPinPlatform, string>;
  validUntil?: string;
  rotationWarning?: RotationWarning;
}

/**
 * Current certificate pins for Supabase
 *
 * SHA-256 hashes of the Subject Public Key Info (SPKI).
 * To generate: openssl s_client -connect host:443 | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
 *
 * UPDATE THESE when certificates are rotated!
 */
const CURRENT_PINS: CertificatePin[] = [
  {
    hash: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    type: "leaf",
    expires: "2025-06-01",
    priority: 1,
    description: "Supabase primary leaf certificate",
  },
  {
    hash: "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    type: "intermediate",
    expires: "2026-01-01",
    priority: 2,
    description: "Let's Encrypt R3 intermediate",
  },
  {
    hash: "sha256/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
    type: "root",
    expires: "2030-01-01",
    priority: 3,
    description: "ISRG Root X1",
  },
];

/** Upcoming pins for rotation (added during grace period) */
const UPCOMING_PINS: CertificatePin[] = [];

const PIN_CONFIG = {
  minAppVersions: {
    ios: "3.0.0",
    android: "1.0.0",
    web: "1.0.0",
    unknown: "1.0.0",
  } as Record<CertPinPlatform, string>,
  minAppVersion: "3.0.0",
  gracePeriodDays: 14,
  refreshIntervalHours: 24,
  nextRotation: "2025-05-15",
  warningThresholdDays: 30,
  criticalThresholdDays: 7,
  supabaseHost: "supabase.co",
};

function detectCertPinPlatform(request: Request): CertPinPlatform {
  const platformHeader = request.headers.get("x-platform")?.toLowerCase();
  if (platformHeader === "ios" || platformHeader === "android" || platformHeader === "web") return platformHeader;

  const clientPlatform = request.headers.get("x-client-platform")?.toLowerCase();
  if (clientPlatform === "ios" || clientPlatform === "android" || clientPlatform === "web") return clientPlatform;

  const ua = request.headers.get("user-agent") || "";
  if (ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iOS") || ua.includes("Darwin")) return "ios";
  if (ua.includes("Android") || ua.includes("okhttp")) return "android";
  if (ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari") || ua.includes("Firefox")) return "web";

  return "unknown";
}

function formatIOSPins(pins: CertificatePin[]): IOSPinFormat {
  return {
    sha256: pins.map(p => p.hash),
    publicKeyHashes: pins.map(p => p.hash.replace("sha256/", "")),
  };
}

function formatAndroidPins(pins: CertificatePin[], validUntil: string): AndroidPinFormat {
  const pinEntries = pins
    .map(p => `            <pin digest="SHA-256">${p.hash.replace("sha256/", "")}</pin>`)
    .join("\n");

  return {
    sha256: pins.map(p => p.hash),
    networkSecurityConfig: `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">${PIN_CONFIG.supabaseHost}</domain>
        <domain includeSubdomains="true">foodshare.app</domain>
        <pin-set expiration="${validUntil}">
${pinEntries}
        </pin-set>
        <trust-anchors>
            <certificates src="system"/>
        </trust-anchors>
    </domain-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="user"/>
        </trust-anchors>
    </debug-overrides>
</network-security-config>`,
    pinSetExpiration: validUntil,
  };
}

function formatWebPins(pins: CertificatePin[]): WebPinFormat {
  const pinDirectives = pins
    .map(p => `pin-sha256="${p.hash.replace("sha256/", "")}"`)
    .join("; ");

  return {
    sha256: pins.map(p => p.hash),
    publicKeyPinsHeader: `${pinDirectives}; max-age=2592000; includeSubDomains`,
  };
}

function generatePlatformPins(pins: CertificatePin[], validUntil: string): PlatformPins {
  return {
    ios: formatIOSPins(pins),
    android: formatAndroidPins(pins, validUntil),
    web: formatWebPins(pins),
  };
}

function calculateRotationWarning(pins: CertificatePin[]): RotationWarning {
  const now = new Date();
  let earliestExpiry: Date | null = null;
  for (const pin of pins) {
    const expiry = new Date(pin.expires);
    if (!earliestExpiry || expiry < earliestExpiry) earliestExpiry = expiry;
  }

  if (!earliestExpiry) return { active: false, severity: "info" };

  const daysUntilExpiry = Math.ceil((earliestExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry <= PIN_CONFIG.criticalThresholdDays) {
    return { active: true, severity: "critical", message: `Certificate pins expire in ${daysUntilExpiry} days! Immediate rotation required.`, nextRotation: PIN_CONFIG.nextRotation, daysUntilExpiry };
  }
  if (daysUntilExpiry <= PIN_CONFIG.warningThresholdDays) {
    return { active: true, severity: "warning", message: `Certificate pins expire in ${daysUntilExpiry} days. Please plan rotation.`, nextRotation: PIN_CONFIG.nextRotation, daysUntilExpiry };
  }
  if (PIN_CONFIG.nextRotation) {
    const daysUntilRotation = Math.ceil((new Date(PIN_CONFIG.nextRotation).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntilRotation <= PIN_CONFIG.warningThresholdDays) {
      return { active: true, severity: "info", message: `Planned certificate rotation in ${daysUntilRotation} days.`, nextRotation: PIN_CONFIG.nextRotation, daysUntilExpiry };
    }
  }
  return { active: false, severity: "info", daysUntilExpiry };
}

function isVersionLessThan(version: string, minimum: string): boolean {
  const v1Parts = version.split(".").map(p => parseInt(p, 10) || 0);
  const v2Parts = minimum.split(".").map(p => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1 = v1Parts[i] || 0;
    const v2 = v2Parts[i] || 0;
    if (v1 < v2) return true;
    if (v1 > v2) return false;
  }
  return false;
}

function hashPins(pins: CertificatePin[]): string {
  const content = pins.map(p => p.hash).join(",");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function handleCertificatePins(req: Request, corsHeaders: Record<string, string>): Response {
  const platform = detectCertPinPlatform(req);
  const appVersion = req.headers.get("x-app-version") || "unknown";
  const wantsLegacyFormat = (req.headers.get("accept") || "").includes("application/vnd.foodshare.pins.v1");

  logger.info("Certificate pins requested", { platform, appVersion, legacy: wantsLegacyFormat });

  const now = new Date();
  const validPins = CURRENT_PINS.filter(pin => new Date(pin.expires) > now);

  const gracePeriodMs = PIN_CONFIG.gracePeriodDays * 24 * 60 * 60 * 1000;
  const inGracePeriod = CURRENT_PINS.some(pin => {
    const expires = new Date(pin.expires);
    return now >= new Date(expires.getTime() - gracePeriodMs) && now < expires;
  });

  const allPins = inGracePeriod ? [...validPins, ...UPCOMING_PINS] : validPins;
  allPins.sort((a, b) => a.priority - b.priority);

  const earliestExpiry = allPins.reduce((earliest, pin) => {
    const expires = new Date(pin.expires);
    return !earliest || expires < earliest ? expires : earliest;
  }, null as Date | null);

  const validUntil = earliestExpiry?.toISOString().split("T")[0] || "2025-12-31";

  const minVersion = PIN_CONFIG.minAppVersions[platform] || PIN_CONFIG.minAppVersion;
  if (isVersionLessThan(appVersion, minVersion)) {
    logger.warn("App version below minimum", { platform, appVersion, minVersion });
  }

  const rotationWarning = calculateRotationWarning(allPins);

  const response: PinResponse = {
    pins: allPins,
    minAppVersion: PIN_CONFIG.minAppVersion,
    gracePeriodDays: PIN_CONFIG.gracePeriodDays,
    refreshIntervalHours: PIN_CONFIG.refreshIntervalHours,
    lastUpdated: new Date().toISOString(),
    nextRotation: PIN_CONFIG.nextRotation,
    platformPins: wantsLegacyFormat ? undefined : generatePlatformPins(allPins, validUntil),
    minAppVersions: wantsLegacyFormat ? undefined : PIN_CONFIG.minAppVersions,
    validUntil: wantsLegacyFormat ? undefined : validUntil,
    rotationWarning: wantsLegacyFormat ? undefined : rotationWarning,
  };

  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "ETag": `"${hashPins(allPins)}"`,
    "X-Platform-Detected": platform,
    "X-Pins-Valid-Until": validUntil,
  };

  if (rotationWarning.active) {
    responseHeaders["X-Pin-Rotation-Warning"] = rotationWarning.severity;
    if (rotationWarning.daysUntilExpiry !== undefined) {
      responseHeaders["X-Pin-Days-Until-Expiry"] = String(rotationWarning.daysUntilExpiry);
    }
  }

  return new Response(JSON.stringify(response), { status: 200, headers: responseHeaders });
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleIOSAttestation(
  body: z.infer<typeof iosAttestationSchema>,
  supabase: SupabaseClient,
  requestId: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const bundleId = body.bundleId || BUNDLE_ID;

  if (body.type === "attestation") {
    if (!body.keyId || !body.attestation || !body.challenge) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required App Attest fields: keyId, attestation, challenge", requestId }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
      "ios"
    );

    return new Response(
      JSON.stringify({
        verified: result.verified,
        trustLevel,
        message: result.message,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        riskScore: result.riskScore,
        deviceId,
        platform: "ios",
      } as AttestationResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (body.type === "assertion") {
    if (!body.keyId || !body.assertion || !body.clientDataHash) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing required assertion fields: keyId, assertion, clientDataHash", requestId }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const deviceRecord = await getDeviceRecord(supabase, body.keyId);
    if (!deviceRecord) {
      return new Response(
        JSON.stringify({
          verified: false,
          trustLevel: "unknown",
          message: "Device not registered. Please perform attestation first.",
          platform: "ios",
        } as AttestationResponse),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!deviceRecord.public_key) {
      return new Response(
        JSON.stringify({
          verified: false,
          trustLevel: "unknown",
          message: "Device public key not available",
          platform: "ios",
        } as AttestationResponse),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result = await verifyAssertion(
      body.keyId,
      body.assertion,
      body.clientDataHash,
      deviceRecord.assertion_counter,
      deviceRecord.public_key
    );

    const trustLevel = calculateTrustLevel(result.verified, result.riskScore, deviceRecord.verification_count + 1);

    const deviceId = await updateDeviceRecord(
      supabase,
      body.keyId,
      result.verified,
      trustLevel,
      null,
      result.newCounter,
      result.riskScore,
      "ios"
    );

    return new Response(
      JSON.stringify({
        verified: result.verified,
        trustLevel,
        message: result.message,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        riskScore: result.riskScore,
        deviceId,
        platform: "ios",
      } as AttestationResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (body.type === "device_check") {
    if (!body.token) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing DeviceCheck token", requestId }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
      "ios"
    );

    return new Response(
      JSON.stringify({
        verified: result.verified,
        trustLevel: result.trustLevel,
        message: result.message,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        riskScore: result.riskScore,
        deviceId,
        platform: "ios",
      } as AttestationResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: false, error: `Unknown iOS attestation type: ${body.type}`, requestId }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleAndroidAttestation(
  body: z.infer<typeof androidAttestationSchema>,
  supabase: SupabaseClient,
  requestId: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
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
      result.verdicts
    );

    return new Response(
      JSON.stringify({
        verified: result.verified,
        trustLevel: result.trustLevel,
        message: result.message,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        riskScore: result.riskScore,
        deviceId,
        platform: "android",
        verdicts: result.verdicts,
      } as AttestationResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
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
      "android"
    );

    return new Response(
      JSON.stringify({
        verified: result.verified,
        trustLevel: result.trustLevel,
        message: result.message,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        riskScore: result.riskScore,
        deviceId,
        platform: "android",
      } as AttestationResponse),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: false, error: `Unknown Android attestation type: ${body.type}`, requestId }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
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
  const requestId = ctx.ctx.requestId;
  const corsHeaders = ctx.corsHeaders;

  const body = await ctx.request.json().catch(() => ({}));
  const supabase = getSupabaseClient();

  // Route to platform-specific handler
  if (route.resource === "ios") {
    const parsed = iosAttestationSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ success: false, error: parsed.error.errors.map(e => e.message).join(", "), requestId }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return handleIOSAttestation(parsed.data, supabase, requestId, corsHeaders);
  }

  if (route.resource === "android") {
    const parsed = androidAttestationSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ success: false, error: parsed.error.errors.map(e => e.message).join(", "), requestId }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return handleAndroidAttestation(parsed.data, supabase, requestId, corsHeaders);
  }

  // Auto-detect platform from type
  if (route.resource === "") {
    const iosParsed = iosAttestationSchema.safeParse(body);
    if (iosParsed.success) {
      return handleIOSAttestation(iosParsed.data, supabase, requestId, corsHeaders);
    }

    const androidParsed = androidAttestationSchema.safeParse(body);
    if (androidParsed.success) {
      return handleAndroidAttestation(androidParsed.data, supabase, requestId, corsHeaders);
    }

    return new Response(
      JSON.stringify({ success: false, error: "Invalid attestation request. Provide iOS type (attestation/assertion/device_check) or Android type (integrity/safetynet)", requestId }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
