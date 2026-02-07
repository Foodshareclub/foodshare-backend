/**
 * Geocoding service for location handling
 * Delegates to shared geocoding module for Nominatim calls.
 */

import type { Coordinates } from "../types/index.ts";

// Re-export shared geocodeAddress so callers keep the same import path
export { geocodeAddress } from "../../_shared/geocoding.ts";

/**
 * Extract coordinates from a WhatsApp location message
 */
export function extractCoordinates(location: { latitude: number; longitude: number }): Coordinates {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
  };
}
