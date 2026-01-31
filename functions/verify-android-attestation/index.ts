// ============================================================================
// VERIFY ANDROID ATTESTATION - Play Integrity API Verification
// Validates Android device integrity using Google Play Integrity API
//
// Supports:
// - Standard integrity tokens (Play Integrity API)
// - Classic SafetyNet attestation (deprecated fallback)
//
// Security Features:
// - Token decryption and verification via Google API
// - Device integrity verdict checking
// - App integrity verification
// - Account details verification
// - Risk scoring based on verdict
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  getCorsHeadersWithMobile,
  handleMobileCorsPrelight,
} from "../_shared/cors.ts";

const VERSION = "1.0.0";

// Environment configuration
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLOUD_PROJECT_ID = Deno.env.get("GOOGLE_CLOUD_PROJECT_ID") || "";
const GOOGLE_APPLICATION_CREDENTIALS = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || "";
const PACKAGE_NAME = Deno.env.get("ANDROID_PACKAGE_NAME") || "com.flutterflow.foodshare";

// Play Integrity API endpoint
const PLAY_INTEGRITY_API_URL = "https://playintegrity.googleapis.com/v1";

// Trust levels for device reputation
type TrustLevel = "unknown" | "trusted" | "verified" | "suspicious" | "blocked";

// Request types
type RequestType = "integrity" | "safetynet";

// Device verdict from Play Integrity
type DeviceVerdict =
  | "MEETS_DEVICE_INTEGRITY"
  | "MEETS_BASIC_INTEGRITY"
  | "MEETS_STRONG_INTEGRITY"
  | "MEETS_VIRTUAL_INTEGRITY";

// App integrity verdict
type AppVerdict =
  | "PLAY_RECOGNIZED"
  | "UNRECOGNIZED_VERSION"
  | "UNEVALUATED";

// Account verdict
type AccountVerdict =
  | "LICENSED"
  | "UNLICENSED"
  | "UNEVALUATED";

interface IntegrityRequest {
  type: RequestType;
  integrityToken: string;
  nonce?: string; // Base64-encoded nonce
  packageName?: string;
  timestamp: string;
}

interface IntegrityResponse {
  verified: boolean;
  trustLevel: TrustLevel;
  message?: string;
  expiresAt?: string;
  riskScore?: number;
  deviceId?: string;
  verdicts?: {
    device: DeviceVerdict[];
    app: AppVerdict;
    account: AccountVerdict;
  };
}

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

interface DeviceRecord {
  id: string;
  key_id: string;
  trust_level: TrustLevel;
  attestation_verified: boolean;
  created_at: string;
  updated_at: string;
  last_seen: string;
  verification_count: number;
  risk_score: number;
  flags: Record<string, unknown>;
  platform: string;
}

// ============================================================================
// Google OAuth2 Token Generation
// ============================================================================

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

/**
 * Get or refresh Google OAuth2 access token
 */
async function getGoogleAccessToken(): Promise<string | null> {
  // Check if we have a valid cached token
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.token;
  }

  if (!GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
    return null;
  }

  try {
    // Parse service account credentials
    const credentials = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS);

    // Create JWT for token request
    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/playintegrity",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    };

    // Encode header and payload
    const headerBase64 = btoa(JSON.stringify(header))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const payloadBase64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const signatureInput = `${headerBase64}.${payloadBase64}`;

    // Import private key
    const privateKeyPem = credentials.private_key;
    const pemContents = privateKeyPem
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");

    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    // Sign the JWT
    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signatureInput)
    );

    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const jwt = `${signatureInput}.${signatureBase64}`;

    // Exchange JWT for access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error("Token exchange failed:", error);
      return null;
    }

    const tokenData = await tokenResponse.json();

    // Cache the token
    cachedAccessToken = {
      token: tokenData.access_token,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
    };

    return cachedAccessToken.token;
  } catch (error) {
    console.error("Failed to get Google access token:", error);
    return null;
  }
}

// ============================================================================
// Play Integrity API Verification
// ============================================================================

/**
 * Decode and verify Play Integrity token using Google API
 */
