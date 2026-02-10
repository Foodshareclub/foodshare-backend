/**
 * Distance Utilities Tests
 *
 * Tests for the shared distance module including:
 * - Unit conversions (km <-> miles)
 * - Haversine distance calculation
 * - Locale detection
 * - Distance formatting
 * - API response transformation
 */

import { assertAlmostEquals, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  bearingToCardinal,
  calculateBearing,
  calculateDistanceKm,
  CONVERSION,
  convertDistance,
  createDistanceResponse,
  destinationPoint,
  detectUnitFromAcceptLanguage,
  detectUnitFromCountry,
  EARTH_RADIUS_KM,
  formatDistance,
  formatDistanceString,
  getDistanceInBothUnits,
  getSliderConfig,
  haversineDistance,
  isValidCoordinates,
  isValidRadius,
  isWithinRadius,
  kmToMiles,
  kmToSliderValue,
  milesToKm,
  radiusFromKm,
  radiusToKm,
  roundDistance,
  sanitizeRadiusKm,
  SLIDER_CONFIG,
  sliderValueToKm,
  snapSliderValue,
  transformDistancesInResponse,
} from "../_shared/distance.ts";

// =============================================================================
// Test Coordinates
// =============================================================================

const NYC = { lat: 40.7128, lng: -74.006 };
const LONDON = { lat: 51.5074, lng: -0.1278 };
const PARIS = { lat: 48.8566, lng: 2.3522 };

// =============================================================================
// Unit Conversion Tests
// =============================================================================

Deno.test("kmToMiles - converts correctly", () => {
  assertAlmostEquals(kmToMiles(1), 0.621371192, 0.0001);
  assertAlmostEquals(kmToMiles(5), 3.106856, 0.0001);
  assertAlmostEquals(kmToMiles(10), 6.21371192, 0.0001);
  assertEquals(kmToMiles(0), 0);
});

Deno.test("milesToKm - converts correctly", () => {
  assertAlmostEquals(milesToKm(1), 1.609344, 0.0001);
  assertAlmostEquals(milesToKm(5), 8.04672, 0.0001);
  assertAlmostEquals(milesToKm(10), 16.09344, 0.0001);
  assertEquals(milesToKm(0), 0);
});

Deno.test("kmToMiles and milesToKm are inverses", () => {
  const original = 42.5;
  const converted = milesToKm(kmToMiles(original));
  assertAlmostEquals(converted, original, 0.0001);
});

Deno.test("convertDistance - handles same unit", () => {
  assertEquals(convertDistance(10, "kilometers", "kilometers"), 10);
  assertEquals(convertDistance(10, "miles", "miles"), 10);
});

Deno.test("convertDistance - converts between units", () => {
  assertAlmostEquals(convertDistance(10, "kilometers", "miles"), 6.21371192, 0.0001);
  assertAlmostEquals(convertDistance(10, "miles", "kilometers"), 16.09344, 0.0001);
});

Deno.test("getDistanceInBothUnits - returns both values", () => {
  const result = getDistanceInBothUnits(10);
  assertEquals(result.km, 10);
  assertAlmostEquals(result.miles, 6.21371192, 0.0001);
});

Deno.test("radiusToKm - converts user unit to km", () => {
  assertEquals(radiusToKm(10, "kilometers"), 10);
  assertAlmostEquals(radiusToKm(10, "miles"), 16.09344, 0.0001);
});

Deno.test("radiusFromKm - converts km to user unit", () => {
  assertEquals(radiusFromKm(10, "kilometers"), 10);
  assertAlmostEquals(radiusFromKm(10, "miles"), 6.21371192, 0.0001);
});

// =============================================================================
// Haversine Distance Tests
// =============================================================================

Deno.test("haversineDistance - NYC to London", () => {
  const distance = haversineDistance(NYC, LONDON);
  // NYC to London is approximately 5570 km
  assertAlmostEquals(distance, 5570, 10);
});

Deno.test("haversineDistance - same point is zero", () => {
  const distance = haversineDistance(NYC, NYC);
  assertEquals(distance, 0);
});

Deno.test("haversineDistance - London to Paris", () => {
  const distance = haversineDistance(LONDON, PARIS);
  // London to Paris is approximately 344 km
  assertAlmostEquals(distance, 344, 5);
});

