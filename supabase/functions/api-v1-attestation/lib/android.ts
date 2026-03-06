/**
 * Android attestation verification handlers.
 *
 * Google Play Integrity API verification and deprecated SafetyNet fallback.
 * Includes Google OAuth2 token management for API authentication.
 *
 * @module api-v1-attestation/lib/android
 */

import { logger } from "../../_shared/logger.ts";
import type {
  AccountVerdict,
  AppVerdict,
  DeviceVerdict,
  PlayIntegrityPayload,
  TrustLevel,
} from "./types.ts";

// =============================================================================
// Environment Configuration
// =============================================================================

const GOOGLE_CLOUD_PROJECT_ID = Deno.env.get("GOOGLE_CLOUD_PROJECT_ID") || "";
const GOOGLE_APPLICATION_CREDENTIALS = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || "";
const ANDROID_PACKAGE_NAME = Deno.env.get("ANDROID_PACKAGE_NAME") || "com.flutterflow.foodshare";

export { ANDROID_PACKAGE_NAME };

// Play Integrity API endpoint
const PLAY_INTEGRITY_API_URL = "https://playintegrity.googleapis.com/v1";

// =============================================================================
// Google OAuth2 Token
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

    const headerBase64 = btoa(JSON.stringify(header)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=/g, "");
    const payloadBase64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=/g, "");

    const signatureInput = `${headerBase64}.${payloadBase64}`;

    const privateKeyPem = credentials.private_key;
    const pemContents = privateKeyPem.replace("-----BEGIN PRIVATE KEY-----", "").replace(
      "-----END PRIVATE KEY-----",
      "",
    ).replace(/\s/g, "");
    const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signatureInput),
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
    logger.error(
      "Failed to get Google access token",
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}

// =============================================================================
// Play Integrity Token Decoding
// =============================================================================

async function decodeIntegrityToken(
  integrityToken: string,
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
        body: JSON.stringify({ integrityToken }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error("Play Integrity API error", new Error(error));
      return { success: false, error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return { success: true, payload: data.tokenPayloadExternal };
  } catch (error) {
    logger.error(
      "Failed to decode integrity token",
      error instanceof Error ? error : new Error(String(error)),
    );
    return { success: false, error: "Token decoding failed" };
  }
}

// =============================================================================
// Play Integrity Verification
// =============================================================================

export async function verifyPlayIntegrity(
  integrityToken: string,
  expectedNonce: string | undefined,
  expectedPackageName: string,
): Promise<{
  verified: boolean;
  trustLevel: TrustLevel;
  riskScore: number;
  message?: string;
  verdicts?: { device: DeviceVerdict[]; app: AppVerdict; account: AccountVerdict };
}> {
  if (!integrityToken || integrityToken.length < 100) {
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "Invalid integrity token format",
    };
  }

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

  if (payload.requestDetails.requestPackageName !== expectedPackageName) {
    return {
      verified: false,
      trustLevel: "suspicious",
      riskScore: 100,
      message: "Package name mismatch",
    };
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

  logger.info("Play Integrity verified", {
    verified,
    device: deviceVerdicts,
    app: appVerdict,
    account: accountVerdict,
    risk: riskScore,
  });

  return {
    verified,
    trustLevel,
    riskScore,
    verdicts: { device: deviceVerdicts, app: appVerdict, account: accountVerdict },
  };
}

// =============================================================================
// SafetyNet Verification (Deprecated)
// =============================================================================

export async function verifySafetyNet(
  attestation: string,
): Promise<{ verified: boolean; trustLevel: TrustLevel; riskScore: number; message?: string }> {
  if (!attestation || attestation.length < 100) {
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "Invalid SafetyNet attestation",
    };
  }

  try {
    const parts = attestation.split(".");
    if (parts.length !== 3) {
      return {
        verified: false,
        trustLevel: "unknown",
        riskScore: 100,
        message: "Invalid attestation format",
      };
    }

    const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    if (!payload.ctsProfileMatch && !payload.basicIntegrity) {
      return {
        verified: false,
        trustLevel: "suspicious",
        riskScore: 80,
        message: "Device failed integrity checks",
      };
    }

    let riskScore = 40;
    if (payload.ctsProfileMatch) riskScore -= 15;
    if (payload.basicIntegrity) riskScore -= 10;

    logger.warn("SafetyNet attestation accepted (deprecated API)");
    return {
      verified: true,
      trustLevel: riskScore <= 30 ? "trusted" : "unknown",
      riskScore,
      message: "SafetyNet is deprecated - please update to Play Integrity",
    };
  } catch (error) {
    logger.error(
      "SafetyNet verification error",
      error instanceof Error ? error : new Error(String(error)),
    );
    return {
      verified: false,
      trustLevel: "unknown",
      riskScore: 100,
      message: "SafetyNet verification failed",
    };
  }
}
