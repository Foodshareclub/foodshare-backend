/**
 * Shared Data Transformers
 *
 * Reusable transform functions for common data patterns across Edge Functions.
 * Converts snake_case database rows to camelCase API response objects.
 *
 * Used by: chat, products, profile, reviews, search
 */

// =============================================================================
// Profile Transforms
// =============================================================================

/**
 * Build a display name from first_name + second_name components.
 * Falls back to display_name if provided.
 */
export function formatDisplayName(
  data: Record<string, unknown>,
): string {
  if (data.display_name && typeof data.display_name === "string") {
    return data.display_name;
  }
  const first = String(data.first_name || "");
  const last = String(data.second_name || "");
  return `${first} ${last}`.trim() || "Unknown";
}

/**
 * Extract a minimal profile summary (id, displayName, avatarUrl).
 * Used in chat participants, message senders, review authors, etc.
 */
export function transformProfileSummary(
  profile: Record<string, unknown> | null | undefined,
): { id: string; displayName: string; avatarUrl: string | null } | null {
  if (!profile) return null;
  return {
    id: String(profile.id || ""),
    displayName: formatDisplayName(profile),
    avatarUrl: (profile.avatar_url as string) ?? null,
  };
}

/**
 * Extract a profile summary using first_name + second_name (for food chat).
 * Differs from transformProfileSummary by using "name" key and always concatenating.
 */
export function transformProfileWithName(
  profile: Record<string, unknown> | null | undefined,
): { id: string; name: string; avatarUrl: string | null } | null {
  if (!profile) return null;
  const first = String(profile.first_name || "");
  const last = String(profile.second_name || "");
  return {
    id: String(profile.id || ""),
    name: `${first} ${last}`.trim() || "Unknown",
    avatarUrl: (profile.avatar_url as string) ?? null,
  };
}

// =============================================================================
// Address Transforms
// =============================================================================

/**
 * Transform a profile_addresses row to camelCase API format.
 */
export function transformAddress(data: Record<string, unknown>) {
  return {
    profileId: data.profile_id,
    addressLine1: data.address_line_1,
    addressLine2: data.address_line_2,
    addressLine3: data.address_line_3,
    city: data.city,
    stateProvince: data.state_province,
    postalCode: data.postal_code,
    country: data.country,
    lat: data.lat,
    lng: data.long,
    fullAddress: data.generated_full_address,
    radiusMeters: data.radius_meters,
  };
}

// =============================================================================
// Category Transforms
// =============================================================================

/**
 * Extract a category sub-object (id, name, icon).
 */
export function transformCategory(
  category: Record<string, unknown> | null | undefined,
): { id: string; name: string; icon: string | null } | null {
  if (!category) return null;
  return {
    id: String(category.id || ""),
    name: String(category.name || ""),
    icon: (category.icon as string) ?? null,
  };
}

// =============================================================================
// Location Transforms
// =============================================================================

/**
 * Create a { lat, lng } object from coordinate fields, or null if missing.
 */
export function transformLocation(
  lat: unknown,
  lng: unknown,
): { lat: number; lng: number } | null {
  if (lat != null && lng != null) {
    const numLat = Number(lat);
    const numLng = Number(lng);
    if (!isNaN(numLat) && !isNaN(numLng)) {
      return { lat: numLat, lng: numLng };
    }
  }
  return null;
}