Deno.test("calculateDistanceKm - raw coordinates", () => {
  const distance = calculateDistanceKm(
    NYC.lat,
    NYC.lng,
    LONDON.lat,
    LONDON.lng,
  );
  assertAlmostEquals(distance, 5570, 10);
});

Deno.test("isWithinRadius - nearby point", () => {
  const nearbyPoint = { lat: 40.72, lng: -74.01 };
  const result = isWithinRadius(nearbyPoint, NYC, 5);
  assertEquals(result, true);
});

Deno.test("isWithinRadius - far point", () => {
  const result = isWithinRadius(LONDON, NYC, 100);
  assertEquals(result, false);
});

// =============================================================================
// Bearing and Direction Tests
// =============================================================================

Deno.test("calculateBearing - NYC to London (northeast)", () => {
  const bearing = calculateBearing(NYC, LONDON);
  // NYC to London is roughly northeast (~51°)
  assertAlmostEquals(bearing, 51, 2);
});

Deno.test("bearingToCardinal - all directions", () => {
  assertEquals(bearingToCardinal(0), "N");
  assertEquals(bearingToCardinal(45), "NE");
  assertEquals(bearingToCardinal(90), "E");
  assertEquals(bearingToCardinal(135), "SE");
  assertEquals(bearingToCardinal(180), "S");
  assertEquals(bearingToCardinal(225), "SW");
  assertEquals(bearingToCardinal(270), "W");
  assertEquals(bearingToCardinal(315), "NW");
  assertEquals(bearingToCardinal(360), "N");
});

Deno.test("destinationPoint - 100km north", () => {
  const destination = destinationPoint(NYC, 0, 100);
  // Moving north should increase latitude
  assertEquals(destination.lat > NYC.lat, true);
  // Longitude should be roughly the same
  assertAlmostEquals(destination.lng, NYC.lng, 0.1);
});

// =============================================================================
// Locale Detection Tests
// =============================================================================

Deno.test("detectUnitFromCountry - US uses miles", () => {
  assertEquals(detectUnitFromCountry("US"), "miles");
  assertEquals(detectUnitFromCountry("us"), "miles");
});

Deno.test("detectUnitFromCountry - UK uses miles", () => {
  assertEquals(detectUnitFromCountry("GB"), "miles");
});

Deno.test("detectUnitFromCountry - Germany uses kilometers", () => {
  assertEquals(detectUnitFromCountry("DE"), "kilometers");
});

Deno.test("detectUnitFromCountry - null returns kilometers", () => {
  assertEquals(detectUnitFromCountry(null), "kilometers");
  assertEquals(detectUnitFromCountry(undefined), "kilometers");
});

Deno.test("detectUnitFromAcceptLanguage - en-US returns miles", () => {
  assertEquals(detectUnitFromAcceptLanguage("en-US,en;q=0.9"), "miles");
});

Deno.test("detectUnitFromAcceptLanguage - de-DE returns kilometers", () => {
  assertEquals(detectUnitFromAcceptLanguage("de-DE,de;q=0.9"), "kilometers");
});

Deno.test("detectUnitFromAcceptLanguage - en-GB returns miles", () => {
  assertEquals(detectUnitFromAcceptLanguage("en-GB"), "miles");
});

// =============================================================================
// Distance Formatting Tests
// =============================================================================

Deno.test("formatDistance - kilometers normal", () => {
  const result = formatDistance(5.234, "kilometers");
  assertEquals(result.value, 5.2);
  assertEquals(result.unit, "km");
  assertEquals(result.formatted, "5.2 km");
});

Deno.test("formatDistance - kilometers short (uses meters)", () => {
  const result = formatDistance(0.15, "kilometers");
  assertEquals(result.value, 150);
  assertEquals(result.unit, "m");
  assertEquals(result.formatted, "150 m");
});

Deno.test("formatDistance - miles normal", () => {
  const result = formatDistance(5, "miles");
  assertEquals(result.value, 3.1);
  assertEquals(result.unit, "mi");
  assertEquals(result.formatted, "3.1 mi");
});

Deno.test("formatDistance - miles short (uses feet)", () => {
  const result = formatDistance(0.05, "miles");
  assertEquals(result.unit, "ft");
  assertEquals(result.value > 100, true); // ~164 feet
});

