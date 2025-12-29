/**
 * Application constants
 */

// Timeouts
export const GEOCODING_TIMEOUT_MS = 5000; // 5 seconds
export const FILE_UPLOAD_TIMEOUT_MS = 30000; // 30 seconds
export const EMAIL_SEND_TIMEOUT_MS = 10000; // 10 seconds
export const DATABASE_QUERY_TIMEOUT_MS = 5000; // 5 seconds

// Verification
export const VERIFICATION_CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
export const VERIFICATION_CODE_LENGTH = 6;

// Caching
export const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const LANGUAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Rate Limiting
export const MAX_REQUESTS_PER_MINUTE = 10;
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

// Retry
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;

// File Upload
export const MAX_FILE_SIZE_MB = 20;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

// Validation
export const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 1000;
