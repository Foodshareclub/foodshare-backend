/**
 * Storage Bucket Constants for Edge Functions
 * Matches the client-side constants in src/constants/storage.ts
 */

export const STORAGE_BUCKETS = {
  /** User profile pictures and avatars (public) */
  PROFILES: "profiles",

  /** Post/listing images - food photos (public) */
  POSTS: "posts",

  /** Country/region flags (public) */
  FLAGS: "flags",

  /** Forum discussion attachments (public) */
  FORUM: "forum",

  /** Challenge images (public) */
  CHALLENGES: "challenges",

  /** Room/chat images (public) */
  ROOMS: "rooms",

  /** General application assets - videos, docs, etc (public) */
  ASSETS: "assets",
} as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

/**
 * Allowed MIME types per bucket
 * Server-side validation for edge functions
 */
export const ALLOWED_MIME_TYPES = {
  PROFILES: ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif"],
  POSTS: [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/heic",
    "image/heif",
  ],
  FLAGS: [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "image/avif",
  ],
  FORUM: [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/avif",
    "application/pdf",
    "text/plain",
  ],
  CHALLENGES: ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif"],
  ROOMS: ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif"],
  ASSETS: [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "image/avif",
    "application/pdf",
    "text/plain",
    "text/css",
    "application/json",
    "video/mp4",
    "video/webm",
  ],
} as const;

/**
 * Maximum file sizes per bucket (in bytes)
 */
export const MAX_FILE_SIZES = {
  PROFILES: 5 * 1024 * 1024, // 5MB
  POSTS: 10 * 1024 * 1024, // 10MB
  FLAGS: 2 * 1024 * 1024, // 2MB
  FORUM: 10 * 1024 * 1024, // 10MB
  CHALLENGES: 5 * 1024 * 1024, // 5MB
  ROOMS: 5 * 1024 * 1024, // 5MB
  ASSETS: 50 * 1024 * 1024, // 50MB
} as const;

/**
 * Validate file type against bucket's allowed MIME types
 */
export function isValidFileType(
  contentType: string,
  bucket: keyof typeof STORAGE_BUCKETS,
): boolean {
  const allowedTypes = ALLOWED_MIME_TYPES[bucket];
  return allowedTypes.includes(contentType as any);
}

/**
 * Validate file size against bucket's maximum
 */
export function isValidFileSize(fileSize: number, bucket: keyof typeof STORAGE_BUCKETS): boolean {
  const maxSize = MAX_FILE_SIZES[bucket];
  return fileSize <= maxSize;
}

/**
 * Validate file before upload
 */
export function validateFile(
  contentType: string,
  fileSize: number,
  bucket: keyof typeof STORAGE_BUCKETS,
): { valid: boolean; error?: string } {
  if (!isValidFileType(contentType, bucket)) {
    const allowedTypes = ALLOWED_MIME_TYPES[bucket]
      .map((type) => type.split("/")[1].toUpperCase())
      .join(", ");
    return {
      valid: false,
      error: `Invalid file type. Allowed types: ${allowedTypes}`,
    };
  }

  if (!isValidFileSize(fileSize, bucket)) {
    const maxSizeMB = MAX_FILE_SIZES[bucket] / (1024 * 1024);
    return {
      valid: false,
      error: `File too large. Maximum size: ${maxSizeMB}MB`,
    };
  }

  return { valid: true };
}

/**
 * Get human-readable file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
