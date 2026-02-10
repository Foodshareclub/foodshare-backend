/**
 * Distance Utilities for Edge Functions
 *
 * Provides consistent distance calculations, unit conversions, and formatting
 * across all FoodShare backend services.
 *
 * Design Principles:
 * - Backend stores and calculates everything in kilometers (SI units)
 * - Conversion to miles happens at the API boundary when needed
 * - Locale detection determines user's preferred unit
 * - All public functions are pure and side-effect free
 *
 * @version 1.0.0
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Earth's mean radius in kilometers
 * WGS-84 reference ellipsoid mean radius
 */
export const EARTH_RADIUS_KM = 6371.0088;

/**
 * Conversion factors between distance units
 */
export const CONVERSION = {
  /** Kilometers to miles */
  KM_TO_MILES: 0.621371192,
  /** Miles to kilometers */
  MILES_TO_KM: 1.609344,
  /** Meters to kilometers */
  METERS_TO_KM: 0.001,
  /** Kilometers to meters */
  KM_TO_METERS: 1000,
  /** Feet to meters */
  FEET_TO_METERS: 0.3048,
  /** Meters to feet */
  METERS_TO_FEET: 3.28084,
} as const;

/**
 * Countries that primarily use miles for distance
 * ISO 3166-1 alpha-2 codes
 */
export const MILES_COUNTRIES = new Set([
  "US", // United States
  "GB", // United Kingdom
  "MM", // Myanmar
  "LR", // Liberia
]);

/**
 * Slider configuration for distance radius UI
 */
export const SLIDER_CONFIG = {
  kilometers: {
    min: 1,
    max: 800,
    step: 5,
    defaultValue: 10,
  },
  miles: {
    min: 0.5,
    max: 500,
    step: 5,
    defaultValue: 6, // ~10 km
  },
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Supported distance units
 */
export type DistanceUnit = "kilometers" | "miles";

/**
 * Geographic coordinates
 */
export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Distance result with both units
 */
export interface DistanceResult {
  /** Distance in kilometers (source of truth) */
  km: number;
  /** Distance in miles (derived) */
  miles: number;
}

/**
 * Formatted distance for display
 */
export interface FormattedDistance {
  /** Numeric value in the specified unit */
  value: number;
  /** Unit symbol (km, mi, m, ft) */
  unit: string;
  /** Full formatted string (e.g., "5.2 km") */
  formatted: string;
}

/**
 * Slider configuration for a specific unit
 */
export interface SliderConfig {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: DistanceUnit;
}

// =============================================================================
// Core Distance Calculations
// =============================================================================

/**
 * Calculate the great-circle distance between two points using the Haversine formula
 *
 * The Haversine formula calculates the shortest distance over the earth's surface,
 * giving an "as-the-crow-flies" distance between the points.
 *
 * @param point1 - First coordinate (lat/lng)
 * @param point2 - Second coordinate (lat/lng)
 * @returns Distance in kilometers
 *
 * @example
 * ```ts
 * const distance = haversineDistance(
 *   { lat: 40.7128, lng: -74.0060 }, // New York
 *   { lat: 51.5074, lng: -0.1278 }   // London
 * );
 * // Returns ~5570.22 km
 * ```
 */
export function haversineDistance(point1: Coordinates, point2: Coordinates): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

  const lat1Rad = toRadians(point1.lat);
  const lat2Rad = toRadians(point2.lat);
  const deltaLat = toRadians(point2.lat - point1.lat);
  const deltaLng = toRadians(point2.lng - point1.lng);

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}

/**
 * Calculate distance from raw coordinate numbers
 * Convenience wrapper for haversineDistance
 *
 * @param lat1 - Latitude of first point
 * @param lng1 - Longitude of first point
 * @param lat2 - Latitude of second point
 * @param lng2 - Longitude of second point
 * @returns Distance in kilometers
 */
export function calculateDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  return haversineDistance({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 });
}

/**
 * Check if a point is within a given radius of a center point
 *
 * @param point - Point to check
 * @param center - Center of the radius
 * @param radiusKm - Radius in kilometers
 * @returns true if point is within radius
 */
export function isWithinRadius(
  point: Coordinates,
  center: Coordinates,
  radiusKm: number,
): boolean {
  return haversineDistance(point, center) <= radiusKm;
}

/**
 * Calculate the initial bearing from point1 to point2
 *
 * @param point1 - Starting point
 * @param point2 - Destination point
 * @returns Bearing in degrees (0-360, where 0 is North)
 */
