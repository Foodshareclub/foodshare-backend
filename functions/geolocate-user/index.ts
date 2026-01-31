// ============================================================================
// GEOLOCATE USER - Before User Created Hook (Enterprise Edition)
// ============================================================================
//
// Uses IP geolocation to capture approximate user location at signup.
//
// CRITICAL: This hook runs BEFORE user creation. Any failure will block signup.
// Therefore, this function is designed to NEVER block signups - it gracefully
// degrades on any error.
//
// Configuration:
//   BEFORE_USER_CREATED_HOOK_SECRET - Required for production
//   GEOLOCATE_USER_ENABLED - Set to "false" to disable (default: true)
//   GEOLOCATE_TIMEOUT_MS - IP API timeout in ms (default: 3000)
//
// ============================================================================

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const VERSION = "2.0.0";
const SERVICE_NAME = "geolocate-user";

// =============================================================================
// Configuration (with validation)
// =============================================================================

interface Config {
  hookSecret: string | null;
  enabled: boolean;
  timeoutMs: number;
  ipApiBaseUrl: string;
  debugMode: boolean;
}

function loadConfig(): Config {
  const hookSecret = Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET")?.replace("v1,whsec_", "") || null;
  const enabled = Deno.env.get("GEOLOCATE_USER_ENABLED") !== "false";
  const timeoutMs = parseInt(Deno.env.get("GEOLOCATE_TIMEOUT_MS") || "3000", 10);
  const debugMode = Deno.env.get("DEBUG") === "true";

  return {
    hookSecret,
    enabled,
    timeoutMs: isNaN(timeoutMs) ? 3000 : timeoutMs,
    ipApiBaseUrl: "http://ip-api.com/json",
    debugMode,
  };
}

const config = loadConfig();

// Log startup configuration (without secrets)
console.log(JSON.stringify({
  event: "startup",
  service: SERVICE_NAME,
  version: VERSION,
  config: {
    enabled: config.enabled,
    timeoutMs: config.timeoutMs,
    hookSecretConfigured: !!config.hookSecret,
    debugMode: config.debugMode,
  },
  timestamp: new Date().toISOString(),
}));

// =============================================================================
// Types
// =============================================================================

interface GeoLocation {
  latitude: number;
  longitude: number;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
}

interface IpApiResponse {
  status: string;
  lat?: number;
  lon?: number;
  city?: string;
  regionName?: string;
  country?: string;
  countryCode?: string;
  message?: string;
}

interface HookPayload {
  metadata: {
    uuid: string;
    time: string;
    name: string;
    ip_address: string;
  };
  user: {
    id: string;
    email?: string;
    phone?: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  };
}

