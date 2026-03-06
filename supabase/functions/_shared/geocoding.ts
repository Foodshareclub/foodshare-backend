/**
 * Shared Geocoding Service
 * Used across multiple Edge Functions for consistent geocoding behavior
 */

import { CircuitBreakerError, withCircuitBreaker } from "./circuit-breaker.ts";
import { logger } from "./logger.ts";
import { getSupabaseClient } from "./supabase.ts";

// Types
export interface Coordinates {
  latitude: number;
  longitude: number;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name?: string;
  address?: Record<string, string>;
}

interface CacheEntry {
  coordinates: Coordinates;
  timestamp: number;
}

// Configuration
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "FoodShare/1.0 (contact@foodshare.com)";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RATE_LIMIT_DELAY_MS = 1000; // Nominatim requires 1 request per second
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds
const MAX_RETRIES = 3;

// In-memory cache (bounded to prevent OOM)
const MAX_GEOCODE_CACHE_SIZE = 500;
const geocodeCache = new Map<string, CacheEntry>();
let lastRequestTime = 0;

/**
 * Normalize address for consistent caching
 */
function normalizeAddress(address: string): string {
  return address
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b(apt\.?|apartment|unit|#)\s*[\w-]+,?/gi, "")
    .replace(/\bUSA\b/gi, "US");
}

/**
 * Check if cache entry is still valid
 */
function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

/**
 * Get coordinates from in-memory cache
 */
function getFromMemoryCache(address: string): Coordinates | null {
  const normalized = normalizeAddress(address);
  const entry = geocodeCache.get(normalized);

  if (entry && isCacheValid(entry)) {
    return entry.coordinates;
  }

  if (entry) {
    geocodeCache.delete(normalized);
  }

  return null;
}

/**
 * Get coordinates from persistent DB cache (survives cold starts)
 */
async function getFromDbCache(address: string): Promise<Coordinates | null> {
  const normalized = normalizeAddress(address);
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("geocoding_cache")
      .select("latitude,longitude")
      .eq("address", normalized)
      .gte("cached_at", new Date(Date.now() - CACHE_TTL_MS).toISOString())
      .maybeSingle();

    if (data) {
      // Promote to in-memory cache for faster subsequent lookups
      saveToMemoryCache(normalized, { latitude: data.latitude, longitude: data.longitude });
      return { latitude: data.latitude, longitude: data.longitude };
    }
  } catch (err) {
    logger.warn("DB geocode cache lookup failed", { error: String(err) });
  }
  return null;
}

/**
 * Save coordinates to persistent DB cache
 */
async function saveToDbCache(address: string, coordinates: Coordinates): Promise<void> {
  const normalized = normalizeAddress(address);
  try {
    const supabase = getSupabaseClient();
    await supabase
      .from("geocoding_cache")
      .upsert({
        address: normalized,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        cached_at: new Date().toISOString(),
      }, { onConflict: "address" });
  } catch (err) {
    logger.warn("DB geocode cache write failed", { error: String(err) });
  }
}

/**
 * Save coordinates to in-memory cache
 */
function saveToMemoryCache(address: string, coordinates: Coordinates): void {
  const normalized = normalizeAddress(address);

  // Evict oldest entry if cache is full
  if (geocodeCache.size >= MAX_GEOCODE_CACHE_SIZE) {
    const firstKey = geocodeCache.keys().next().value;
    if (firstKey) geocodeCache.delete(firstKey);
  }

  geocodeCache.set(normalized, {
    coordinates,
    timestamp: Date.now(),
  });
}

/**
 * Rate limiting: ensure minimum delay between requests
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < RATE_LIMIT_DELAY_MS) {
    const delay = RATE_LIMIT_DELAY_MS - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  lastRequestTime = Date.now();
}

/**
 * Fetch with timeout and retry logic
 */