export function calculateBearing(point1: Coordinates, point2: Coordinates): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

  const lat1 = toRadians(point1.lat);
  const lat2 = toRadians(point2.lat);
  const deltaLng = toRadians(point2.lng - point1.lng);

  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  const bearing = toDegrees(Math.atan2(y, x));

  // Normalize to 0-360
  return ((bearing % 360) + 360) % 360;
}

/**
 * Get cardinal direction from bearing
 *
 * @param bearing - Bearing in degrees (0-360)
 * @returns Cardinal direction (N, NE, E, SE, S, SW, W, NW)
 */
export function bearingToCardinal(bearing: number): string {
  const normalized = ((bearing % 360) + 360) % 360;
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}

/**
 * Calculate destination point given start, bearing, and distance
 *
 * @param start - Starting coordinates
 * @param bearingDegrees - Bearing in degrees
 * @param distanceKm - Distance in kilometers
 * @returns Destination coordinates
 */
export function destinationPoint(
  start: Coordinates,
  bearingDegrees: number,
  distanceKm: number,
): Coordinates {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

  const angularDistance = distanceKm / EARTH_RADIUS_KM;
  const bearingRad = toRadians(bearingDegrees);

  const lat1 = toRadians(start.lat);
  const lng1 = toRadians(start.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad),
  );

  const lng2 = lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: toDegrees(lat2),
    lng: toDegrees(lng2),
  };
}

// =============================================================================
// Unit Conversion
// =============================================================================

/**
 * Convert kilometers to miles
 *
 * @param km - Distance in kilometers
 * @returns Distance in miles
 */
export function kmToMiles(km: number): number {
  return km * CONVERSION.KM_TO_MILES;
}

/**
 * Convert miles to kilometers
 *
 * @param miles - Distance in miles
 * @returns Distance in kilometers
 */
export function milesToKm(miles: number): number {
  return miles * CONVERSION.MILES_TO_KM;
}

/**
 * Convert distance from one unit to another
 *
 * @param value - Distance value
 * @param from - Source unit
 * @param to - Target unit
 * @returns Converted distance
 */
export function convertDistance(
  value: number,
  from: DistanceUnit,
  to: DistanceUnit,
): number {
  if (from === to) return value;
  return from === "kilometers" ? kmToMiles(value) : milesToKm(value);
}

/**
 * Get distance in both units
 *
 * @param km - Distance in kilometers
 * @returns Object with distance in both km and miles
 */
export function getDistanceInBothUnits(km: number): DistanceResult {
  return {
    km,
    miles: kmToMiles(km),
  };
}

/**
 * Convert a radius value from user's unit to kilometers (for API calls)
 *
 * @param value - Radius value in user's preferred unit
 * @param userUnit - User's preferred distance unit
 * @returns Radius in kilometers
 */
export function radiusToKm(value: number, userUnit: DistanceUnit): number {
  return userUnit === "miles" ? milesToKm(value) : value;
}

/**
 * Convert a radius from kilometers to user's preferred unit (for display)
 *
 * @param km - Radius in kilometers
 * @param userUnit - User's preferred distance unit
 * @returns Radius in user's unit
 */
export function radiusFromKm(km: number, userUnit: DistanceUnit): number {
  return userUnit === "miles" ? kmToMiles(km) : km;
}

// =============================================================================
// Locale Detection
// =============================================================================

/**
 * Detect preferred distance unit from country code
 *
 * @param countryCode - ISO 3166-1 alpha-2 country code (e.g., "US", "DE")
 * @returns Preferred distance unit for that country
 */
export function detectUnitFromCountry(countryCode: string | null | undefined): DistanceUnit {
  if (!countryCode) return "kilometers";
  return MILES_COUNTRIES.has(countryCode.toUpperCase()) ? "miles" : "kilometers";
}

/**
 * Detect preferred distance unit from Accept-Language header
 *
 * @param acceptLanguage - Accept-Language header value
 * @returns Preferred distance unit
 */
export function detectUnitFromAcceptLanguage(
  acceptLanguage: string | null | undefined,
): DistanceUnit {
  if (!acceptLanguage) return "kilometers";

  // Extract country codes from Accept-Language (e.g., "en-US" -> "US")
  const matches = acceptLanguage.matchAll(/([a-z]{2})-([A-Z]{2})/gi);
  for (const match of matches) {
    const countryCode = match[2].toUpperCase();
    if (MILES_COUNTRIES.has(countryCode)) {
      return "miles";
    }
  }

  return "kilometers";
}

