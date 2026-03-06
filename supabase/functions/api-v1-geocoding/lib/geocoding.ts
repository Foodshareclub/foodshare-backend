/**
 * Core geocoding logic, types, configuration, and provider integrations.
 *
 * Contains:
 * - Configuration constants
 * - Type definitions (signup location, map services, match users, queue, schemas)
 * - Signup location: circuit breaker, IP validation, geolocation service, webhook verification
 * - Queue processing logic
 * - Map tile URL generation
 * - Response helpers
 *
 * @module api-v1-geocoding/lib/geocoding
 */

import { z } from "../../_shared/schemas/common.ts";
import { latitudeSchema, longitudeSchema } from "../../_shared/schemas/geo.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { logger } from "../../_shared/logger.ts";
import { type Coordinates, geocodeAddress } from "../../_shared/geocoding.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

// =============================================================================
// Configuration
// =============================================================================

export const VERSION = "1.2.0";
export const SERVICE = "api-v1-geocoding";

export const CONFIG = {
  apiDelay: 1000, // Nominatim rate limit
  defaultBatchSize: 10,
};

// =============================================================================
// Signup Location Configuration (Before User Created webhook)
// =============================================================================

export const SIGNUP_LOCATION_CONFIG = {
  hookSecret: Deno.env.get("BEFORE_USER_CREATED_HOOK_SECRET")?.replace("v1,whsec_", "") || null,
  enabled: Deno.env.get("GEOLOCATE_USER_ENABLED") !== "false",
  timeoutMs: (() => {
    const ms = parseInt(Deno.env.get("GEOLOCATE_TIMEOUT_MS") || "3000", 10);
    return isNaN(ms) ? 3000 : ms;
  })(),
  ipApiBaseUrl: "http://ip-api.com/json",
};

// =============================================================================
// Signup Location Types
// =============================================================================

export interface GeoLocation {
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

export interface HookPayload {
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

export interface WebhookVerificationResult {
  success: boolean;
  payload?: HookPayload;
  error?: string;
  shouldAllowSignup: boolean;
}

// =============================================================================
// Signup Location Circuit Breaker (ip-api.com)
// =============================================================================

interface IpApiCircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half-open";
}

export const ipApiCircuitBreaker: IpApiCircuitBreakerState = {
  failures: 0,
  lastFailure: 0,
  state: "closed",
};

const IP_API_CIRCUIT_FAILURE_THRESHOLD = 5;
const IP_API_CIRCUIT_RESET_TIMEOUT_MS = 30_000;

function isIpApiCircuitOpen(): boolean {
  if (ipApiCircuitBreaker.state === "open") {
    if (Date.now() - ipApiCircuitBreaker.lastFailure > IP_API_CIRCUIT_RESET_TIMEOUT_MS) {
      ipApiCircuitBreaker.state = "half-open";
      return false;
    }
    return true;
  }
  return false;
}

function recordIpApiSuccess(): void {
  if (ipApiCircuitBreaker.state === "half-open") {
    ipApiCircuitBreaker.state = "closed";
    ipApiCircuitBreaker.failures = 0;
  }
}

function recordIpApiFailure(): void {
  ipApiCircuitBreaker.failures++;
  ipApiCircuitBreaker.lastFailure = Date.now();
  if (ipApiCircuitBreaker.failures >= IP_API_CIRCUIT_FAILURE_THRESHOLD) {
    ipApiCircuitBreaker.state = "open";
  }
}

// =============================================================================
// Signup Location: IP Validation
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

// =============================================================================
// Signup Location: Geolocation Service
// =============================================================================

export async function getLocationFromIP(
  ipAddress: string,
  requestId: string,
): Promise<GeoLocation | null> {
  if (!ipAddress || isPrivateIP(ipAddress)) {
    logger.info("Geolocation skip", {
      requestId,
      reason: isPrivateIP(ipAddress) ? "private_ip" : "no_ip",
    });
    return null;
  }

  if (isIpApiCircuitOpen()) {
    logger.warn("ip-api circuit breaker open, skipping geolocation", { requestId });
    return null;
  }

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SIGNUP_LOCATION_CONFIG.timeoutMs);

    const response = await fetch(
      `${SIGNUP_LOCATION_CONFIG.ipApiBaseUrl}/${ipAddress}?fields=status,lat,lon,city,regionName,country,countryCode`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      recordIpApiFailure();
      logger.warn("ip-api HTTP error", {
        requestId,
        status: response.status,
        durationMs: Date.now() - startTime,
      });
      return null;
    }

