/**
 * Geolocation Zod Schemas
 *
 * Shared coordinate validation with proper bounds.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Coordinate Schemas
// =============================================================================

/** Latitude (-90 to 90) */
export const latitudeSchema = z.number().min(-90).max(90);

/** Longitude (-180 to 180) */
export const longitudeSchema = z.number().min(-180).max(180);

/** Latitude/longitude pair using "latitude"/"longitude" keys */
export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

/** Latitude/longitude pair using short "lat"/"lng" keys */
export const latLngSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});