/**
 * Detect preferred distance unit from request
 *
 * Priority:
 * 1. Explicit unit parameter in request
 * 2. X-User-Country header
 * 3. Accept-Language header
 * 4. Default to kilometers
 *
 * @param request - HTTP request object
 * @returns Preferred distance unit
 */
export function detectUnitFromRequest(request: Request): DistanceUnit {
  // Check for explicit unit parameter
  const url = new URL(request.url);
  const explicitUnit = url.searchParams.get("unit");
  if (explicitUnit === "miles" || explicitUnit === "mi") return "miles";
  if (explicitUnit === "kilometers" || explicitUnit === "km") return "kilometers";

  // Check X-User-Country header (set by geolocation middleware)
  const countryHeader = request.headers.get("X-User-Country");
  if (countryHeader) {
    return detectUnitFromCountry(countryHeader);
  }

  // Fall back to Accept-Language
  const acceptLanguage = request.headers.get("Accept-Language");
  return detectUnitFromAcceptLanguage(acceptLanguage);
}

// =============================================================================
// Distance Formatting
// =============================================================================

/**
 * Format distance for display
 *
 * Automatically uses smaller units (meters/feet) for very short distances.
 *
 * @param km - Distance in kilometers
 * @param unit - Display unit preference
 * @param options - Formatting options
 * @returns Formatted distance object
 *
 * @example
 * ```ts
 * formatDistance(5.234, "kilometers")
 * // { value: 5.2, unit: "km", formatted: "5.2 km" }
 *
 * formatDistance(0.15, "kilometers")
 * // { value: 150, unit: "m", formatted: "150 m" }
 *
 * formatDistance(5.234, "miles")
 * // { value: 3.3, unit: "mi", formatted: "3.3 mi" }
 * ```
 */
export function formatDistance(
  km: number,
  unit: DistanceUnit = "kilometers",
  options: {
    /** Number of decimal places (default: 1) */
    decimals?: number;
    /** Use smaller units for short distances (default: true) */
    useSmallUnits?: boolean;
    /** Threshold in km below which to use meters (default: 1) */
    smallUnitThreshold?: number;
  } = {},
): FormattedDistance {
  const { decimals = 1, useSmallUnits = true, smallUnitThreshold = 1 } = options;

  if (unit === "kilometers") {
    // Use meters for very short distances
    if (useSmallUnits && km < smallUnitThreshold) {
      const meters = Math.round(km * CONVERSION.KM_TO_METERS);
      return {
        value: meters,
        unit: "m",
        formatted: `${meters} m`,
      };
    }

    const value = Number(km.toFixed(decimals));
    return {
      value,
      unit: "km",
      formatted: `${value} km`,
    };
  }

  // Miles
  const miles = kmToMiles(km);

  // Use feet for very short distances
  if (useSmallUnits && miles < 0.1) {
    const feet = Math.round(km * CONVERSION.KM_TO_METERS * CONVERSION.METERS_TO_FEET);
    return {
      value: feet,
      unit: "ft",
      formatted: `${feet} ft`,
    };
  }

  const value = Number(miles.toFixed(decimals));
  return {
    value,
    unit: "mi",
    formatted: `${value} mi`,
  };
}

/**
 * Format distance as a simple string
 *
 * @param km - Distance in kilometers
 * @param unit - Display unit preference
 * @returns Formatted string (e.g., "5.2 km")
 */
export function formatDistanceString(km: number, unit: DistanceUnit = "kilometers"): string {
  return formatDistance(km, unit).formatted;
}

/**
 * Round distance to a sensible precision
 *
 * @param km - Distance in kilometers
 * @returns Rounded distance (1 decimal place)
 */
export function roundDistance(km: number): number {
  return Math.round(km * 10) / 10;
}

// =============================================================================
// Slider Configuration
// =============================================================================

/**
 * Get slider configuration for a specific unit
 *
 * @param unit - Distance unit
 * @returns Slider configuration with min, max, step, and default values
 */
export function getSliderConfig(unit: DistanceUnit): SliderConfig {
  const config = unit === "miles" ? SLIDER_CONFIG.miles : SLIDER_CONFIG.kilometers;
  return { ...config, unit };
}

/**
 * Convert slider value to kilometers for API request
 *
 * @param value - Slider value in user's unit
 * @param unit - User's distance unit
 * @returns Value in kilometers
 */