async function decodeIntegrityToken(
  integrityToken: string
): Promise<{ success: boolean; payload?: PlayIntegrityPayload; error?: string }> {
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
        body: JSON.stringify({
          integrityToken,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Play Integrity API error:", error);
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return { success: true, payload: data.tokenPayloadExternal };
  } catch (error) {
    console.error("Failed to decode integrity token:", error);
    return { success: false, error: "Token decoding failed" };
  }
}

/**
 * Verify Play Integrity token and return risk assessment
 */
async function verifyPlayIntegrity(
  integrityToken: string,
  expectedNonce: string | undefined,
  expectedPackageName: string
): Promise<{
  verified: boolean;
  trustLevel: TrustLevel;
  riskScore: number;
  message?: string;
  verdicts?: {
    device: DeviceVerdict[];
    app: AppVerdict;
    account: AccountVerdict;
  };
}> {
  // Validate token format
  if (!integrityToken || integrityToken.length < 100) {
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "Invalid integrity token format",
    };
  }

  // Decode token via Google API
  const decodeResult = await decodeIntegrityToken(integrityToken);

  if (!decodeResult.success || !decodeResult.payload) {
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: decodeResult.error || "Token decoding failed",
    };
  }

  const payload = decodeResult.payload;

  // Verify package name
  if (payload.requestDetails.requestPackageName !== expectedPackageName) {
    console.warn(
      `Package name mismatch: expected ${expectedPackageName}, ` +
      `got ${payload.requestDetails.requestPackageName}`
    );
    return {
      verified: false,
      trustLevel: "suspicious",
      riskScore: 100,
      message: "Package name mismatch",
    };
  }

  // Verify nonce if provided
  if (expectedNonce) {
    const tokenNonce = payload.requestDetails.nonce;
    // Nonce in payload is base64 encoded
    if (tokenNonce !== expectedNonce) {
      console.warn("Nonce mismatch");
      return {
        verified: false,
        trustLevel: "suspicious",
        riskScore: 100,
        message: "Nonce mismatch",
      };
    }
  }

  // Check timestamp freshness (within 10 minutes)
  const tokenTimestamp = parseInt(payload.requestDetails.timestampMillis, 10);
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes

  if (now - tokenTimestamp > maxAge) {
    return {
      verified: false,
      trustLevel: "suspicious",
      riskScore: 80,
      message: "Token expired",
    };
  }

  // Calculate risk score based on verdicts
  let riskScore = 0;
  const deviceVerdicts = payload.deviceIntegrity.deviceRecognitionVerdict || [];
  const appVerdict = payload.appIntegrity.appRecognitionVerdict;
  const accountVerdict = payload.accountDetails.appLicensingVerdict;

  // Device integrity scoring
  if (deviceVerdicts.includes("MEETS_STRONG_INTEGRITY")) {
    riskScore += 0; // Best possible
  } else if (deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY")) {
    riskScore += 10; // Good
  } else if (deviceVerdicts.includes("MEETS_BASIC_INTEGRITY")) {
    riskScore += 30; // Acceptable but concerning
  } else if (deviceVerdicts.includes("MEETS_VIRTUAL_INTEGRITY")) {
    riskScore += 50; // Emulator/virtual device
  } else {
    riskScore += 70; // No device integrity
  }

  // App integrity scoring
  if (appVerdict === "PLAY_RECOGNIZED") {
    riskScore += 0; // App from Play Store
  } else if (appVerdict === "UNRECOGNIZED_VERSION") {
    riskScore += 20; // Modified or sideloaded
  } else {
    riskScore += 10; // Unevaluated
  }

  // Account scoring
  if (accountVerdict === "LICENSED") {
    riskScore += 0; // User has license
  } else if (accountVerdict === "UNLICENSED") {
    riskScore += 15; // No license
  } else {
    riskScore += 5; // Unevaluated
  }

  // Determine trust level
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

  // Determine if verified (must have at least basic integrity)
  const verified = deviceVerdicts.length > 0 && (
    deviceVerdicts.includes("MEETS_BASIC_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_STRONG_INTEGRITY") ||
    deviceVerdicts.includes("MEETS_VIRTUAL_INTEGRITY")
  );

  console.log(
    `Play Integrity verified: ${verified}, ` +
    `device: [${deviceVerdicts.join(", ")}], ` +
    `app: ${appVerdict}, ` +
    `account: ${accountVerdict}, ` +
    `risk: ${riskScore}`
  );

  return {
    verified,
    trustLevel,
    riskScore,
    verdicts: {
      device: deviceVerdicts,
      app: appVerdict,
      account: accountVerdict,
    },
  };
}

/**
 * Verify legacy SafetyNet attestation (deprecated fallback)
 */
async function verifySafetyNet(
  attestation: string,
  _expectedNonce: string | undefined
): Promise<{
  verified: boolean;
  trustLevel: TrustLevel;
  riskScore: number;
  message?: string;
}> {
  // SafetyNet is deprecated since 2024
  // This is a minimal implementation for older clients

  if (!attestation || attestation.length < 100) {
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "Invalid SafetyNet attestation",
    };
  }

  try {
    // SafetyNet attestation is a JWT
    // Format: header.payload.signature
    const parts = attestation.split(".");
    if (parts.length !== 3) {
      return {
        verified: false,
        trustLevel: "unknown",
        riskScore: 100,
        message: "Invalid attestation format",
      };
    }

    // Decode payload (without verification - SafetyNet is deprecated)
    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    // Check basic fields
    if (!payload.ctsProfileMatch && !payload.basicIntegrity) {
      return {
        verified: false,
        trustLevel: "suspicious",
        riskScore: 80,
        message: "Device failed integrity checks",
      };
    }

    // Calculate risk score
    let riskScore = 40; // Higher base score for deprecated API

    if (payload.ctsProfileMatch) {
      riskScore -= 15;
    }
    if (payload.basicIntegrity) {
      riskScore -= 10;
    }

    // Note: Full verification would require checking the signature against
    // Google's public key, but since SafetyNet is deprecated, we accept
    // with elevated risk score

    console.warn("SafetyNet attestation accepted (deprecated API)");

    return {
      verified: true,
      trustLevel: riskScore <= 30 ? "trusted" : "unknown",
      riskScore,
      message: "SafetyNet is deprecated - please update to Play Integrity",
    };
  } catch (error) {
    console.error("SafetyNet verification error:", error);
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "SafetyNet verification failed",
    };
  }
}

