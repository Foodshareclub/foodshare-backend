/**
 * Geocoding service for Telegram bot
 * Uses shared geocoding utilities
 */

import {
  geocodeAddress,
  geocodeWithCountryFallback,
  cleanupCache as sharedCleanupCache,
  getCacheStats as sharedGetCacheStats,
  type Coordinates,
} from "../../_shared/geocoding.ts";

/**
 * Geocode location (alias for shared function)
 */
export async function geocodeLocation(address: string): Promise<Coordinates | null> {
  return geocodeAddress(address);
}

/**
 * Extract coordinates with fallback strategies
 */
export async function extractCoordinates(location: string): Promise<Coordinates | null> {
  return geocodeWithCountryFallback(location);
}

/**
 * Clear expired cache entries
 */
export function cleanupCache(): void {
  sharedCleanupCache();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; entries?: number } {
  const stats = sharedGetCacheStats();
  return {
    size: stats.size,
    entries: stats.size,
  };
}