interface TelemetryEvent {
  event: string;
  service: string;
  version: string;
  requestId: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

// =============================================================================
// Telemetry & Logging
// =============================================================================

function logTelemetry(event: TelemetryEvent): void {
  console.log(JSON.stringify(event));
}

function createTelemetryEvent(
  requestId: string,
  eventName: string,
  metadata?: Record<string, unknown>
): TelemetryEvent {
  return {
    event: eventName,
    service: SERVICE_NAME,
    version: VERSION,
    requestId,
    metadata,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Circuit Breaker (In-Memory, Simple)
// =============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

const circuitBreaker: CircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: "closed",
};

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_TIMEOUT_MS = 30000; // 30 seconds

function isCircuitOpen(): boolean {
  if (circuitBreaker.state === "open") {
    // Check if we should transition to half-open
    if (Date.now() - circuitBreaker.lastFailure > CIRCUIT_RESET_TIMEOUT_MS) {
      circuitBreaker.state = "half-open";
      return false;
    }
    return true;
  }
  return false;
}

function recordSuccess(): void {
  if (circuitBreaker.state === "half-open") {
    circuitBreaker.state = "closed";
    circuitBreaker.failures = 0;
  }
}

function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();

  if (circuitBreaker.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitBreaker.state = "open";
  }
}

// =============================================================================
// IP Validation
// =============================================================================

function isPrivateIP(ipAddress: string): boolean {
  return (
    ipAddress === "127.0.0.1" ||
    ipAddress === "::1" ||
    ipAddress === "localhost" ||
    ipAddress.startsWith("192.168.") ||
    ipAddress.startsWith("10.") ||
    ipAddress.startsWith("172.16.") ||
    ipAddress.startsWith("172.17.") ||
    ipAddress.startsWith("172.18.") ||
    ipAddress.startsWith("172.19.") ||
    ipAddress.startsWith("172.20.") ||
    ipAddress.startsWith("172.21.") ||
    ipAddress.startsWith("172.22.") ||
    ipAddress.startsWith("172.23.") ||
    ipAddress.startsWith("172.24.") ||
    ipAddress.startsWith("172.25.") ||
    ipAddress.startsWith("172.26.") ||
    ipAddress.startsWith("172.27.") ||
    ipAddress.startsWith("172.28.") ||
    ipAddress.startsWith("172.29.") ||
    ipAddress.startsWith("172.30.") ||
    ipAddress.startsWith("172.31.") ||
    ipAddress.startsWith("fe80:") ||
    ipAddress.startsWith("fc00:") ||
    ipAddress.startsWith("fd00:")
  );
}

// Reserved for future use: validate IPv4 format
// function isValidIPv4(ip: string): boolean {
//   const parts = ip.split(".");
//   if (parts.length !== 4) return false;
//   return parts.every(part => {
//     const num = parseInt(part, 10);
//     return !isNaN(num) && num >= 0 && num <= 255;
//   });
// }

// =============================================================================
// Geolocation Service
// =============================================================================

async function getLocationFromIP(
  ipAddress: string,
  requestId: string
): Promise<GeoLocation | null> {
  // Validate IP
  if (!ipAddress || isPrivateIP(ipAddress)) {
    logTelemetry(createTelemetryEvent(requestId, "geolocation.skip", {
      reason: isPrivateIP(ipAddress) ? "private_ip" : "no_ip",
      ip: ipAddress?.substring(0, 3) + "***",
    }));
    return null;
  }

  // Check circuit breaker
  if (isCircuitOpen()) {
    logTelemetry(createTelemetryEvent(requestId, "geolocation.circuit_open"));
    return null;
  }

  const startTime = Date.now();

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    const response = await fetch(
      `${config.ipApiBaseUrl}/${ipAddress}?fields=status,lat,lon,city,regionName,country,countryCode`,
      {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      }
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      recordFailure();
      logTelemetry(createTelemetryEvent(requestId, "geolocation.api_error", {
        status: response.status,
        durationMs: Date.now() - startTime,
      }));
      return null;
    }

    const data: IpApiResponse = await response.json();

    if (data.status !== "success" || !data.lat || !data.lon) {
      logTelemetry(createTelemetryEvent(requestId, "geolocation.not_found", {
        apiStatus: data.status,
        message: data.message,
        durationMs: Date.now() - startTime,
      }));
      return null;
    }

    recordSuccess();

    const location: GeoLocation = {
      latitude: data.lat,
      longitude: data.lon,
      city: data.city,
      region: data.regionName,
      country: data.country,
      countryCode: data.countryCode,
    };

    logTelemetry(createTelemetryEvent(requestId, "geolocation.success", {
      country: location.countryCode,
      durationMs: Date.now() - startTime,
    }));

    return location;
  } catch (error) {
    recordFailure();

    const isTimeout = error instanceof DOMException && error.name === "AbortError";
    logTelemetry(createTelemetryEvent(requestId, "geolocation.error", {
      error: isTimeout ? "timeout" : String(error),
      durationMs: Date.now() - startTime,
    }));

    return null;
  }
}

// =============================================================================
// Webhook Verification
// =============================================================================

interface VerificationResult {
  success: boolean;
  payload?: HookPayload;
  error?: string;
  shouldAllowSignup: boolean;
}

function verifyWebhook(
  rawPayload: string,
  headers: Record<string, string>,
  requestId: string
): VerificationResult {
  // If no secret is configured, allow in development but log warning
  if (!config.hookSecret) {
    logTelemetry(createTelemetryEvent(requestId, "webhook.no_secret", {
      warning: "Running without webhook verification - configure BEFORE_USER_CREATED_HOOK_SECRET for production",
    }));

    try {
      const payload = JSON.parse(rawPayload) as HookPayload;
      return { success: true, payload, shouldAllowSignup: true };
    } catch (parseError) {
      logTelemetry(createTelemetryEvent(requestId, "webhook.parse_error", {
        error: String(parseError),
      }));
      // Even on parse error, allow signup (graceful degradation)
      return { success: false, error: "Invalid payload format", shouldAllowSignup: true };
    }
  }

  // Verify webhook signature
  try {
    const wh = new Webhook(config.hookSecret);
    const payload = wh.verify(rawPayload, headers) as HookPayload;

    logTelemetry(createTelemetryEvent(requestId, "webhook.verified"));
    return { success: true, payload, shouldAllowSignup: true };
  } catch (error) {
    const errorMessage = String(error);

    logTelemetry(createTelemetryEvent(requestId, "webhook.verification_failed", {
      error: errorMessage,
    }));

    // CRITICAL: On signature verification failure, we still allow signup
    // to prevent blocking users due to misconfiguration.
    // The geolocation feature is non-essential.
    //
    // If you want strict verification (block on failure), change this to:
    // return { success: false, error: errorMessage, shouldAllowSignup: false };

    return { success: false, error: errorMessage, shouldAllowSignup: true };
  }
}

