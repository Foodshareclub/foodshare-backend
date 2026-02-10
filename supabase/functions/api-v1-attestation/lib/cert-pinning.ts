/**
 * Certificate pinning configuration and handlers.
 *
 * Dynamic SSL certificate pin distribution with platform-specific formatting,
 * rotation warnings, grace period management, and ETag caching.
 *
 * @module api-v1-attestation/lib/cert-pinning
 */

import { logger } from "../../_shared/logger.ts";

// =============================================================================
// Types
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

// =============================================================================
// Pin Configuration
// =============================================================================

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
  supabaseHost: (() => {
    try {
      return new URL(Deno.env.get("SUPABASE_URL") || "").hostname;
    } catch {
      return "api.foodshare.club";
    }
  })(),
};

// =============================================================================
// Platform Detection
// =============================================================================

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

// =============================================================================
// Platform-Specific Pin Formatters
// =============================================================================

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

// =============================================================================
// Rotation Warning Calculator
// =============================================================================

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

// =============================================================================
// Version Comparison
// =============================================================================

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

// =============================================================================
// Pin Hashing (ETag)
// =============================================================================

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

// =============================================================================
// Certificate Pins Handler
// =============================================================================

export function handleCertificatePins(req: Request, corsHeaders: Record<string, string>): Response {
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
