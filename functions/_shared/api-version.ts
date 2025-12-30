// ============================================================================
// API Version Management
// Handles version negotiation, compatibility checking, and deprecation warnings
//
// Features:
// - Accept header version negotiation
// - Query parameter fallback
// - Platform-specific version requirements
// - Deprecation/sunset warnings
// - Client telemetry integration
// ============================================================================

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Types
// ============================================================================

export type Platform = "ios" | "android" | "web" | "unknown";

export interface APIVersion {
  version: string;
  releasedAt: Date;
  deprecatedAt?: Date;
  sunsetAt?: Date;
  changelog?: string;
  breakingChanges?: Record<string, string>;
  minClientVersions: Record<Platform, string | null>;
}

export interface VersionCheckResult {
  requestedVersion: string;
  resolvedVersion: string;
  compatible: boolean;
  deprecated: boolean;
  sunsetWarning?: string;
  updateRequired: boolean;
  minVersion?: string;
  headers: Record<string, string>;
}

export interface ClientInfo {
  platform: Platform;
  appVersion: string;
  apiVersion?: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Supported API versions with their requirements
 */
export const API_VERSIONS: Record<string, APIVersion> = {
  "1.0.0": {
    version: "1.0.0",
    releasedAt: new Date("2025-01-01"),
    deprecatedAt: new Date("2025-06-01"),
    sunsetAt: new Date("2025-12-31"),
    changelog: "Initial API release",
    minClientVersions: {
      ios: "3.0.0",
      android: "1.0.0",
      web: "1.0.0",
      unknown: null,
    },
  },
  "2.0.0": {
    version: "2.0.0",
    releasedAt: new Date("2025-06-01"),
    changelog: "Unified response format, platform-aware BFF",
    breakingChanges: {
      "response_format": "Response envelope structure changed to include meta, pagination, and uiHints",
      "error_codes": "Error codes standardized across all endpoints",
    },
    minClientVersions: {
      ios: "3.1.0",
      android: "1.1.0",
      web: "2.0.0",
      unknown: null,
    },
  },
};

/**
 * Current default API version
 */
export const DEFAULT_API_VERSION = "2.0.0";

/**
 * Latest API version
 */
export const LATEST_API_VERSION = "2.0.0";

// ============================================================================
// Version Parsing
// ============================================================================

/**
 * Parse version string into comparable array
 * @param version Version string (e.g., "3.1.0")
 * @returns Array of version parts [major, minor, patch]
 */
export function parseVersion(version: string): number[] {
  const parts = version.split(".").map((p) => parseInt(p, 10) || 0);
  // Ensure we have at least 3 parts
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts;
}

/**
 * Compare two version strings
 * @param a First version
 * @param b Second version
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    if (partsA[i] < partsB[i]) return -1;
    if (partsA[i] > partsB[i]) return 1;
  }
  return 0;
}

/**
 * Check if version A is greater than or equal to version B
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean {
  return compareVersions(version, minVersion) >= 0;
}

// ============================================================================
// Version Negotiation
// ============================================================================

/**
 * Extract API version from Accept header
 * Format: application/vnd.foodshare.v2+json
 */
export function parseAcceptHeader(accept: string | null): string | null {
  if (!accept) return null;

  // Match: application/vnd.foodshare.v{version}+json
  const match = accept.match(/application\/vnd\.foodshare\.v(\d+(?:\.\d+)?(?:\.\d+)?)\+json/i);
  if (match) {
    // Normalize version (v2 -> 2.0.0, v2.1 -> 2.1.0)
    const parts = match[1].split(".");
    while (parts.length < 3) parts.push("0");
    return parts.join(".");
  }

  return null;
}

/**
 * Get API version from request
 * Priority: Accept header > query param > default
 */
export function getRequestedVersion(request: Request): string {
  // 1. Try Accept header
  const accept = request.headers.get("Accept");
  const headerVersion = parseAcceptHeader(accept);
  if (headerVersion && API_VERSIONS[headerVersion]) {
    return headerVersion;
  }

  // 2. Try query parameter
  const url = new URL(request.url);
  const queryVersion = url.searchParams.get("version") || url.searchParams.get("api_version");
  if (queryVersion) {
    // Normalize version
    const parts = queryVersion.replace(/^v/i, "").split(".");
    while (parts.length < 3) parts.push("0");
    const normalized = parts.join(".");
    if (API_VERSIONS[normalized]) {
      return normalized;
    }
  }

  // 3. Use X-API-Version header (legacy support)
  const legacyHeader = request.headers.get("X-API-Version");
  if (legacyHeader && API_VERSIONS[legacyHeader]) {
    return legacyHeader;
  }

  // 4. Fall back to default
  return DEFAULT_API_VERSION;
}

/**
 * Extract client info from request
 */
export function getClientInfo(request: Request): ClientInfo {
  // Platform from header or user-agent
  const platformHeader = request.headers.get("X-Client-Platform")?.toLowerCase();
  let platform: Platform = "unknown";

  if (platformHeader === "ios" || platformHeader === "android" || platformHeader === "web") {
    platform = platformHeader;
  } else {
    // Detect from user-agent
    const ua = request.headers.get("User-Agent") || "";
    if (ua.includes("iPhone") || ua.includes("iPad") || ua.includes("iOS")) {
      platform = "ios";
    } else if (ua.includes("Android")) {
      platform = "android";
    } else if (ua.includes("Mozilla") || ua.includes("Chrome") || ua.includes("Safari")) {
      platform = "web";
    }
  }

  // App version from header
  const appVersion = request.headers.get("X-App-Version") || "1.0.0";

  // API version
  const apiVersion = getRequestedVersion(request);

  return { platform, appVersion, apiVersion };
}

// ============================================================================
// Compatibility Checking
// ============================================================================

/**
 * Check if client is compatible with requested API version
 */
export function checkCompatibility(
  clientInfo: ClientInfo,
  requestedVersion: string = DEFAULT_API_VERSION
): VersionCheckResult {
  const apiVersion = API_VERSIONS[requestedVersion] || API_VERSIONS[DEFAULT_API_VERSION];
  const resolvedVersion = apiVersion.version;
  const now = new Date();

  // Check minimum client version for platform
  const minVersion = apiVersion.minClientVersions[clientInfo.platform];
  const compatible = !minVersion || isVersionAtLeast(clientInfo.appVersion, minVersion);

  // Check deprecation status
  const deprecated = !!apiVersion.deprecatedAt && now >= apiVersion.deprecatedAt;

  // Build sunset warning
  let sunsetWarning: string | undefined;
  if (apiVersion.sunsetAt) {
    const sunsetDate = apiVersion.sunsetAt.toISOString().split("T")[0];
    if (now >= apiVersion.sunsetAt) {
      sunsetWarning = `This API version has been sunset as of ${sunsetDate}. Please upgrade immediately.`;
    } else if (deprecated) {
      sunsetWarning = `This API version will be sunset on ${sunsetDate}. Please upgrade soon.`;
    }
  }

  // Build response headers
  const headers: Record<string, string> = {
    "X-API-Version": resolvedVersion,
  };

  if (deprecated) {
    headers["Deprecation"] = "true";
    if (apiVersion.deprecatedAt) {
      headers["Deprecation-Date"] = apiVersion.deprecatedAt.toISOString();
    }
  }

  if (apiVersion.sunsetAt) {
    headers["Sunset"] = apiVersion.sunsetAt.toISOString();
  }

  if (sunsetWarning) {
    headers["X-Deprecation-Warning"] = sunsetWarning;
  }

  if (!compatible) {
    headers["X-Update-Required"] = "true";
    headers["X-Min-Version"] = minVersion || "";
  }

  return {
    requestedVersion,
    resolvedVersion,
    compatible,
    deprecated,
    sunsetWarning,
    updateRequired: !compatible,
    minVersion: minVersion || undefined,
    headers,
  };
}

// ============================================================================
// Telemetry
// ============================================================================

/**
 * Track client version telemetry
 */
export async function trackClientVersion(
  supabase: SupabaseClient,
  clientInfo: ClientInfo
): Promise<void> {
  try {
    await supabase.rpc("check_client_compatibility", {
      p_platform: clientInfo.platform,
      p_app_version: clientInfo.appVersion,
      p_api_version: clientInfo.apiVersion || DEFAULT_API_VERSION,
    });
  } catch (error) {
    // Non-blocking - just log
    console.warn("Failed to track client version:", error);
  }
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Add version headers to response
 */
export function addVersionHeaders(
  headers: Headers,
  versionCheck: VersionCheckResult
): void {
  for (const [key, value] of Object.entries(versionCheck.headers)) {
    headers.set(key, value);
  }
}

/**
 * Create version error response
 */
export function createVersionErrorResponse(
  versionCheck: VersionCheckResult,
  corsHeaders: Record<string, string>
): Response {
  const body = {
    success: false,
    error: {
      code: "CLIENT_UPDATE_REQUIRED",
      message: `Your app version is outdated. Please update to at least version ${versionCheck.minVersion}.`,
      details: {
        currentVersion: versionCheck.requestedVersion,
        minVersion: versionCheck.minVersion,
        updateRequired: true,
      },
    },
    meta: {
      timestamp: new Date().toISOString(),
      apiVersion: versionCheck.resolvedVersion,
    },
  };

  return new Response(JSON.stringify(body), {
    status: 426, // Upgrade Required
    headers: {
      ...corsHeaders,
      ...versionCheck.headers,
      "Content-Type": "application/json",
    },
  });
}

// ============================================================================
// Middleware Helper
// ============================================================================

/**
 * Version check middleware result
 */
export interface VersionMiddlewareResult {
  clientInfo: ClientInfo;
  versionCheck: VersionCheckResult;
  proceed: boolean;
  errorResponse?: Response;
}

/**
 * Run version check middleware
 * Returns proceed=false and errorResponse if client needs update
 */
export function versionMiddleware(
  request: Request,
  corsHeaders: Record<string, string>,
  enforceMinVersion: boolean = true
): VersionMiddlewareResult {
  const clientInfo = getClientInfo(request);
  const versionCheck = checkCompatibility(clientInfo, clientInfo.apiVersion);

  // If client is incompatible and we're enforcing, return error
  if (enforceMinVersion && !versionCheck.compatible) {
    return {
      clientInfo,
      versionCheck,
      proceed: false,
      errorResponse: createVersionErrorResponse(versionCheck, corsHeaders),
    };
  }

  return {
    clientInfo,
    versionCheck,
    proceed: true,
  };
}

// ============================================================================
// Database Helpers
// ============================================================================

/**
 * Get API version info from database
 * Falls back to in-memory config if database unavailable
 */
export async function getAPIVersionFromDB(
  supabase: SupabaseClient,
  version: string
): Promise<APIVersion | null> {
  try {
    const { data, error } = await supabase
      .from("api_versions")
      .select("*")
      .eq("version", version)
      .single();

    if (error || !data) {
      // Fall back to in-memory config
      return API_VERSIONS[version] || null;
    }

    return {
      version: data.version,
      releasedAt: new Date(data.released_at),
      deprecatedAt: data.deprecated_at ? new Date(data.deprecated_at) : undefined,
      sunsetAt: data.sunset_at ? new Date(data.sunset_at) : undefined,
      changelog: data.changelog,
      breakingChanges: data.breaking_changes,
      minClientVersions: data.min_client_versions || API_VERSIONS[version]?.minClientVersions || {
        ios: null,
        android: null,
        web: null,
        unknown: null,
      },
    };
  } catch {
    // Fall back to in-memory config
    return API_VERSIONS[version] || null;
  }
}