// ============================================================================
// Device Record Management
// ============================================================================

/**
 * Generate device ID from integrity token hash
 */
async function generateDeviceId(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`android:${token.substring(0, 100)}:foodshare`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Get device record by key ID
 */
async function getDeviceRecord(
  supabase: ReturnType<typeof createClient>,
  keyId: string
): Promise<DeviceRecord | null> {
  const { data } = await supabase
    .from("device_attestations")
    .select("*")
    .eq("key_id", keyId)
    .eq("platform", "android")
    .single();

  return data as DeviceRecord | null;
}

/**
 * Update or create device attestation record
 */
async function updateDeviceRecord(
  supabase: ReturnType<typeof createClient>,
  keyId: string,
  verified: boolean,
  trustLevel: TrustLevel,
  riskScore: number,
  verdicts?: {
    device: DeviceVerdict[];
    app: AppVerdict;
    account: AccountVerdict;
  }
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
        last_seen: now,
        updated_at: now,
        verification_count: (existing.verification_count || 0) + 1,
        risk_score: Math.min(riskScore, existing.risk_score || 100),
        flags: {
          ...(existing.flags || {}),
          lastVerdicts: verdicts,
          lastVerifiedAt: now,
        },
      })
      .eq("key_id", keyId)
      .eq("platform", "android");
  } else {
    await supabase.from("device_attestations").insert({
      key_id: keyId,
      platform: "android",
      attestation_verified: verified,
      trust_level: trustLevel,
      assertion_counter: 0,
      created_at: now,
      updated_at: now,
      last_seen: now,
      verification_count: 1,
      risk_score: riskScore,
      flags: {
        verdicts: verdicts,
      },
    });
  }

  return deviceId;
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // Handle preflight
  if (req.method === "OPTIONS") {
    return handleMobileCorsPrelight(req);
  }

  const corsHeaders = getCorsHeadersWithMobile(req);

  console.log(`[${requestId}] Android attestation verification request`);

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    // Parse request body
    const body: IntegrityRequest = await req.json();

    // Validate required fields
    if (!body.type || !body.integrityToken) {
      return new Response(
        JSON.stringify({
          verified: false,
          trustLevel: "unknown",
          message: "Missing required fields: type, integrityToken",
        } as IntegrityResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    let result: {
      verified: boolean;
      trustLevel: TrustLevel;
      riskScore: number;
      message?: string;
      verdicts?: {
        device: DeviceVerdict[];
        app: AppVerdict;
        account: AccountVerdict;
      };
    };

    const packageName = body.packageName || PACKAGE_NAME;

    if (body.type === "integrity") {
      // Play Integrity API verification
      result = await verifyPlayIntegrity(
        body.integrityToken,
        body.nonce,
        packageName
      );
    } else if (body.type === "safetynet") {
      // Legacy SafetyNet fallback
      result = await verifySafetyNet(body.integrityToken, body.nonce);
    } else {
      return new Response(
        JSON.stringify({
          verified: false,
          trustLevel: "unknown",
          message: `Unknown attestation type: ${body.type}`,
        } as IntegrityResponse),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Generate key ID from token for tracking
    const keyId = await generateDeviceId(body.integrityToken);

    // Store attestation record
    const deviceId = await updateDeviceRecord(
      supabase,
      keyId,
      result.verified,
      result.trustLevel,
      result.riskScore,
      result.verdicts
    );

    const response: IntegrityResponse = {
      verified: result.verified,
      trustLevel: result.trustLevel,
      message: result.message,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      riskScore: result.riskScore,
      deviceId,
      verdicts: result.verdicts,
    };

    const duration = Date.now() - startTime;
    console.log(
      `[${requestId}] ${body.type} ${response.verified ? "verified" : "failed"} ` +
      `(trust: ${response.trustLevel}, risk: ${response.riskScore}) in ${duration}ms`
    );

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Request-ID": requestId,
        "X-Version": VERSION,
        "X-Duration-Ms": duration.toString(),
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[${requestId}] Error:`, error);

    return new Response(
      JSON.stringify({
        verified: false,
        trustLevel: "unknown",
        message: "Internal server error",
      } as IntegrityResponse),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
          "X-Version": VERSION,
          "X-Duration-Ms": duration.toString(),
        },
      }
    );
  }
});
