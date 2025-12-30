/**
 * get-certificate-pins Edge Function
 *
 * Provides dynamic certificate pins for SSL pinning across platforms.
 * Allows certificate rotation without app updates.
 *
 * Features:
 * - Platform-aware pin delivery (iOS, Android, Web)
 * - Returns current valid pins with expiration dates
 * - Supports grace period for pin rotation
 * - Version-aware pin delivery per platform
 * - Cached responses for performance
 * - Android Network Security Config XML generation
 * - Rotation warnings and telemetry
 *
 * Response format (platform-optimized):
 * {
 *   pins: {
 *     ios: { sha256: [...], publicKeyHashes: [...] },
 *     android: { sha256: [...], networkSecurityConfig: "..." },
 *     web: { sha256: [...] }
 *   },
 *   minAppVersions: { ios: "3.0.0", android: "1.0.0", web: "1.0.0" },
 *   validUntil: "2025-06-01",
 *   rotationWarning: { active: boolean, message?: string, nextRotation?: string },
 *   refreshIntervalHours: 24
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Types
type Platform = "ios" | "android" | "web" | "unknown";

interface CertificatePin {
  hash: string;
  type: "leaf" | "intermediate" | "root";
  expires: string;
  priority: number;
  description?: string;
  // Platform-specific metadata
  commonName?: string;
  organization?: string;
}

interface IOSPinFormat {
  sha256: string[];
  publicKeyHashes: string[]; // Base64-encoded for App Transport Security
}

interface AndroidPinFormat {
  sha256: string[];
  networkSecurityConfig: string; // XML format for Android
  pinSetExpiration: string;
}

interface WebPinFormat {
  sha256: string[];
  publicKeyPinsHeader: string; // For HPKP-style header
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
  // Legacy format (for backwards compatibility)
  pins: CertificatePin[];
  minAppVersion: string;
  gracePeriodDays: number;
  refreshIntervalHours: number;
  lastUpdated: string;
  nextRotation?: string;
  // New platform-optimized format
  platformPins?: PlatformPins;
  minAppVersions?: Record<Platform, string>;
  validUntil?: string;
  rotationWarning?: RotationWarning;
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-app-version, x-platform",
};

/**
 * Current certificate pins for Supabase
 *
 * These are the SHA-256 hashes of the Subject Public Key Info (SPKI)
 * for the certificates in the chain.
 *
 * To generate: openssl s_client -connect host:443 | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
 *
 * UPDATE THESE when certificates are rotated!
 */
const CURRENT_PINS: CertificatePin[] = [
  {
    // Supabase leaf certificate (rotates most frequently)
    hash: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    type: "leaf",
    expires: "2025-06-01",
    priority: 1,
    description: "Supabase primary leaf certificate",
  },
  {
    // Intermediate CA (more stable)
    hash: "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    type: "intermediate",
    expires: "2026-01-01",
    priority: 2,
    description: "Let's Encrypt R3 intermediate",
  },
  {
    // Root CA (backup, very stable)
    hash: "sha256/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
    type: "root",
    expires: "2030-01-01",
    priority: 3,
    description: "ISRG Root X1",
  },
];

/**
 * Upcoming pins for rotation (added during grace period)
 * These are new pins that will become active after rotation
 */
const UPCOMING_PINS: CertificatePin[] = [
  // Add new pins here before rotation
  // {
  //   hash: "sha256/NEW_LEAF_PIN_HASH",
  //   type: "leaf",
  //   expires: "2025-12-01",
  //   priority: 1,
  //   description: "New Supabase leaf certificate"
  // }
];

// Configuration
const CONFIG = {
  minAppVersions: {
    ios: "3.0.0",
    android: "1.0.0",
    web: "1.0.0",
    unknown: "1.0.0",
  } as Record<Platform, string>,
  minAppVersion: "3.0.0", // Legacy, prefer minAppVersions
  gracePeriodDays: 14, // Days before expiration to include new pins
  refreshIntervalHours: 24, // How often clients should refresh
  nextRotation: "2025-05-15", // Planned rotation date (optional)
  warningThresholdDays: 30, // Warn when pins expire within this many days
  criticalThresholdDays: 7, // Critical warning threshold
  supabaseHost: "supabase.co", // For network security config domain
};

// ============================================================================
// Platform Detection
// ============================================================================

function detectPlatform(request: Request): Platform {
  // Check explicit header first
  const platformHeader = request.headers.get("x-platform")?.toLowerCase();
  if (platformHeader === "ios" || platformHeader === "android" || platformHeader === "web") {
    return platformHeader;
  }

  // Check X-Client-Platform header
  const clientPlatform = request.headers.get("x-client-platform")?.toLowerCase();
  if (clientPlatform === "ios" || clientPlatform === "android" || clientPlatform === "web") {
    return clientPlatform;
  }

  // Detect from User-Agent
  const ua = request.headers.get("user-agent") || "";
  if (ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iOS") || ua.includes("Darwin")) {
    return "ios";
  }
  if (ua.includes("Android") || ua.includes("okhttp")) {
    return "android";
  }
  if (ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari") || ua.includes("Firefox")) {
    return "web";
  }

  return "unknown";
}