// =============================================================================
// Response Builders
// =============================================================================

function buildSuccessResponse(
  requestId: string,
  data: Record<string, unknown>,
  startTime: number
): Response {
  const duration = Date.now() - startTime;

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
      "X-Version": VERSION,
      "X-Duration-Ms": duration.toString(),
    },
  });
}

function buildEmptySuccessResponse(requestId: string, startTime: number): Response {
  return buildSuccessResponse(requestId, {}, startTime);
}

// =============================================================================
// Main Handler
// =============================================================================

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // Health check endpoint
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        status: "healthy",
        service: SERVICE_NAME,
        version: VERSION,
        config: {
          enabled: config.enabled,
          hookSecretConfigured: !!config.hookSecret,
          circuitBreakerState: circuitBreaker.state,
        },
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  logTelemetry(createTelemetryEvent(requestId, "hook.invoked"));

  // Check if feature is enabled
  if (!config.enabled) {
    logTelemetry(createTelemetryEvent(requestId, "hook.disabled"));
    return buildEmptySuccessResponse(requestId, startTime);
  }

  try {
    const rawPayload = await req.text();
    const headers = Object.fromEntries(req.headers);

    // Verify webhook
    const verification = verifyWebhook(rawPayload, headers, requestId);

    // If verification failed but we should still allow signup
    if (!verification.success) {
      if (!verification.shouldAllowSignup) {
        // Strict mode: block on verification failure
        logTelemetry({
          ...createTelemetryEvent(requestId, "hook.blocked"),
          success: false,
          error: verification.error,
          durationMs: Date.now() - startTime,
        });

        return new Response(
          JSON.stringify({
            error: {
              message: "Webhook verification failed",
              http_code: 401,
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // Graceful mode: allow signup without geolocation
      logTelemetry({
        ...createTelemetryEvent(requestId, "hook.degraded"),
        success: true,
        metadata: { reason: "verification_failed_graceful" },
        durationMs: Date.now() - startTime,
      });

      return buildEmptySuccessResponse(requestId, startTime);
    }

    const event = verification.payload!;
    const ipAddress = event.metadata?.ip_address;
    const userId = event.user?.id;

    if (config.debugMode) {
      console.log(`[${requestId}] Processing user ${userId?.substring(0, 8)}... with IP: ${ipAddress?.substring(0, 8)}...`);
    }

    // If no IP address, just allow signup
    if (!ipAddress) {
      logTelemetry({
        ...createTelemetryEvent(requestId, "hook.success"),
        success: true,
        metadata: { reason: "no_ip_address" },
        durationMs: Date.now() - startTime,
      });

      return buildEmptySuccessResponse(requestId, startTime);
    }

    // Get geolocation from IP
    const location = await getLocationFromIP(ipAddress, requestId);

    if (location) {
      const responseData = {
        user_metadata: {
          signup_location: {
            latitude: location.latitude,
            longitude: location.longitude,
            city: location.city,
            region: location.region,
            country: location.country,
            country_code: location.countryCode,
            source: "ip_geolocation",
            captured_at: new Date().toISOString(),
          },
        },
      };

      logTelemetry({
        ...createTelemetryEvent(requestId, "hook.success"),
        success: true,
        metadata: {
          hasLocation: true,
          country: location.countryCode,
        },
        durationMs: Date.now() - startTime,
      });

      return buildSuccessResponse(requestId, responseData, startTime);
    }

    // No location found, but allow signup
    logTelemetry({
      ...createTelemetryEvent(requestId, "hook.success"),
      success: true,
      metadata: { hasLocation: false },
      durationMs: Date.now() - startTime,
    });

    return buildEmptySuccessResponse(requestId, startTime);

  } catch (error) {
    // CRITICAL: Never block signup on unexpected errors
    logTelemetry({
      ...createTelemetryEvent(requestId, "hook.error"),
      success: false,
      error: String(error),
      durationMs: Date.now() - startTime,
    });

    // Always return success to allow signup
    return buildEmptySuccessResponse(requestId, startTime);
  }
});
