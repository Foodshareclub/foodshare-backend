/**
 * Unified Geocoding API v1
 *
 * Enterprise-grade geocoding API consolidating ALL geocoding operations:
 * - Profile/Address: Geocode user addresses and update coordinates
 * - Posts: Geocode post addresses and update locations
 * - Queue: Batch processing with queue management
 *
 * Routes:
 * - GET    /health           - Health check
 * - POST   /address          - Geocode and update user address (replaces update-coordinates)
 * - POST   /post             - Geocode single post address
 * - POST   /post/batch       - Batch process posts from queue
 * - GET    /post/stats       - Get queue statistics
 * - POST   /post/cleanup     - Cleanup old queue entries
 * - POST   /geocode          - Geocode an address without updating DB
 *
 * @module api-v1-geocoding
 * @version 1.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { geocodeAddress, type Coordinates } from "../_shared/geocoding.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-geocoding";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  nominatimBaseUrl: "https://nominatim.openstreetmap.org/search",
  userAgent: "Foodshare/2.0 (https://foodshare.club)",
  cacheTTL: 86400000, // 24 hours
  maxRetries: 3,
  initialRetryDelay: 1000,
  apiDelay: 1000, // Nominatim rate limit
  defaultBatchSize: 10,
};

// =============================================================================
// In-Memory Cache
// =============================================================================

const geocodeCache = new Map<
  string,
  { lat: string; lon: string; timestamp: number }
>();

// =============================================================================
// Request Schemas
// =============================================================================

const addressSchema = z.object({
  profile_id: z.string(),
  generated_full_address: z.string().optional(),
  lat: z.string().optional().nullable(),
  long: z.string().optional().nullable(),
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
// Route Parser
// =============================================================================

interface ParsedRoute {
  resource: string;
  subPath: string;
  method: string;
}

function parseRoute(url: URL, method: string): ParsedRoute {
  const path = url.pathname
    .replace(/^\/api-v1-geocoding\/?/, "")
    .replace(/^\/*/, "");

  const segments = path.split("/").filter(Boolean);
  const resource = segments[0] || "";
  const subPath = segments[1] || "";

  return { resource, subPath, method };
}

// =============================================================================
// Delay Helper
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Geocoding Helpers (inline for address function, uses shared for posts)
// =============================================================================

async function fetchWithRetry(
  url: string,
  maxRetries = CONFIG.maxRetries,
  initialDelay = CONFIG.initialRetryDelay
): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": CONFIG.userAgent },
      });

      if (response.ok) return response;

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : initialDelay * Math.pow(2, i);
        logger.warn("Rate limited by Nominatim", { delayMs, attempt: i + 1 });
        await delay(delayMs);
        continue;
      }

      throw new Error(`HTTP error! status: ${response.status}`);
    } catch (err) {
      logger.error("Geocoding attempt failed", {
        attempt: i + 1,
        error: err instanceof Error ? err.message : "Unknown",
      });
      if (i === maxRetries - 1) throw err;
    }

    const delayMs = initialDelay * Math.pow(2, i);
    await delay(delayMs);
  }

  throw new Error(`Failed to fetch after ${maxRetries} retries`);
}

async function geocodeAddressInternal(
  addressString: string
): Promise<{ lat: string; lon: string } | null> {
  // Check cache first
  const cached = geocodeCache.get(addressString);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
    logger.info("Cache hit for geocoding");
    return { lat: cached.lat, lon: cached.lon };
  }

  const encodedAddress = encodeURIComponent(addressString);
  const url = `${CONFIG.nominatimBaseUrl}?q=${encodedAddress}&format=json&addressdetails=1&limit=1`;

  try {
    const response = await fetchWithRetry(url);
    const contentType = response.headers.get("content-type");

    if (!contentType || !contentType.includes("application/json")) {
      logger.error("Received non-JSON response from Nominatim");
      return null;
    }

    const result = await response.json();

    if (!result || result.length === 0) {
      return null;
    }

    const { lat, lon } = result[0];

    // Cache the result
    geocodeCache.set(addressString, { lat, lon, timestamp: Date.now() });

    return { lat, lon };
  } catch (error) {
    logger.error("Error querying Nominatim API", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return null;
  }
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
  oldCoordinates?: { lat: string; long: string };
  newCoordinates?: { lat: string; long: string };
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

  const geocodeData = await geocodeAddressInternal(address.generated_full_address);

  if (!geocodeData) {
    const result: AddressUpdateResult = {
      profile_id: address.profile_id,
      status: "not_found",
      address: address.generated_full_address,
      message: "Nominatim could not find coordinates for this address",
    };
    return jsonResponse(result, corsHeaders);
  }

  const { lat, lon } = geocodeData;

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
    oldCoordinates: address.lat && address.long
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

  const coordinates = await geocodeAddressInternal(parsed.data.address);

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
    coordinates: {
      latitude: parseFloat(coordinates.lat),
      longitude: parseFloat(coordinates.lon),
    },
  }, corsHeaders);
}

// =============================================================================
// Main Router
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const requestId = crypto.randomUUID();
  const corsHeaders = getCorsHeaders(req);
  const url = new URL(req.url);
  const route = parseRoute(url, req.method);

  try {
    // Health check
    if (route.resource === "health" || route.resource === "") {
      return jsonResponse({
        status: "healthy",
        version: VERSION,
        service: SERVICE,
        timestamp: new Date().toISOString(),
        endpoints: ["address", "post", "post/batch", "post/stats", "post/cleanup", "geocode"],
        cacheStats: {
          size: geocodeCache.size,
          ttlMs: CONFIG.cacheTTL,
        },
      }, corsHeaders);
    }

    // Parse body for POST requests
    let body: unknown = null;
    if (req.method === "POST") {
      body = await req.json().catch(() => ({}));
    }

    // Address geocoding (profile)
    if (route.resource === "address" && req.method === "POST") {
      return handleAddressUpdate(body, corsHeaders, requestId);
    }

    // Post geocoding routes
    if (route.resource === "post") {
      if (route.subPath === "batch" && req.method === "POST") {
        return handlePostBatch(body, corsHeaders, requestId);
      }
      if (route.subPath === "stats" && req.method === "GET") {
        return handlePostStats(corsHeaders);
      }
      if (route.subPath === "cleanup" && req.method === "POST") {
        return handlePostCleanup(body, corsHeaders, requestId);
      }
      if (!route.subPath && req.method === "POST") {
        return handleSinglePost(body, corsHeaders, requestId);
      }
    }

    // Geocode only (no DB update)
    if (route.resource === "geocode" && req.method === "POST") {
      return handleGeocodeOnly(body, corsHeaders, requestId);
    }

    return errorResponse("Not found", corsHeaders, 404, requestId);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Geocoding request failed", err, { requestId, path: url.pathname });

    return jsonResponse({
      success: false,
      error: err.message,
      requestId,
    }, corsHeaders, 500);
  }
});