Deno.test("formatDistance - disable small units", () => {
  const result = formatDistance(0.15, "kilometers", { useSmallUnits: false });
  assertEquals(result.unit, "km");
});

Deno.test("formatDistanceString - simple output", () => {
  assertEquals(formatDistanceString(5.234, "kilometers"), "5.2 km");
  assertEquals(formatDistanceString(5, "miles"), "3.1 mi");
});

Deno.test("roundDistance - rounds to 1 decimal", () => {
  assertEquals(roundDistance(5.234), 5.2);
  assertEquals(roundDistance(5.256), 5.3);
  assertEquals(roundDistance(10), 10);
});

// =============================================================================
// Slider Configuration Tests
// =============================================================================

Deno.test("getSliderConfig - kilometers", () => {
  const config = getSliderConfig("kilometers");
  assertEquals(config.min, SLIDER_CONFIG.kilometers.min);
  assertEquals(config.max, SLIDER_CONFIG.kilometers.max);
  assertEquals(config.step, SLIDER_CONFIG.kilometers.step);
  assertEquals(config.unit, "kilometers");
});

Deno.test("getSliderConfig - miles", () => {
  const config = getSliderConfig("miles");
  assertEquals(config.min, SLIDER_CONFIG.miles.min);
  assertEquals(config.max, SLIDER_CONFIG.miles.max);
  assertEquals(config.step, SLIDER_CONFIG.miles.step);
  assertEquals(config.unit, "miles");
});

Deno.test("sliderValueToKm - converts correctly", () => {
  assertEquals(sliderValueToKm(10, "kilometers"), 10);
  assertAlmostEquals(sliderValueToKm(10, "miles"), 16.09344, 0.0001);
});

Deno.test("kmToSliderValue - converts correctly", () => {
  assertEquals(kmToSliderValue(10, "kilometers"), 10);
  assertAlmostEquals(kmToSliderValue(10, "miles"), 6.21371192, 0.0001);
});

Deno.test("snapSliderValue - kilometers snaps to whole numbers", () => {
  assertEquals(snapSliderValue(5.3, "kilometers"), 5);
  assertEquals(snapSliderValue(5.7, "kilometers"), 6);
});

Deno.test("snapSliderValue - miles snaps to 0.5 increments", () => {
  assertEquals(snapSliderValue(3.2, "miles"), 3);
  assertEquals(snapSliderValue(3.3, "miles"), 3.5);
  assertEquals(snapSliderValue(3.8, "miles"), 4);
});

Deno.test("snapSliderValue - respects bounds", () => {
  assertEquals(snapSliderValue(0.5, "kilometers"), 1); // clamps to min
  assertEquals(snapSliderValue(1000, "kilometers"), 500); // clamps to max
});

// =============================================================================
// API Response Transformation Tests
// =============================================================================

Deno.test("transformDistancesInResponse - adds miles equivalents", () => {
  const input: Record<string, unknown> = {
    id: "123",
    distance_km: 10,
    radiusKm: 5,
    distanceKm: 15,
  };

  const result = transformDistancesInResponse(input);

  assertEquals(result.distance_km, 10);
  assertAlmostEquals(result.distance_miles as number, 6.2, 0.1);
  assertAlmostEquals(result.radiusMiles as number, 3.1, 0.1);
  assertAlmostEquals(result.distanceMiles as number, 9.3, 0.1);
});

Deno.test("transformDistancesInResponse - handles nested objects", () => {
  const input: Record<string, unknown> = {
    listing: {
      id: "123",
      location: {
        distance_km: 5,
      },
    },
  };

  const result = transformDistancesInResponse(input);
  const listing = result.listing as Record<string, unknown>;
  const location = listing.location as Record<string, unknown>;

  assertAlmostEquals(location.distance_miles as number, 3.1, 0.1);
});

Deno.test("transformDistancesInResponse - handles arrays", () => {
  const input: Record<string, unknown> = {
    listings: [
      { id: "1", distance_km: 5 },
      { id: "2", distance_km: 10 },
    ],
  };

  const result = transformDistancesInResponse(input);
  const listings = result.listings as Array<Record<string, unknown>>;

  assertAlmostEquals(listings[0].distance_miles as number, 3.1, 0.1);
  assertAlmostEquals(listings[1].distance_miles as number, 6.2, 0.1);
});

