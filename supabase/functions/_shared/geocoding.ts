/**
 * Shared Geocoding Service
 * Used across multiple Edge Functions for consistent geocoding behavior
 */

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

// In-memory cache
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
 * Get coordinates from cache
 */
function getFromCache(address: string): Coordinates | null {
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
 * Save coordinates to cache
 */
function saveToCache(address: string, coordinates: Coordinates): void {
  const normalized = normalizeAddress(address);
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
          console.log(`Rate limited. Waiting ${delayMs}ms before retry ${attempt + 1}/${retries}`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        console.error(`HTTP error: ${response.status} ${response.statusText}`);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.error(`Request timeout on attempt ${attempt + 1}/${retries}`);
      } else {
        console.error(`Fetch error on attempt ${attempt + 1}/${retries}:`, error);
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
      console.error("Non-JSON response received");
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
    console.warn("Empty address provided");
    return null;
  }

  // Check cache first
  const cached = getFromCache(address);
  if (cached) {
    console.log("Cache hit for:", address);
    return cached;
  }

  console.log("Geocoding address:", address);

  // Normalize and try geocoding
  const normalizedAddress = normalizeAddress(address);
  const coordinates = await geocodeWithFallback(normalizedAddress);

  if (coordinates) {
    // Cache successful result
    saveToCache(address, coordinates);
    console.log("Geocoded successfully:", coordinates);
    return coordinates;
  }

  console.log("Failed to geocode address:", address);
  return null;
}

/**
 * Geocode with country fallbacks
 */
export async function geocodeWithCountryFallback(
  location: string,
  fallbackCountries: string[] = ["USA", "United States", "Czech Republic", "France", "Russia"]
): Promise<Coordinates | null> {
  if (!location || location.trim().length === 0) {
    console.warn("Empty location provided");
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
    console.log("Trying fallback countries...");

    for (const country of fallbackCountries) {
      const addressWithCountry = `${location}, ${country}`;
      console.log(`Trying with ${country}...`);

      result = await geocodeAddress(addressWithCountry);
      if (result) {
        return result;
      }
    }
  }

  console.log("All geocoding attempts failed for:", location);
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
    console.log(`Cleaned ${cleaned} expired cache entries`);
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
