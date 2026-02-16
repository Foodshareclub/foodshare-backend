/**
 * Location Fuzzer for Product API
 *
 * Applies deterministic coordinate fuzzing to product listings
 * so non-owners see approximate (~100-200m offset) coordinates.
 * Owners always see exact coordinates.
 */

import { approximateLocation } from "../../_shared/location-privacy.ts";

/**
 * Fuzz coordinates on a single product for non-owners.
 * Adds `coordinates_approximate: true` flag when fuzzing is applied.
 *
 * @param product - Product record (must have `id`, `latitude`, `longitude`, optionally `profile_id` and `location_json`)
 * @param requestingUserId - The authenticated user's ID (or null for anonymous)
 * @returns Product with fuzzed coordinates if user is not the owner
 */
export function fuzzProductCoordinates(
  product: Record<string, unknown>,
  requestingUserId: string | null,
): Record<string, unknown> {
  // Owner sees exact coordinates
  if (requestingUserId && product.profile_id === requestingUserId) {
    return { ...product, coordinates_approximate: false };
  }

  const lat = product.latitude as number | undefined;
  const lng = product.longitude as number | undefined;
  const postId = product.id as number | undefined;

  // No coordinates to fuzz
  if (lat == null || lng == null || postId == null) {
    return product;
  }

  const fuzzed = approximateLocation(lat, lng, postId);

  const result: Record<string, unknown> = {
    ...product,
    latitude: fuzzed.latitude,
    longitude: fuzzed.longitude,
    coordinates_approximate: true,
  };

  // Also fuzz location_json if present
  if (product.location_json && typeof product.location_json === "object") {
    const locJson = product.location_json as Record<string, unknown>;
    result.location_json = {
      ...locJson,
      latitude: fuzzed.latitude,
      longitude: fuzzed.longitude,
    };
  }

  return result;
}

/**
 * Batch helper: fuzz coordinates on an array of products.
 */
export function fuzzProductListCoordinates(
  products: Record<string, unknown>[],
  requestingUserId: string | null,
): Record<string, unknown>[] {
  return products.map((p) => fuzzProductCoordinates(p, requestingUserId));
}