export function sliderValueToKm(value: number, unit: DistanceUnit): number {
  return unit === "miles" ? milesToKm(value) : value;
}

/**
 * Convert kilometers to slider value in user's unit
 *
 * @param km - Value in kilometers
 * @param unit - User's distance unit
 * @returns Slider value in user's unit
 */
export function kmToSliderValue(km: number, unit: DistanceUnit): number {
  return unit === "miles" ? kmToMiles(km) : km;
}

/**
 * Clamp and snap a slider value to valid step
 *
 * @param value - Raw value
 * @param unit - Distance unit
 * @returns Clamped and snapped value
 */
export function snapSliderValue(value: number, unit: DistanceUnit): number {
  const config = getSliderConfig(unit);
  const clamped = Math.max(config.min, Math.min(config.max, value));
  return Math.round(clamped / config.step) * config.step;
}

// =============================================================================
// API Response Helpers
// =============================================================================

/**
 * Transform distance values in a response based on user preference
 *
 * Recursively finds all `*_km` fields and optionally adds `*_miles` equivalents
 *
 * @param data - Response data object
 * @param includeAlternateUnit - Whether to include both units
 * @returns Transformed data
 */
export function transformDistancesInResponse<T extends Record<string, unknown>>(
  data: T,
  includeAlternateUnit = true,
): T {
  if (!data || typeof data !== "object") return data;

  const result = { ...data };

  for (const [key, value] of Object.entries(result)) {
    // Recursively handle nested objects
    if (value && typeof value === "object" && !Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = transformDistancesInResponse(
        value as Record<string, unknown>,
        includeAlternateUnit,
      );
    } // Handle arrays
    else if (Array.isArray(value)) {
      (result as Record<string, unknown>)[key] = value.map((item) =>
        item && typeof item === "object"
          ? transformDistancesInResponse(item as Record<string, unknown>, includeAlternateUnit)
          : item
      );
    } // Transform *_km fields
    else if (key.endsWith("_km") && typeof value === "number" && includeAlternateUnit) {
      const milesKey = key.replace(/_km$/, "_miles");
      (result as Record<string, unknown>)[milesKey] = roundDistance(kmToMiles(value));
    } // Transform distanceKm camelCase
    else if (key === "distanceKm" && typeof value === "number" && includeAlternateUnit) {
      (result as Record<string, unknown>)["distanceMiles"] = roundDistance(kmToMiles(value));
    } // Transform radiusKm camelCase
    else if (key === "radiusKm" && typeof value === "number" && includeAlternateUnit) {
      (result as Record<string, unknown>)["radiusMiles"] = roundDistance(kmToMiles(value));
    }
  }

  return result as T;
}

/**
 * Create a distance object with both units for API response
 *
 * @param km - Distance in kilometers
 * @returns Object with formatted values in both units
 */
export function createDistanceResponse(km: number): {
  km: number;
  miles: number;
  formatted: {
    metric: string;
    imperial: string;
  };
} {
  return {
    km: roundDistance(km),
    miles: roundDistance(kmToMiles(km)),
    formatted: {
      metric: formatDistanceString(km, "kilometers"),
      imperial: formatDistanceString(km, "miles"),
    },
  };
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate coordinates
 *
 * @param lat - Latitude
 * @param lng - Longitude
 * @returns true if valid
 */
export function isValidCoordinates(lat: number, lng: number): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Validate radius value
 *
 * @param radius - Radius value
 * @param unit - Unit of the radius value
 * @returns true if valid (positive and within reasonable bounds)
 */
export function isValidRadius(radius: number, unit: DistanceUnit = "kilometers"): boolean {
  if (typeof radius !== "number" || isNaN(radius) || radius <= 0) {
    return false;
  }

  const config = getSliderConfig(unit);
  return radius >= config.min && radius <= config.max;
}

/**
 * Sanitize and validate radius, returning in kilometers
 *
 * @param radius - Input radius value
 * @param unit - Unit of the input value
 * @param defaultKm - Default value in km if invalid
 * @returns Valid radius in kilometers
 */
export function sanitizeRadiusKm(
  radius: unknown,
  unit: DistanceUnit = "kilometers",
  defaultKm = 10,
): number {
  if (typeof radius !== "number" || isNaN(radius) || radius <= 0) {
    return defaultKm;
  }

  const km = unit === "miles" ? milesToKm(radius) : radius;

  // Clamp to valid range
  const { min, max } = SLIDER_CONFIG.kilometers;
  return Math.max(min, Math.min(max, km));
}
