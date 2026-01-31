/**
 * Update Coordinates Edge Function
 *
 * Geocodes user addresses using Nominatim API and updates coordinates.
 *
 * Features:
 * - Geocoding with retry and exponential backoff
 * - Rate limiting respect for Nominatim API
 * - In-memory geocoding cache
 *
 * Usage:
 * POST /update-coordinates
 * { "address": { "profile_id": "xxx", "generated_full_address": "..." } }
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  nominatimBaseUrl: "https://nominatim.openstreetmap.org/search",
  userAgent: "Foodshare/2.0 (https://foodshare.club)",
  cacheTTL: 86400000, // 24 hours
  maxRetries: 3,
  initialRetryDelay: 1000,
};

// =============================================================================
// In-Memory Cache
// =============================================================================

const geocodeCache = new Map<
  string,
  {
    lat: string;
    lon: string;
    timestamp: number;
  }
>();

// =============================================================================
// Request Schema
// =============================================================================

const addressSchema = z.object({
  profile_id: z.string(),
  generated_full_address: z.string().optional(),
  lat: z.string().optional().nullable(),
  long: z.string().optional().nullable(),
});

const updateCoordinatesSchema = z.object({
  address: addressSchema,
});

type UpdateCoordinatesRequest = z.infer<typeof updateCoordinatesSchema>;

// =============================================================================
// Response Types
// =============================================================================

interface UpdateResult {
  profile_id: string;
  status: "updated" | "unchanged" | "not_found" | "error";
  address?: string;
  message?: string;
  error?: string;
  oldCoordinates?: { lat: string; long: string };
  newCoordinates?: { lat: string; long: string };
}

// =============================================================================
// Geocoding Helpers
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function geocodeAddress(
  addressString: string
): Promise<{ lat: string; lon: string } | null> {
  logger.info("Geocoding address", { address: addressString.substring(0, 50) });

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
    geocodeCache.set(addressString, {
      lat,
      lon,
      timestamp: Date.now(),
    });

    return { lat, lon };
  } catch (error) {
    logger.error("Error querying Nominatim API", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    return null;
  }
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleUpdateCoordinates(
  ctx: HandlerContext<UpdateCoordinatesRequest>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx } = ctx;
  const { address } = body;

  logger.info("Updating coordinates", {
    profileId: address.profile_id.substring(0, 8),
    requestId: requestCtx?.requestId,
  });

  if (!address.generated_full_address) {
    const result: UpdateResult = {
      profile_id: address.profile_id,
      status: "error",
      message: "No generated_full_address available",
    };
    return ok(result, ctx);
  }

  // Geocode the address
  const geocodeData = await geocodeAddress(address.generated_full_address);

  if (!geocodeData) {
    const result: UpdateResult = {
      profile_id: address.profile_id,
      status: "not_found",
      address: address.generated_full_address,
      message: "Nominatim could not find coordinates for this address",
    };
    return ok(result, ctx);
  }

  const { lat, lon } = geocodeData;

  // Check if coordinates have changed
  if (lat === address.lat && lon === address.long) {
    const result: UpdateResult = {
      profile_id: address.profile_id,
      status: "unchanged",
      address: address.generated_full_address,
      newCoordinates: { lat, long: lon },
    };
    return ok(result, ctx);
  }

  // Update the coordinates
  const { error: updateError } = await supabase
    .from("address")
    .update({
      lat,
      long: lon,
    })
    .eq("profile_id", address.profile_id);

  if (updateError) {
    logger.error("Failed to update coordinates", {
      error: updateError.message,
      profileId: address.profile_id.substring(0, 8),
    });

    const result: UpdateResult = {
      profile_id: address.profile_id,
      status: "error",
      error: updateError.message,
    };
    return ok(result, ctx);
  }

  logger.info("Coordinates updated successfully", {
    profileId: address.profile_id.substring(0, 8),
    lat,
    lon,
  });

  const result: UpdateResult = {
    profile_id: address.profile_id,
    status: "updated",
    address: address.generated_full_address,
    oldCoordinates: address.lat && address.long
      ? { lat: address.lat, long: address.long }
      : undefined,
    newCoordinates: { lat, long: lon },
  };

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "update-coordinates",
  version: CONFIG.version,
  requireAuth: false, // Service-level operation
  routes: {
    POST: {
      schema: updateCoordinatesSchema,
      handler: handleUpdateCoordinates,
    },
  },
});
