/**
 * Unified Geocoding API v1
 *
 * Enterprise-grade geocoding API consolidating ALL geocoding operations:
 * - Profile/Address: Geocode user addresses and update coordinates
 * - Posts: Geocode post addresses and update locations
 * - Queue: Batch processing with queue management
 * - Signup Location: IP geolocation webhook for user signups
 *
 * Routes:
 * - GET    /health              - Health check
 * - POST   /address             - Geocode and update user address (replaces update-coordinates)
 * - POST   /post                - Geocode single post address
 * - POST   /post/batch          - Batch process posts from queue
 * - GET    /post/stats          - Get queue statistics
 * - POST   /post/cleanup        - Cleanup old queue entries
 * - POST   /geocode             - Geocode an address without updating DB
 * - POST   /signup-location     - Before User Created webhook (IP geolocation)
 * - GET    /signup-location     - Signup location health sub-check
 *
 * @module api-v1-geocoding
 * @version 1.2.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { parseRoute } from "../_shared/routing.ts";
import { AppError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { geocodeAddress, getCacheStats, type Coordinates } from "../_shared/geocoding.ts";

const VERSION = "1.2.0";
const SERVICE = "api-v1-geocoding";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  apiDelay: 1000, // Nominatim rate limit
  defaultBatchSize: 10,
};

// =============================================================================
// Signup Location Configuration (Before User Created webhook)
// =============================================================================

const SIGNUP_LOCATION_CONFIG = {
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

interface WebhookVerificationResult {
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

const ipApiCircuitBreaker: IpApiCircuitBreakerState = {
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

async function getLocationFromIP(
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

function verifySignupWebhook(
  rawPayload: string,
  headers: Record<string, string>,
  requestId: string,
): WebhookVerificationResult {
  if (!SIGNUP_LOCATION_CONFIG.hookSecret) {
    logger.warn("Running without webhook verification — configure BEFORE_USER_CREATED_HOOK_SECRET for production", {
      requestId,
    });

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
// Signup Location: Handler
// =============================================================================

async function handleSignupLocation(
  req: Request,
  corsHeaders: Record<string, string>,
  requestId: string,
): Promise<Response> {
  const startTime = Date.now();

  // Health sub-check for GET
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      status: "healthy",
      feature: "signup-location",
      enabled: SIGNUP_LOCATION_CONFIG.enabled,
      hookSecretConfigured: !!SIGNUP_LOCATION_CONFIG.hookSecret,
      circuitBreaker: ipApiCircuitBreaker.state,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  logger.info("Signup location hook invoked", { requestId });

  if (!SIGNUP_LOCATION_CONFIG.enabled) {
    logger.info("Signup location hook disabled", { requestId });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const rawPayload = await req.text();
    const headers = Object.fromEntries(req.headers);

    const verification = verifySignupWebhook(rawPayload, headers, requestId);

    if (!verification.success) {
      if (!verification.shouldAllowSignup) {
        logger.error("Signup blocked by webhook verification", {
          requestId,
          error: verification.error,
          durationMs: Date.now() - startTime,
        });
        return new Response(JSON.stringify(
          { error: { message: "Webhook verification failed", http_code: 401 } }
        ), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      logger.info("Signup allowed despite verification failure (graceful degradation)", {
        requestId,
        durationMs: Date.now() - startTime,
      });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const event = verification.payload!;
    const ipAddress = event.metadata?.ip_address;

    if (!ipAddress) {
      logger.info("Signup location: no IP address in hook payload", {
        requestId,
        durationMs: Date.now() - startTime,
      });
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

      logger.info("Signup location captured", {
        requestId,
        country: location.countryCode,
        durationMs: Date.now() - startTime,
      });

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Signup location: no location found, allowing signup", {
      requestId,
      durationMs: Date.now() - startTime,
    });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    // CRITICAL: Never block signup on unexpected errors
    logger.error("Signup location hook error — allowing signup", {
      requestId,
      error: String(error),
      durationMs: Date.now() - startTime,
    });
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// =============================================================================
// Map Services Types
// =============================================================================

interface MapPreferencesRow {
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

interface MapInteractionEvent {
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

interface MapHotspot {
  hotspot_center: { coordinates: [number, number] };
  interaction_count: number;
  avg_zoom: number;
  primary_time_of_day: number;
  confidence_score: number;
}

// =============================================================================
// Map Services: Auth Helper
// =============================================================================

async function getAuthenticatedUser(
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

function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: string,
  corsHeaders: Record<string, string>,
  status = 400,
  requestId?: string
): Response {
  return jsonResponse({ success: false, error, requestId }, corsHeaders, status);
}

// =============================================================================
// Map Services: Handlers
// =============================================================================

async function handleMapPreferencesGet(
  req: Request,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || "web";
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("user_map_preferences")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", platform)
    .single();

  if (error && error.code !== "PGRST116") {
    logger.error("Failed to get map preferences", { requestId, error: error.message });
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  return jsonResponse({
    success: true,
    preferences: (data as MapPreferencesRow | null) ?? null,
    source: "database",
  }, corsHeaders);
}

async function handleMapPreferencesSave(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const { center, zoom, mapStyle, searchRadius, platform, deviceId } =
    body as Record<string, unknown>;

  if (!center || typeof center !== "object") {
    return errorResponse("Missing or invalid center", corsHeaders, 400, requestId);
  }

  const { lat, lng } = center as { lat: number; lng: number };

  const preferences = {
    user_id: userId,
    platform: (platform as string) || "web",
    device_id: (deviceId as string) || null,
    last_center_lat: lat,
    last_center_lng: lng,
    last_zoom_level: zoom as number,
    map_style: (mapStyle as string) || "standard",
    search_radius_km: (searchRadius as number) || 10.0,
  };

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("user_map_preferences")
    .upsert(preferences, { onConflict: "user_id,platform,device_id" })
    .select()
    .single();

  if (error) {
    logger.error("Failed to save map preferences", { requestId, error: error.message });
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  logger.info("Map preferences saved", { requestId, userId: userId.substring(0, 8), platform: preferences.platform });

  return jsonResponse({ success: true, data }, corsHeaders);
}

async function handleMapAnalyticsTrack(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const analytics = body as Record<string, unknown>;
  const center = analytics.center as { lat: number; lng: number } | undefined;

  if (!center) {
    return errorResponse("Missing center", corsHeaders, 400, requestId);
  }

  const now = new Date();
  const event: MapInteractionEvent = {
    user_id: userId,
    center_lat: center.lat,
    center_lng: center.lng,
    zoom_level: analytics.zoom as number,
    platform: (analytics.platform as string) || "web",
    device_id: (analytics.deviceId as string) || null,
    session_id: (analytics.sessionId as string) || null,
    time_of_day: now.getHours(),
    day_of_week: now.getDay(),
    duration_seconds: (analytics.durationSeconds as number) || 0,
    interaction_type: (analytics.interactionType as string) || "view",
  };

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("map_interaction_events").insert(event);

  if (error) {
    logger.error("Failed to track map analytics", { requestId, error: error.message });
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }

  return jsonResponse({ success: true }, corsHeaders);
}

async function handleMapAnalyticsHotspots(
  req: Request,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const radius = parseInt(url.searchParams.get("radius") || "1000", 10);
  const minInteractions = parseInt(url.searchParams.get("min_interactions") || "5", 10);

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("detect_map_hotspots", {
    p_user_id: userId,
    p_radius_meters: radius,
    p_min_interactions: minInteractions,
  });

  if (error) {
    logger.error("Failed to detect map hotspots", { requestId, error: error.message });
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  const hotspots = ((data as MapHotspot[]) || []).map((row) => ({
    center: {
      lat: row.hotspot_center.coordinates[1],
      lng: row.hotspot_center.coordinates[0],
    },
    interactionCount: row.interaction_count,
    avgZoom: row.avg_zoom,
    primaryTimeOfDay: row.primary_time_of_day,
    confidenceScore: row.confidence_score,
  }));

  return jsonResponse({
    success: true,
    hotspots,
    predictedCenter: hotspots[0]?.center || null,
  }, corsHeaders);
}

async function handleMapQualityUpdate(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const { bandwidth, latency, connectionType, deviceInfo } =
    body as Record<string, unknown>;

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("update_network_profile", {
    p_user_id: userId,
    p_bandwidth_mbps: bandwidth as number,
    p_latency_ms: latency as number,
    p_connection_type: connectionType as string,
    p_device_info: deviceInfo,
  });

  if (error) {
    logger.error("Failed to update network profile", { requestId, error: error.message });
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  return jsonResponse({ success: true, settings: data }, corsHeaders);
}

async function handleMapQualityGet(
  corsHeaders: Record<string, string>,
  _requestId: string,
  userId: string,
): Promise<Response> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("user_network_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error) {
    // Return default settings for new users
    return jsonResponse({
      success: true,
      settings: {
        quality: "medium",
        retina: true,
        vector: true,
        concurrent_tiles: 6,
        compression: "medium",
      },
    }, corsHeaders);
  }

  const profile = data as {
    preferred_tile_quality: string;
    enable_retina: boolean;
    enable_vector_tiles: boolean;
    max_concurrent_tiles: number;
    avg_bandwidth_mbps: number;
  };

  return jsonResponse({
    success: true,
    settings: {
      quality: profile.preferred_tile_quality,
      retina: profile.enable_retina,
      vector: profile.enable_vector_tiles,
      concurrent_tiles: profile.max_concurrent_tiles,
      compression: profile.avg_bandwidth_mbps < 2 ? "high" :
                   profile.avg_bandwidth_mbps < 10 ? "medium" : "low",
    },
  }, corsHeaders);
}

async function handleMapPreload(
  _req: Request,
  corsHeaders: Record<string, string>,
  _requestId: string,
  userId: string,
): Promise<Response> {
  const supabase = getSupabaseClient();

  // Get user's network profile for adaptive settings
  const { data: profile } = await supabase
    .from("user_network_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  const networkProfile = profile as {
    max_concurrent_tiles?: number;
    preferred_tile_quality?: string;
    avg_bandwidth_mbps?: number;
  } | null;

  const maxTiles = networkProfile?.max_concurrent_tiles || 6;
  const quality = networkProfile?.preferred_tile_quality || "medium";

  const { data: hotspots } = await supabase.rpc("detect_map_hotspots", {
    p_user_id: userId,
    p_radius_meters: 2000,
    p_min_interactions: 3,
  });

  if (!hotspots?.length) {
    return jsonResponse({ success: true, preloadUrls: [] }, corsHeaders);
  }

  const preloadUrls: { url: string; priority: number; quality: string }[] = [];
  const currentHour = new Date().getHours();

  for (const hotspot of (hotspots as MapHotspot[]).slice(0, 2)) {
    const center = {
      lat: hotspot.hotspot_center.coordinates[1],
      lng: hotspot.hotspot_center.coordinates[0],
    };

    const timeRelevance = 1 - Math.abs(hotspot.primary_time_of_day - currentHour) / 12;
    const priority = hotspot.confidence_score * timeRelevance;

    if (priority > 0.3) {
      const radius = (networkProfile?.avg_bandwidth_mbps ?? 0) > 10 ? 2 : 1;
      const tileUrls = generateTileUrls(center, hotspot.avg_zoom, radius);
      preloadUrls.push(...tileUrls.map((url) => ({ url, priority, quality })));
    }
  }

  const limitedUrls = preloadUrls
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxTiles);

  return jsonResponse({
    success: true,
    preloadUrls: limitedUrls,
    quality,
    maxTiles,
  }, corsHeaders);
}

function generateTileUrls(
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
// Match Users: Schema & Types (consolidated from match-users/)
// =============================================================================

const matchUsersSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  dietaryPreferences: z.array(z.string()).default([]),
  radiusKm: z.number().min(1).max(1000).default(10),
  limit: z.number().int().min(1).max(50).default(20),
});

interface UserMatch {
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
// Match Users: Handler
// =============================================================================

async function handleMatchUsers(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string,
  userId: string,
): Promise<Response> {
  const parsed = matchUsersSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, corsHeaders, 400, requestId);
  }

  const { latitude, longitude, dietaryPreferences, radiusKm, limit } = parsed.data;
  const supabase = getSupabaseClient();

  const { data: matches, error: rpcError } = await supabase.rpc(
    "calculate_user_matches",
    {
      p_user_id: userId,
      p_latitude: latitude,
      p_longitude: longitude,
      p_dietary_preferences: dietaryPreferences,
      p_radius_km: radiusKm,
      p_limit: limit,
    },
  );

  if (rpcError) {
    logger.error("RPC error calculating user matches", new Error(rpcError.message));
    return errorResponse("Failed to calculate matches", corsHeaders, 500, requestId);
  }

  const formattedMatches: UserMatch[] = (matches || []).map((match: Record<string, unknown>) => ({
    userId: match.user_id as string,
    username: match.username as string,
    avatarUrl: match.avatar_url as string | null,
    distanceKm: Number(match.distance_km),
    compatibilityScore: match.compatibility_score as number,
    distanceScore: match.distance_score as number,
    activityScore: match.activity_score as number,
    ratingScore: match.rating_score as number,
    prefsScore: match.prefs_score as number,
    sharedItemsCount: Number(match.shared_items_count),
    ratingAverage: Number(match.rating_average),
    commonPreferences: (match.common_preferences as string[]) || [],
  }));

  return jsonResponse({
    success: true,
    matches: formattedMatches,
    totalMatches: formattedMatches.length,
    userLocation: { latitude, longitude },
    radiusKm,
  }, corsHeaders);
}

// =============================================================================
// Request Schemas
// =============================================================================

// Safely coerce string coordinates to numbers without z.coerce.number() which
// silently turns null → 0 and "" → 0. Accepts numbers, numeric strings, null, undefined.
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

const updateAddressSchema = z.object({
  address: addressSchema,
});

const singlePostSchema = z.object({
  id: z.number(),
  post_address: z.string(),
});

const batchPostSchema = z.object({
  batch_size: z.number().optional(),
});

const cleanupSchema = z.object({
  days_old: z.number().optional(),
});

const geocodeOnlySchema = z.object({
  address: z.string(),
});

// =============================================================================
// Delay Helper
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Address Handler (Profile Geocoding)
// =============================================================================

interface AddressUpdateResult {
  profile_id: string;
  status: "updated" | "unchanged" | "not_found" | "error";
  address?: string;
  message?: string;
  error?: string;
  oldCoordinates?: { lat: number; long: number };
  newCoordinates?: { lat: number; long: number };
}

async function handleAddressUpdate(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = updateAddressSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, corsHeaders, 400, requestId);
  }

  const { address } = parsed.data;
  const supabase = getSupabaseClient();

  logger.info("Updating address coordinates", {
    profileId: address.profile_id.substring(0, 8),
    requestId,
  });

  if (!address.generated_full_address) {
    const result: AddressUpdateResult = {
      profile_id: address.profile_id,
      status: "error",
      message: "No generated_full_address available",
    };
    return jsonResponse(result, corsHeaders);
  }

  const coordinates = await geocodeAddress(address.generated_full_address);

  if (!coordinates) {
    const result: AddressUpdateResult = {
      profile_id: address.profile_id,
      status: "not_found",
      address: address.generated_full_address,
      message: "Nominatim could not find coordinates for this address",
    };
    return jsonResponse(result, corsHeaders);
  }

  const { latitude: lat, longitude: lon } = coordinates;

  // Check if coordinates have changed
  if (lat === address.lat && lon === address.long) {
    const result: AddressUpdateResult = {
      profile_id: address.profile_id,
      status: "unchanged",
      address: address.generated_full_address,
      newCoordinates: { lat, long: lon },
    };
    return jsonResponse(result, corsHeaders);
  }

  // Update the coordinates
  const { error: updateError } = await supabase
    .from("address")
    .update({ lat, long: lon })
    .eq("profile_id", address.profile_id);

  if (updateError) {
    logger.error("Failed to update coordinates", { error: updateError.message });
    const result: AddressUpdateResult = {
      profile_id: address.profile_id,
      status: "error",
      error: updateError.message,
    };
    return jsonResponse(result, corsHeaders);
  }

  logger.info("Coordinates updated successfully", {
    profileId: address.profile_id.substring(0, 8),
    lat,
    lon,
  });

  const result: AddressUpdateResult = {
    profile_id: address.profile_id,
    status: "updated",
    address: address.generated_full_address,
    oldCoordinates: address.lat != null && address.long != null
      ? { lat: address.lat, long: address.long }
      : undefined,
    newCoordinates: { lat, long: lon },
  };

  return jsonResponse(result, corsHeaders);
}

// =============================================================================
// Post Queue Processing
// =============================================================================

interface QueueItem {
  id: number;
  post_id: number;
  post_address: string;
  retry_count: number;
}

interface ProcessResult {
  queue_id: number;
  post_id: number;
  success: boolean;
  reason?: string;
  coordinates?: Coordinates;
}

interface QueueStats {
  pending: number;
  processing: number;
  failed_retryable: number;
  failed_permanent: number;
  completed_today: number;
}

async function processQueueItem(
  supabase: ReturnType<typeof getSupabaseClient>,
  queueItem: QueueItem
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

async function handlePostBatch(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = batchPostSchema.safeParse(body || {});
  const batchSize = parsed.success ? parsed.data.batch_size || CONFIG.defaultBatchSize : CONFIG.defaultBatchSize;

  const supabase = getSupabaseClient();

  logger.info("Starting batch processing", { batchSize, requestId });

  const { data: queueItems, error: fetchError } = await supabase.rpc(
    "get_pending_geocode_queue",
    { batch_size: batchSize }
  );

  if (fetchError) {
    return errorResponse(`Failed to fetch queue: ${fetchError.message}`, corsHeaders, 500, requestId);
  }

  if (!queueItems || queueItems.length === 0) {
    return jsonResponse({
      message: "No items to process",
      processed: 0,
      successful: 0,
      failed: 0,
      results: [],
    }, corsHeaders);
  }

  const results: ProcessResult[] = [];
  let successful = 0;
  let failed = 0;

  for (const item of queueItems) {
    try {
      const result = await processQueueItem(supabase, item as QueueItem);
      results.push(result);
      if (result.success) successful++;
      else failed++;
      await delay(CONFIG.apiDelay);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.push({
        queue_id: item.id,
        post_id: item.post_id,
        success: false,
        reason: errorMessage,
      });
      failed++;
      await delay(CONFIG.apiDelay);
    }
  }

  return jsonResponse({
    message: `Processed ${queueItems.length} items: ${successful} successful, ${failed} failed`,
    processed: queueItems.length,
    successful,
    failed,
    results,
  }, corsHeaders);
}

async function handleSinglePost(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = singlePostSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, corsHeaders, 400, requestId);
  }

  const { id, post_address } = parsed.data;
  const supabase = getSupabaseClient();

  if (!post_address.trim()) {
    return jsonResponse({
      post_id: id,
      success: false,
      reason: "No address provided",
    }, corsHeaders);
  }

  const coordinates = await geocodeAddress(post_address);

  if (!coordinates) {
    return jsonResponse({
      post_id: id,
      success: false,
      reason: "No coordinates found",
    }, corsHeaders);
  }

  const { error } = await supabase
    .from("posts")
    .update({
      location: `SRID=4326;POINT(${coordinates.longitude} ${coordinates.latitude})`,
    })
    .eq("id", id);

  if (error) {
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  return jsonResponse({
    post_id: id,
    success: true,
    coordinates,
  }, corsHeaders);
}

async function handlePostStats(corsHeaders: Record<string, string>): Promise<Response> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("location_update_queue")
    .select("status, retry_count, max_retries, completed_at");

  if (error) {
    return errorResponse(error.message, corsHeaders, 500);
  }

  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    failed_retryable: 0,
    failed_permanent: 0,
    completed_today: 0,
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const item of data || []) {
    if (item.status === "pending") stats.pending++;
    else if (item.status === "processing") stats.processing++;
    else if (item.status === "failed") {
      if (item.retry_count < item.max_retries) stats.failed_retryable++;
      else stats.failed_permanent++;
    } else if (item.status === "completed" && item.completed_at) {
      if (new Date(item.completed_at) >= today) stats.completed_today++;
    }
  }

  return jsonResponse({ message: "Queue statistics", stats }, corsHeaders);
}

async function handlePostCleanup(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = cleanupSchema.safeParse(body || {});
  const daysOld = parsed.success ? parsed.data.days_old || 30 : 30;

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("cleanup_old_geocode_queue", {
    days_old: daysOld,
  });

  if (error) {
    return errorResponse(error.message, corsHeaders, 500, requestId);
  }

  return jsonResponse({
    message: `Cleaned up ${data || 0} old queue entries`,
    deleted: data || 0,
  }, corsHeaders);
}

async function handleGeocodeOnly(
  body: unknown,
  corsHeaders: Record<string, string>,
  requestId: string
): Promise<Response> {
  const parsed = geocodeOnlySchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, corsHeaders, 400, requestId);
  }

  const coordinates = await geocodeAddress(parsed.data.address);

  if (!coordinates) {
    return jsonResponse({
      success: false,
      address: parsed.data.address,
      message: "No coordinates found for this address",
    }, corsHeaders);
  }

  return jsonResponse({
    success: true,
    address: parsed.data.address,
    coordinates,
  }, corsHeaders);
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);
  const corsHeaders = ctx.corsHeaders;
  const requestId = ctx.ctx.requestId;

  // Health check
  if (route.resource === "health" || route.resource === "") {
    return ok({
      status: "healthy",
      version: VERSION,
      service: SERVICE,
      timestamp: new Date().toISOString(),
      endpoints: [
        "address", "post", "post/batch", "post/stats", "post/cleanup",
        "geocode", "signup-location", "match",
        "map/preferences", "map/analytics", "map/quality", "map/preload",
      ],
      cacheStats: getCacheStats(),
      signupLocation: {
        enabled: SIGNUP_LOCATION_CONFIG.enabled,
        hookSecretConfigured: !!SIGNUP_LOCATION_CONFIG.hookSecret,
        circuitBreaker: ipApiCircuitBreaker.state,
      },
    }, ctx);
  }

  // Signup location health sub-check (GET)
  if (route.resource === "signup-location") {
    return handleSignupLocation(ctx.request, corsHeaders, requestId);
  }

  // Post stats (GET)
  if (route.resource === "post" && route.subPath === "stats") {
    return handlePostStats(corsHeaders);
  }

  // Map services (GET)
  if (route.resource === "map") {
    const user = await getAuthenticatedUser(ctx.request, requestId);
    if (!user) {
      return errorResponse("Unauthorized", corsHeaders, 401, requestId);
    }

    switch (route.subPath) {
      case "preferences":
        return handleMapPreferencesGet(ctx.request, corsHeaders, requestId, user.id);
      case "analytics":
        return handleMapAnalyticsHotspots(ctx.request, corsHeaders, requestId, user.id);
      case "quality":
        return handleMapQualityGet(corsHeaders, requestId, user.id);
      case "preload":
        return handleMapPreload(ctx.request, corsHeaders, requestId, user.id);
      default:
        throw new AppError("Unknown map route", "NOT_FOUND", 404);
    }
  }

  throw new AppError("Not found", "NOT_FOUND", 404);
}

async function handlePost(ctx: HandlerContext): Promise<Response> {
  const route = parseRoute(new URL(ctx.request.url), ctx.request.method, SERVICE);
  const corsHeaders = ctx.corsHeaders;
  const requestId = ctx.ctx.requestId;

  // Signup location webhook (Before User Created hook)
  // Must be before body parsing since the webhook reads raw text
  if (route.resource === "signup-location") {
    return handleSignupLocation(ctx.request, corsHeaders, requestId);
  }

  // Match users (nearby users with compatibility scoring)
  if (route.resource === "match") {
    const user = await getAuthenticatedUser(ctx.request, requestId);
    if (!user) {
      return errorResponse("Unauthorized", corsHeaders, 401, requestId);
    }
    const matchBody = ctx.body;
    return handleMatchUsers(matchBody, corsHeaders, requestId, user.id);
  }

  // Map services (POST)
  if (route.resource === "map") {
    const user = await getAuthenticatedUser(ctx.request, requestId);
    if (!user) {
      return errorResponse("Unauthorized", corsHeaders, 401, requestId);
    }

    const mapBody = ctx.body;

    switch (route.subPath) {
      case "preferences":
        return handleMapPreferencesSave(mapBody, corsHeaders, requestId, user.id);
      case "analytics":
        return handleMapAnalyticsTrack(mapBody, corsHeaders, requestId, user.id);
      case "quality":
        return handleMapQualityUpdate(mapBody, corsHeaders, requestId, user.id);
      default:
        throw new AppError("Unknown map route", "NOT_FOUND", 404);
    }
  }

  // Parse body for remaining POST routes (body already parsed by createAPIHandler)
  const body = ctx.body;

  // Address geocoding (profile)
  if (route.resource === "address") {
    return handleAddressUpdate(body, corsHeaders, requestId);
  }

  // Post geocoding routes
  if (route.resource === "post") {
    if (route.subPath === "batch") {
      return handlePostBatch(body, corsHeaders, requestId);
    }
    if (route.subPath === "cleanup") {
      return handlePostCleanup(body, corsHeaders, requestId);
    }
    if (!route.subPath) {
      return handleSinglePost(body, corsHeaders, requestId);
    }
  }

  // Geocode only (no DB update)
  if (route.resource === "geocode") {
    return handleGeocodeOnly(body, corsHeaders, requestId);
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
  routes: {
    GET: { handler: handleGet },
    POST: { handler: handlePost },
  },
}));
