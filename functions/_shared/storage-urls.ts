/**
 * Storage URL Validation
 *
 * Validates that image URLs belong to our own storage providers
 * (Supabase Storage or Cloudflare R2). Used by api-v1-products
 * to reject external image URLs and by cleanup-orphan-images
 * to parse storage paths for deletion.
 *
 * @module _shared/storage-urls
 */

import { validateImageUrl } from "./url-validation.ts";
import { getR2Config } from "./r2-storage.ts";
import { STORAGE_BUCKETS } from "./storage-constants.ts";

export interface ParsedStorageUrl {
  provider: "supabase" | "r2";
  bucket: string;
  path: string;
}

const VALID_BUCKETS = new Set(Object.values(STORAGE_BUCKETS));

/**
 * Parse a URL into its storage provider, bucket, and path components.
 * Returns null if the URL doesn't match any known storage pattern.
 *
 * Supabase pattern: {SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}
 * R2 pattern:       {R2_PUBLIC_URL}/{bucket}/{path}
 */
export function parseStorageUrl(url: string): ParsedStorageUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Check Supabase Storage pattern
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (supabaseUrl) {
    try {
      const supabaseHost = new URL(supabaseUrl).hostname;
      if (parsed.hostname === supabaseHost) {
        // Pattern: /storage/v1/object/public/{bucket}/{...path}
        const match = parsed.pathname.match(
          /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/
        );
        if (match) {
          const [, bucket, path] = match;
          if (VALID_BUCKETS.has(bucket)) {
            return { provider: "supabase", bucket, path };
          }
        }
      }
    } catch {
      // Invalid SUPABASE_URL — skip
    }
  }

  // Check R2 pattern
  const r2Config = getR2Config();
  if (r2Config?.publicUrl) {
    try {
      const r2Host = new URL(r2Config.publicUrl).hostname;
      if (parsed.hostname === r2Host) {
        // Pattern: /{bucket}/{...path}
        const segments = parsed.pathname.replace(/^\//, "").split("/");
        if (segments.length >= 2) {
          const bucket = segments[0];
          const path = segments.slice(1).join("/");
          if (VALID_BUCKETS.has(bucket)) {
            return { provider: "r2", bucket, path };
          }
        }
      }
    } catch {
      // Invalid R2_PUBLIC_URL — skip
    }
  }

  return null;
}

/**
 * Check whether a URL points to our own Supabase or R2 storage.
 */
export function isOwnStorageUrl(url: string): boolean {
  return parseStorageUrl(url) !== null;
}

/**
 * Validate that all product image URLs are safe (SSRF) AND belong to our storage.
 *
 * Returns a discriminated union so callers get the list of offending URLs
 * for a meaningful error message.
 */
export function validateProductImageUrls(
  urls: string[]
): { valid: true } | { valid: false; invalidUrls: string[] } {
  const invalidUrls: string[] = [];

  for (const url of urls) {
    // First: SSRF / general safety check
    const ssrfResult = validateImageUrl(url);
    if (!ssrfResult.valid) {
      invalidUrls.push(url);
      continue;
    }

    // Second: must belong to our storage
    if (!isOwnStorageUrl(url)) {
      invalidUrls.push(url);
    }
  }

  if (invalidUrls.length > 0) {
    return { valid: false, invalidUrls };
  }

  return { valid: true };
}
