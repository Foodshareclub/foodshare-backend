/**
 * get-certificate-pins Edge Function
 *
 * Provides dynamic certificate pins for SSL pinning.
 * Allows certificate rotation without app updates.
 *
 * Features:
 * - Returns current valid pins with expiration dates
 * - Supports grace period for pin rotation
 * - Version-aware pin delivery
 * - Cached responses for performance
 *
 * Response format:
 * {
 *   pins: [
 *     { hash: "sha256/...", type: "leaf", expires: "2025-06-01", priority: 1 },
 *     { hash: "sha256/...", type: "intermediate", expires: "2026-01-01", priority: 2 }
 *   ],
 *   minAppVersion: "3.0.0",
 *   gracePeriodDays: 14,
 *   refreshIntervalHours: 24
 * }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Types
interface CertificatePin {
  hash: string;
  type: "leaf" | "intermediate" | "root";
  expires: string;
  priority: number;
  description?: string;
}

interface PinResponse {
  pins: CertificatePin[];
  minAppVersion: string;
  gracePeriodDays: number;
  refreshIntervalHours: number;
  lastUpdated: string;
  nextRotation?: string;
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
  minAppVersion: "3.0.0",
  gracePeriodDays: 14, // Days before expiration to include new pins
  refreshIntervalHours: 24, // How often clients should refresh
  nextRotation: "2025-05-15", // Planned rotation date (optional)
};

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
    // Get client info from headers
    const appVersion = req.headers.get("x-app-version") || "unknown";
    const platform = req.headers.get("x-platform") || "unknown";

    // Log request for monitoring
    console.log(
      `Certificate pins requested by ${platform} v${appVersion}`
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

    // Check minimum app version
    if (isVersionLessThan(appVersion, CONFIG.minAppVersion)) {
      console.warn(
        `App version ${appVersion} is below minimum ${CONFIG.minAppVersion}`
      );
    }

    const response: PinResponse = {
      pins: allPins,
      minAppVersion: CONFIG.minAppVersion,
      gracePeriodDays: CONFIG.gracePeriodDays,
      refreshIntervalHours: CONFIG.refreshIntervalHours,
      lastUpdated: new Date().toISOString(),
      nextRotation: CONFIG.nextRotation,
    };

    // Cache for 1 hour, stale-while-revalidate for 24 hours
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "ETag": `"${hashPins(allPins)}"`,
      },
    });
  } catch (error) {
    console.error("Error fetching certificate pins:", error);

    // Return embedded fallback pins on error
    return new Response(
      JSON.stringify({
        pins: CURRENT_PINS,
        minAppVersion: CONFIG.minAppVersion,
        gracePeriodDays: CONFIG.gracePeriodDays,
        refreshIntervalHours: CONFIG.refreshIntervalHours,
        lastUpdated: new Date().toISOString(),
        error: "Using fallback pins",
      }),
      {
        status: 200, // Still return 200 with fallback pins
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
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
