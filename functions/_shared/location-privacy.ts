/**
 * Location Privacy Utilities for Edge Functions
 * Provides consistent 200m location approximation for user privacy
 */

/**
 * Location Privacy Configuration
 */
export const LOCATION_PRIVACY = {
  /** Approximation radius in meters (200m for user safety) */
  RADIUS_METERS: 200,
  /** Minimum offset to ensure location is always moved */
  MIN_OFFSET_METERS: 100,
} as const;

/**
 * Mulberry32 - Fast seeded PRNG
 * Produces deterministic pseudo-random numbers from a seed
 */
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Approximate a location for privacy by applying a deterministic offset
 * Uses a seeded pseudo-random offset based on the post ID so the
 * approximate location is consistent across requests.
 *
 * @param lat - Original latitude
 * @param lng - Original longitude
 * @param postId - Post ID used as seed for deterministic offset
 * @returns Approximated coordinates with ~100-200m offset
 */
export function approximateLocation(
  lat: number,
  lng: number,
  postId: number
): { latitude: number; longitude: number } {
  // Seeded pseudo-random number generator (mulberry32)
  // Using post ID ensures same offset for same post across requests
  const seed = postId * 2654435761; // Golden ratio hash
  const random1 = mulberry32(seed);
  const random2 = mulberry32(seed + 1);

  // Random angle between 0 and 2π
  const angle = random1() * 2 * Math.PI;

  // Random distance between MIN_OFFSET and RADIUS (100-200m)
  const distance =
    LOCATION_PRIVACY.MIN_OFFSET_METERS +
    random2() * (LOCATION_PRIVACY.RADIUS_METERS - LOCATION_PRIVACY.MIN_OFFSET_METERS);

  // Convert meters to degrees (approximation)
  // 1 degree latitude ≈ 111,320 meters
  // 1 degree longitude ≈ 111,320 * cos(latitude) meters
  const latOffset = (distance * Math.cos(angle)) / 111320;
  const lngOffset = (distance * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));

  return {
    latitude: lat + latOffset,
    longitude: lng + lngOffset,
  };
}