async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en",
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          return response;
        }

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delayMs = retryAfter
            ? parseInt(retryAfter) * 1000
            : RATE_LIMIT_DELAY_MS * Math.pow(2, attempt);
          logger.warn("Nominatim rate limited", { delayMs, attempt: attempt + 1, retries });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.error("Nominatim HTTP error", {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.error("Nominatim request timeout", { attempt: attempt + 1, retries });
      } else {
        logger.error("Nominatim fetch error", {
          attempt: attempt + 1,
          retries,
          error: String(error),
        });
      }

      if (attempt === retries - 1) {
        return null;
      }

      const delayMs = RATE_LIMIT_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

/**
 * Validate coordinates
 */
function isValidCoordinates(lat: number, lon: number): boolean {
  return (
    !isNaN(lat) &&
    !isNaN(lon) &&
    lat !== 0 &&
    lon !== 0 &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Try geocoding with progressive address simplification
 */
async function geocodeWithFallback(address: string): Promise<Coordinates | null> {
  const addressParts = address.split(/\s+/);

  // Try full address first, then progressively remove parts from the end
  for (let i = addressParts.length; i > 0; i--) {
    const currentAddress = addressParts.slice(0, i).join(" ");
    const params = new URLSearchParams({
      format: "json",
      q: currentAddress,
      limit: "1",
      addressdetails: "1",
    });
    const url = `${NOMINATIM_BASE_URL}?${params.toString()}`;

    await enforceRateLimit();

    const response = await fetchWithRetry(url);
    if (!response) {
      continue;
    }

    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      logger.error("Nominatim non-JSON response");
      continue;
    }

    const data: NominatimResult[] = await response.json();

    if (Array.isArray(data) && data.length > 0) {
      const result = data[0];
      const latitude = parseFloat(result.lat);
      const longitude = parseFloat(result.lon);

      if (isValidCoordinates(latitude, longitude)) {
        return { latitude, longitude };
      }
    }
  }

  return null;
}

/**
 * Main geocoding function with caching
 */
export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  if (!address || address.trim().length === 0) {
    logger.warn("Empty address provided");
    return null;
  }

  // Check in-memory cache first (fastest)
  const memoryCached = getFromMemoryCache(address);
  if (memoryCached) {
    logger.debug("Geocode memory cache hit", { address });
    return memoryCached;
  }

  // Check persistent DB cache (survives cold starts)
  const dbCached = await getFromDbCache(address);
  if (dbCached) {
    logger.debug("Geocode DB cache hit", { address });
    return dbCached;
  }

  logger.debug("Geocoding address", { address });

  // Normalize and try geocoding with circuit breaker protection
  const normalizedAddress = normalizeAddress(address);

  try {
    const coordinates = await withCircuitBreaker(
      "nominatim",
      () => geocodeWithFallback(normalizedAddress),
      { failureThreshold: 5, resetTimeoutMs: 60_000 },
    );

    if (coordinates) {
      saveToMemoryCache(address, coordinates);
      // Persist to DB cache in background (fire-and-forget)
      saveToDbCache(address, coordinates).catch(() => {});
      logger.debug("Geocoded successfully", { address, coordinates });
      return coordinates;
    }

    logger.debug("Failed to geocode address", { address });
    return null;
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      logger.warn("Nominatim circuit breaker open, skipping geocoding", {
        address,
        retryAfterMs: error.retryAfterMs,
      });
      return null;
    }
    throw error;
  }
}

/**
 * Geocode with country fallbacks
 */
export async function geocodeWithCountryFallback(
  location: string,
  fallbackCountries: string[] = ["USA", "United States", "Czech Republic", "France", "Russia"],
): Promise<Coordinates | null> {
  if (!location || location.trim().length === 0) {
    logger.warn("Empty location provided");
    return null;
  }

  // Try direct geocoding first
  let result = await geocodeAddress(location);
  if (result) {
    return result;
  }

  // Check if location already has a country
  const locationLower = location.toLowerCase();
  const hasCountry = fallbackCountries.some((country) =>
    locationLower.includes(country.toLowerCase())
  );

  if (!hasCountry) {
    logger.debug("Trying fallback countries", { location });

    for (const country of fallbackCountries) {
      const addressWithCountry = `${location}, ${country}`;
      logger.debug("Trying with country fallback", { country, location });

      result = await geocodeAddress(addressWithCountry);
      if (result) {
        return result;
      }
    }
  }

  logger.info("All geocoding attempts failed", { location });
  return null;
}

/**
 * Clear expired cache entries
 */
export function cleanupCache(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of geocodeCache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL_MS) {
      geocodeCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info("Cleaned expired geocode cache entries", { cleaned });
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; hitRate?: number } {
  return {
    size: geocodeCache.size,
  };
}
