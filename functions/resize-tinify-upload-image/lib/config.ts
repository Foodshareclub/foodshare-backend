/**
 * Configuration constants
 */

export const CONFIG = {
  targetSize: 100 * 1024, // Target: < 100KB
  skipThreshold: 100 * 1024, // Skip if already under 100KB
  maxBatchSize: 1,
  defaultBucket: "posts",
  // Balanced width tiers: good quality + safely under 100KB
  widthTiers: [
    { maxOriginalSize: 200 * 1024, width: 1000 }, // < 200KB → 1000px
    { maxOriginalSize: 500 * 1024, width: 900 }, // < 500KB → 900px
    { maxOriginalSize: 1024 * 1024, width: 800 }, // < 1MB → 800px
    { maxOriginalSize: 3 * 1024 * 1024, width: 700 }, // < 3MB → 700px
    { maxOriginalSize: 5 * 1024 * 1024, width: 600 }, // < 5MB → 600px
    { maxOriginalSize: Infinity, width: 550 }, // >= 5MB → 550px
  ],
  // Circuit breaker settings
  circuitBreaker: {
    failureThreshold: 3, // Open circuit after 3 consecutive failures
    resetTimeoutMs: 60000, // Try again after 1 minute
    halfOpenMaxAttempts: 1, // Allow 1 test request in half-open state
  },
  // Retry settings
  retry: {
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
  },
} as const;

export const STORAGE_BUCKETS = {
  PROFILES: "profiles",
  POSTS: "posts",
  FLAGS: "flags",
  FORUM: "forum",
  CHALLENGES: "challenges",
  ROOMS: "rooms",
  ASSETS: "assets",
} as const;

export type StorageBucketKey = keyof typeof STORAGE_BUCKETS;
export type StorageBucket = (typeof STORAGE_BUCKETS)[StorageBucketKey];

export const MAX_FILE_SIZES: Record<StorageBucketKey, number> = {
  PROFILES: 5 * 1024 * 1024,
  POSTS: 10 * 1024 * 1024,
  FLAGS: 2 * 1024 * 1024,
  FORUM: 10 * 1024 * 1024,
  CHALLENGES: 5 * 1024 * 1024,
  ROOMS: 5 * 1024 * 1024,
  ASSETS: 50 * 1024 * 1024,
};

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "3600",
};