// ============================================================================
// Platform-Specific Pin Formatters
// ============================================================================

/**
 * Generate iOS-compatible pin format
 * iOS uses ATS (App Transport Security) with base64-encoded SHA-256 hashes
 */
function formatIOSPins(pins: CertificatePin[]): IOSPinFormat {
  const sha256Hashes = pins.map(p => p.hash);
  // For iOS, the public key hashes are the same SHA-256 values
  // but formatted for use in Info.plist NSExceptionDomains
  const publicKeyHashes = pins.map(p => {
    // Extract just the base64 part after "sha256/"
    return p.hash.replace("sha256/", "");
  });

  return {
    sha256: sha256Hashes,
    publicKeyHashes,
  };
}

/**
 * Generate Android Network Security Config XML
 * Android uses XML-based network security configuration
 */
function formatAndroidPins(pins: CertificatePin[], validUntil: string): AndroidPinFormat {
  const sha256Hashes = pins.map(p => p.hash);

  // Generate Android Network Security Config XML
  const pinEntries = pins
    .map(p => `            <pin digest="SHA-256">${p.hash.replace("sha256/", "")}</pin>`)
    .join("\n");

  const networkSecurityConfig = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="false">
        <domain includeSubdomains="true">${CONFIG.supabaseHost}</domain>
        <domain includeSubdomains="true">foodshare.app</domain>
        <pin-set expiration="${validUntil}">
${pinEntries}
        </pin-set>
        <trust-anchors>
            <certificates src="system"/>
        </trust-anchors>
    </domain-config>

    <!-- Debug configuration (only active in debug builds) -->
    <debug-overrides>
        <trust-anchors>
            <certificates src="user"/>
        </trust-anchors>
    </debug-overrides>
</network-security-config>`;

  return {
    sha256: sha256Hashes,
    networkSecurityConfig,
    pinSetExpiration: validUntil,
  };
}

/**
 * Generate Web-compatible pin format
 * Includes HPKP-style header for reference (though HPKP is deprecated)
 */
function formatWebPins(pins: CertificatePin[]): WebPinFormat {
  const sha256Hashes = pins.map(p => p.hash);

  // Generate Public-Key-Pins style header for reference
  // Note: HPKP is deprecated but this format is still useful for documentation
  const pinDirectives = pins
    .map(p => `pin-sha256="${p.hash.replace("sha256/", "")}"`)
    .join("; ");

  const publicKeyPinsHeader = `${pinDirectives}; max-age=2592000; includeSubDomains`;

  return {
    sha256: sha256Hashes,
    publicKeyPinsHeader,
  };
}

/**
 * Generate platform-specific pins
 */
function generatePlatformPins(pins: CertificatePin[], validUntil: string): PlatformPins {
  return {
    ios: formatIOSPins(pins),
    android: formatAndroidPins(pins, validUntil),
    web: formatWebPins(pins),
  };
}

// ============================================================================
// Rotation Warning System
// ============================================================================

/**
 * Calculate rotation warning based on pin expiration dates
 */
function calculateRotationWarning(pins: CertificatePin[]): RotationWarning {
  const now = new Date();

  // Find the earliest expiring pin
  let earliestExpiry: Date | null = null;
  for (const pin of pins) {
    const expiry = new Date(pin.expires);
    if (!earliestExpiry || expiry < earliestExpiry) {
      earliestExpiry = expiry;
    }
  }

  if (!earliestExpiry) {
    return { active: false, severity: "info" };
  }

  const daysUntilExpiry = Math.ceil(
    (earliestExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Determine severity
  if (daysUntilExpiry <= CONFIG.criticalThresholdDays) {
    return {
      active: true,
      severity: "critical",
      message: `Certificate pins expire in ${daysUntilExpiry} days! Immediate rotation required.`,
      nextRotation: CONFIG.nextRotation,
      daysUntilExpiry,
    };
  }

  if (daysUntilExpiry <= CONFIG.warningThresholdDays) {
    return {
      active: true,
      severity: "warning",
      message: `Certificate pins expire in ${daysUntilExpiry} days. Please plan rotation.`,
      nextRotation: CONFIG.nextRotation,
      daysUntilExpiry,
    };
  }

  if (CONFIG.nextRotation) {
    const rotationDate = new Date(CONFIG.nextRotation);
    const daysUntilRotation = Math.ceil(
      (rotationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysUntilRotation <= CONFIG.warningThresholdDays) {
      return {
        active: true,
        severity: "info",
        message: `Planned certificate rotation in ${daysUntilRotation} days.`,
        nextRotation: CONFIG.nextRotation,
        daysUntilExpiry,
      };
    }
  }

  return {
    active: false,
    severity: "info",
    daysUntilExpiry,
  };
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Detect platform and get client info
    const platform = detectPlatform(req);
    const appVersion = req.headers.get("x-app-version") || "unknown";
    const acceptHeader = req.headers.get("accept") || "";

    // Check if client wants legacy format (backwards compatibility)
    const wantsLegacyFormat = acceptHeader.includes("application/vnd.foodshare.pins.v1");

    // Log request for monitoring
    console.log(
      `Certificate pins requested by ${platform} v${appVersion}` +
      (wantsLegacyFormat ? " (legacy format)" : " (platform-optimized)")
    );

    // Filter out expired pins
    const now = new Date();
    const validPins = CURRENT_PINS.filter((pin) => {
      const expires = new Date(pin.expires);
      return expires > now;
    });

    // Check if we're in grace period for any pin
    const gracePeriodMs = CONFIG.gracePeriodDays * 24 * 60 * 60 * 1000;
    const inGracePeriod = CURRENT_PINS.some((pin) => {
      const expires = new Date(pin.expires);
      const gracePeriodStart = new Date(expires.getTime() - gracePeriodMs);
      return now >= gracePeriodStart && now < expires;
    });

    // Include upcoming pins if in grace period
    const allPins = inGracePeriod
      ? [...validPins, ...UPCOMING_PINS]
      : validPins;

    // Sort by priority (lower = higher priority)
    allPins.sort((a, b) => a.priority - b.priority);

    // Calculate earliest expiration for validUntil
    const earliestExpiry = allPins.reduce((earliest, pin) => {
      const expires = new Date(pin.expires);
      return !earliest || expires < earliest ? expires : earliest;
    }, null as Date | null);

    const validUntil = earliestExpiry?.toISOString().split("T")[0] || "2025-12-31";

    // Check minimum app version for this platform
    const minVersion = CONFIG.minAppVersions[platform] || CONFIG.minAppVersion;
    if (isVersionLessThan(appVersion, minVersion)) {
      console.warn(
        `${platform} app version ${appVersion} is below minimum ${minVersion}`
      );
    }

    // Calculate rotation warning
    const rotationWarning = calculateRotationWarning(allPins);

    // Build response
    const response: PinResponse = {
      // Legacy fields (always included for backwards compatibility)
      pins: allPins,
      minAppVersion: CONFIG.minAppVersion,
      gracePeriodDays: CONFIG.gracePeriodDays,
      refreshIntervalHours: CONFIG.refreshIntervalHours,
      lastUpdated: new Date().toISOString(),
      nextRotation: CONFIG.nextRotation,
      // New platform-optimized fields
      platformPins: wantsLegacyFormat ? undefined : generatePlatformPins(allPins, validUntil),
      minAppVersions: wantsLegacyFormat ? undefined : CONFIG.minAppVersions,
      validUntil: wantsLegacyFormat ? undefined : validUntil,
      rotationWarning: wantsLegacyFormat ? undefined : rotationWarning,
    };

    // Build response headers
    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "ETag": `"${hashPins(allPins)}"`,
      "X-Platform-Detected": platform,
      "X-Pins-Valid-Until": validUntil,
    };

    // Add rotation warning header if active
    if (rotationWarning.active) {
      responseHeaders["X-Pin-Rotation-Warning"] = rotationWarning.severity;
      if (rotationWarning.daysUntilExpiry !== undefined) {
        responseHeaders["X-Pin-Days-Until-Expiry"] = String(rotationWarning.daysUntilExpiry);
      }
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Error fetching certificate pins:", error);

    // Return embedded fallback pins on error
    const platform = detectPlatform(req);
    const validUntil = "2025-12-31";

    return new Response(
      JSON.stringify({
        pins: CURRENT_PINS,
        minAppVersion: CONFIG.minAppVersion,
        gracePeriodDays: CONFIG.gracePeriodDays,
        refreshIntervalHours: CONFIG.refreshIntervalHours,
        lastUpdated: new Date().toISOString(),
        error: "Using fallback pins",
        // Include platform pins in fallback too
        platformPins: generatePlatformPins(CURRENT_PINS, validUntil),
        minAppVersions: CONFIG.minAppVersions,
        validUntil,
        rotationWarning: calculateRotationWarning(CURRENT_PINS),
      }),
      {
        status: 200, // Still return 200 with fallback pins
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Platform-Detected": platform,
          "X-Fallback-Pins": "true",
        },
      }
    );
  }
});

/**
 * Compare semantic versions
 */
function isVersionLessThan(version: string, minimum: string): boolean {
  const v1Parts = version.split(".").map((p) => parseInt(p, 10) || 0);
  const v2Parts = minimum.split(".").map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1 = v1Parts[i] || 0;
    const v2 = v2Parts[i] || 0;

    if (v1 < v2) return true;
    if (v1 > v2) return false;
  }

  return false;
}

/**
 * Generate hash for ETag
 */
function hashPins(pins: CertificatePin[]): string {
  const content = pins.map((p) => p.hash).join(",");
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