    const data: IpApiResponse = await response.json();

    if (data.status !== "success" || !data.lat || !data.lon) {
      logger.info("ip-api: location not found", {
        requestId,
        apiStatus: data.status,
        message: data.message,
        durationMs: Date.now() - startTime,
      });
      return null;
    }

    recordIpApiSuccess();

    const location: GeoLocation = {
      latitude: data.lat,
      longitude: data.lon,
      city: data.city,
      region: data.regionName,
      country: data.country,
      countryCode: data.countryCode,
    };

    logger.info("Geolocation success", {
      requestId,
      country: location.countryCode,
      durationMs: Date.now() - startTime,
    });

    return location;
  } catch (error) {
    recordIpApiFailure();

    const isTimeout = error instanceof DOMException && error.name === "AbortError";
    logger.error("Geolocation error", {
      requestId,
      error: isTimeout ? "timeout" : String(error),
      durationMs: Date.now() - startTime,
    });

    return null;
  }
}

// =============================================================================
// Signup Location: Webhook Verification
// =============================================================================

export function verifySignupWebhook(
  rawPayload: string,
  headers: Record<string, string>,
  requestId: string,
): WebhookVerificationResult {
  if (!SIGNUP_LOCATION_CONFIG.hookSecret) {
    logger.warn(
      "Running without webhook verification — configure BEFORE_USER_CREATED_HOOK_SECRET for production",
      {
        requestId,
      },
    );

    try {
      const payload = JSON.parse(rawPayload) as HookPayload;
      return { success: true, payload, shouldAllowSignup: true };
    } catch {
      logger.warn("Signup webhook payload parse error (no secret configured)", { requestId });
      return { success: false, error: "Invalid payload format", shouldAllowSignup: true };
    }
  }

  try {
    const wh = new Webhook(SIGNUP_LOCATION_CONFIG.hookSecret);
    const payload = wh.verify(rawPayload, headers) as HookPayload;
    logger.info("Signup webhook verified", { requestId });
    return { success: true, payload, shouldAllowSignup: true };
  } catch (error) {
    const errorMessage = String(error);
    logger.warn("Signup webhook verification failed — allowing signup (graceful degradation)", {
      requestId,
      error: errorMessage,
    });
    return { success: false, error: errorMessage, shouldAllowSignup: true };
  }
}

// =============================================================================
// Map Services Types
// =============================================================================

export interface MapPreferencesRow {
  user_id: string;
  platform: string;
  device_id: string | null;
  last_center_lat: number;
  last_center_lng: number;
  last_zoom_level: number;
  map_style: string;
  search_radius_km: number;
  created_at: string;
  updated_at: string;
}

export interface MapInteractionEvent {
  user_id: string;
  center_lat: number;
  center_lng: number;
  zoom_level: number;
  platform: string;
  device_id: string | null;
  session_id: string | null;
  time_of_day: number;
  day_of_week: number;
  duration_seconds: number;
  interaction_type: string;
}

export interface MapHotspot {
  hotspot_center: { coordinates: [number, number] };
  interaction_count: number;
  avg_zoom: number;
  primary_time_of_day: number;
  confidence_score: number;
}

// =============================================================================
// Map Services: Auth Helper
// =============================================================================

export async function getAuthenticatedUser(
  req: Request,
  requestId: string,
): Promise<{ id: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    logger.warn("Map route: missing or invalid auth header", { requestId });
    return null;
  }

  const token = authHeader.replace("Bearer ", "");
  const supabase = getSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    logger.warn("Map route: auth failed", { requestId, error: error?.message });
    return null;
  }

  return { id: user.id };
}

// =============================================================================
// Response Helpers
// =============================================================================

export function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400,
  requestId?: string,
): Response {
  return jsonResponse({ success: false, error, requestId }, corsHeaders, status);
}

// =============================================================================
// Map Services: Tile URL Generation
// =============================================================================

export function generateTileUrls(
  center: { lat: number; lng: number },
  zoom: number,
  radius = 1,
): string[] {
  const urls: string[] = [];
  const z = Math.floor(zoom);
  const x = Math.floor(((center.lng + 180) / 360) * Math.pow(2, z));
  const latRad = center.lat * Math.PI / 180;
  const y = Math.floor(
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, z),
  );

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      urls.push(`https://tile.openstreetmap.org/${z}/${x + dx}/${y + dy}.png`);
    }
  }

  return urls;
}