Deno.test("createDistanceResponse - complete response object", () => {
  const result = createDistanceResponse(10);

  assertEquals(result.km, 10);
  assertAlmostEquals(result.miles, 6.2, 0.1);
  assertEquals(result.formatted.metric, "10 km");
  assertEquals(result.formatted.imperial, "6.2 mi");
});

// =============================================================================
// Validation Tests
// =============================================================================

Deno.test("isValidCoordinates - valid coordinates", () => {
  assertEquals(isValidCoordinates(0, 0), true);
  assertEquals(isValidCoordinates(90, 180), true);
  assertEquals(isValidCoordinates(-90, -180), true);
  assertEquals(isValidCoordinates(40.7128, -74.006), true);
});

Deno.test("isValidCoordinates - invalid coordinates", () => {
  assertEquals(isValidCoordinates(91, 0), false);
  assertEquals(isValidCoordinates(0, 181), false);
  assertEquals(isValidCoordinates(NaN, 0), false);
  assertEquals(isValidCoordinates(0, NaN), false);
});

Deno.test("isValidRadius - valid radius", () => {
  assertEquals(isValidRadius(10, "kilometers"), true);
  assertEquals(isValidRadius(5, "miles"), true);
  assertEquals(isValidRadius(1, "kilometers"), true);
  assertEquals(isValidRadius(500, "kilometers"), true);
});

Deno.test("isValidRadius - invalid radius", () => {
  assertEquals(isValidRadius(0, "kilometers"), false);
  assertEquals(isValidRadius(-5, "kilometers"), false);
  assertEquals(isValidRadius(NaN, "kilometers"), false);
  assertEquals(isValidRadius(0.5, "kilometers"), false); // below min
  assertEquals(isValidRadius(600, "kilometers"), false); // above max
});

Deno.test("sanitizeRadiusKm - valid input", () => {
  assertEquals(sanitizeRadiusKm(10, "kilometers"), 10);
  assertAlmostEquals(sanitizeRadiusKm(10, "miles"), 16.09344, 0.0001);
});

Deno.test("sanitizeRadiusKm - invalid input returns default", () => {
  assertEquals(sanitizeRadiusKm("invalid", "kilometers"), 10);
  assertEquals(sanitizeRadiusKm(null, "kilometers"), 10);
  assertEquals(sanitizeRadiusKm(-5, "kilometers"), 10);
  assertEquals(sanitizeRadiusKm(NaN, "kilometers"), 10);
});

Deno.test("sanitizeRadiusKm - clamps to valid range", () => {
  assertEquals(sanitizeRadiusKm(0.5, "kilometers"), 1); // clamps to min
  assertEquals(sanitizeRadiusKm(1000, "kilometers"), 500); // clamps to max
});

// =============================================================================
// Constants Tests
// =============================================================================

Deno.test("EARTH_RADIUS_KM is correct WGS-84 value", () => {
  assertEquals(EARTH_RADIUS_KM, 6371.0088);
});

Deno.test("CONVERSION factors are precise", () => {
  assertEquals(CONVERSION.KM_TO_MILES, 0.621371192);
  assertEquals(CONVERSION.MILES_TO_KM, 1.609344);
  assertEquals(CONVERSION.METERS_TO_KM, 0.001);
  assertEquals(CONVERSION.KM_TO_METERS, 1000);
});

Deno.test("SLIDER_CONFIG has sensible defaults", () => {
  // Kilometers
  assertEquals(SLIDER_CONFIG.kilometers.min, 1);
  assertEquals(SLIDER_CONFIG.kilometers.max, 500);
  assertEquals(SLIDER_CONFIG.kilometers.step, 1);
  assertEquals(SLIDER_CONFIG.kilometers.defaultValue, 10);

  // Miles
  assertEquals(SLIDER_CONFIG.miles.min, 0.5);
  assertEquals(SLIDER_CONFIG.miles.max, 310);
  assertEquals(SLIDER_CONFIG.miles.step, 0.5);
  assertEquals(SLIDER_CONFIG.miles.defaultValue, 6);
});