// =============================================================================
// Match Users: Schema & Types
// =============================================================================

export const matchUsersSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  dietaryPreferences: z.array(z.string()).default([]),
  radiusKm: z.number().min(1).max(1000).default(10),
  limit: z.number().int().min(1).max(50).default(20),
});

export interface UserMatch {
  userId: string;
  username: string;
  avatarUrl: string | null;
  distanceKm: number;
  compatibilityScore: number;
  distanceScore: number;
  activityScore: number;
  ratingScore: number;
  prefsScore: number;
  sharedItemsCount: number;
  ratingAverage: number;
  commonPreferences: string[];
}

// =============================================================================
// Request Schemas
// =============================================================================

// Safely coerce string coordinates to numbers without z.coerce.number() which
// silently turns null -> 0 and "" -> 0. Accepts numbers, numeric strings, null, undefined.
const optionalCoordinate = z.preprocess(
  (val) => {
    if (val === undefined) return undefined;
    if (val === null || val === "") return null;
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const num = Number(val);
      return isNaN(num) ? val : num;
    }
    return val; // non-number/non-string types fall through for z.number() to reject
  },
  z.number().optional().nullable(),
);

const addressSchema = z.object({
  profile_id: z.string(),
  generated_full_address: z.string().optional(),
  lat: optionalCoordinate,
  long: optionalCoordinate,
});

export const updateAddressSchema = z.object({
  address: addressSchema,
});

export const singlePostSchema = z.object({
  id: z.number(),
  post_address: z.string(),
});

export const batchPostSchema = z.object({
  batch_size: z.number().optional(),
});

export const cleanupSchema = z.object({
  days_old: z.number().optional(),
});

export const geocodeOnlySchema = z.object({
  address: z.string(),
});

// =============================================================================
// Delay Helper
// =============================================================================

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Address Update Result Type
// =============================================================================

export interface AddressUpdateResult {
  profile_id: string;
  status: "updated" | "unchanged" | "not_found" | "error";
  address?: string;
  message?: string;
  error?: string;
  oldCoordinates?: { lat: number; long: number };
  newCoordinates?: { lat: number; long: number };
}

// =============================================================================
// Post Queue Types
// =============================================================================

export interface QueueItem {
  id: number;
  post_id: number;
  post_address: string;
  retry_count: number;
}

export interface ProcessResult {
  queue_id: number;
  post_id: number;
  success: boolean;
  reason?: string;
  coordinates?: Coordinates;
}

export interface QueueStats {
  pending: number;
  processing: number;
  failed_retryable: number;
  failed_permanent: number;
  completed_today: number;
}

// =============================================================================
// Queue Item Processing
// =============================================================================

export async function processQueueItem(
  supabase: ReturnType<typeof getSupabaseClient>,
  queueItem: QueueItem,
): Promise<ProcessResult> {
  logger.info("Processing queue item", {
    queueId: queueItem.id,
    postId: queueItem.post_id,
    attempt: queueItem.retry_count + 1,
  });

  try {
    const { error: markError } = await supabase.rpc("mark_geocode_processing", {
      queue_id: queueItem.id,
    });

    if (markError) throw markError;

    const coordinates = await geocodeAddress(queueItem.post_address);

    if (!coordinates) {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: "No coordinates found for address",
      });

      return {
        queue_id: queueItem.id,
        post_id: queueItem.post_id,
        success: false,
        reason: "No coordinates found",
      };
    }

    const { error: updateError } = await supabase
      .from("posts")
      .update({
        location: `SRID=4326;POINT(${coordinates.longitude} ${coordinates.latitude})`,
      })
      .eq("id", queueItem.post_id);

    if (updateError) {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: `Database update failed: ${updateError.message}`,
      });

      return {
        queue_id: queueItem.id,
        post_id: queueItem.post_id,
        success: false,
        reason: `Database error: ${updateError.message}`,
      };
    }

    await supabase.rpc("mark_geocode_completed", { queue_id: queueItem.id });

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: true,
      coordinates,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Error processing queue item", { queueId: queueItem.id, error: errorMessage });

    try {
      await supabase.rpc("mark_geocode_failed", {
        queue_id: queueItem.id,
        error_msg: errorMessage,
      });
    } catch {
      // Ignore marking failure
    }

    return {
      queue_id: queueItem.id,
      post_id: queueItem.post_id,
      success: false,
      reason: errorMessage,
    };
  }
}

// Re-export Coordinates type from shared geocoding
export type { Coordinates } from "../../_shared/geocoding.ts";
