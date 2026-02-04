/**
 * Rate Limit Configuration
 *
 * Centralized configuration for all endpoint rate limits.
 * Provides tiered limits based on user type and endpoint sensitivity.
 *
 * @module rate-limit-config
 */

// =============================================================================
// User Tiers
// =============================================================================

export type UserTier = "anonymous" | "free" | "verified" | "premium" | "admin";

export interface TierMultipliers {
  anonymous: number;
  free: number;
  verified: number;
  premium: number;
  admin: number;
}

export const DEFAULT_TIER_MULTIPLIERS: TierMultipliers = {
  anonymous: 0.5,  // Half the base limit
  free: 1.0,       // Base limit
  verified: 1.5,   // 50% more
  premium: 3.0,    // Triple
  admin: 10.0,     // 10x for admin operations
};

// =============================================================================
// Endpoint Categories
// =============================================================================

export type EndpointCategory =
  | "auth"           // Authentication endpoints
  | "read"           // Read operations
  | "write"          // Create/Update operations
  | "delete"         // Delete operations
  | "upload"         // File uploads
  | "search"         // Search queries
  | "realtime"       // Realtime subscriptions
  | "sensitive"      // Password reset, email change
  | "admin"          // Admin operations
  | "batch";         // Batch operations

export interface CategoryLimits {
  /** Requests per minute (base limit) */
  perMinute: number;
  /** Requests per hour (extended limit) */
  perHour: number;
  /** Burst allowance (short window) */
  burstLimit: number;
  /** Burst window in ms */
  burstWindowMs: number;
}

export const CATEGORY_LIMITS: Record<EndpointCategory, CategoryLimits> = {
  auth: {
    perMinute: 10,
    perHour: 50,
    burstLimit: 5,
    burstWindowMs: 10000,
  },
  read: {
    perMinute: 120,
    perHour: 3000,
    burstLimit: 30,
    burstWindowMs: 5000,
  },
  write: {
    perMinute: 30,
    perHour: 500,
    burstLimit: 10,
    burstWindowMs: 5000,
  },
  delete: {
    perMinute: 20,
    perHour: 200,
    burstLimit: 5,
    burstWindowMs: 10000,
  },
  upload: {
    perMinute: 10,
    perHour: 100,
    burstLimit: 3,
    burstWindowMs: 10000,
  },
  search: {
    perMinute: 60,
    perHour: 1000,
    burstLimit: 20,
    burstWindowMs: 5000,
  },
  realtime: {
    perMinute: 30,
    perHour: 300,
    burstLimit: 10,
    burstWindowMs: 10000,
  },
  sensitive: {
    perMinute: 5,
    perHour: 20,
    burstLimit: 2,
    burstWindowMs: 30000,
  },
  admin: {
    perMinute: 100,
    perHour: 1000,
    burstLimit: 20,
    burstWindowMs: 5000,
  },
  batch: {
    perMinute: 10,
    perHour: 100,
    burstLimit: 3,
    burstWindowMs: 30000,
  },
};

// =============================================================================
// Endpoint Configuration
// =============================================================================

export interface EndpointRateLimitConfig {
  /** Endpoint path pattern (supports wildcards) */
  path: string;
  /** HTTP method(s) */
  methods: string[];
  /** Endpoint category */
  category: EndpointCategory;
  /** Override base limits (optional) */
  customLimits?: Partial<CategoryLimits>;
  /** Use distributed rate limiting */
  distributed: boolean;
  /** Apply tier multipliers */
  applyTierMultipliers: boolean;
  /** Skip rate limiting entirely */
  skip?: boolean;
  /** Custom tier multipliers */
  tierMultipliers?: Partial<TierMultipliers>;
}

// =============================================================================
// Endpoint Registry
// =============================================================================

export const ENDPOINT_RATE_LIMITS: EndpointRateLimitConfig[] = [
  // Authentication
  {
    path: "/auth/login",
    methods: ["POST"],
    category: "auth",
    distributed: true,
    applyTierMultipliers: false,
  },
  {
    path: "/auth/signup",
    methods: ["POST"],
    category: "auth",
    distributed: true,
    applyTierMultipliers: false,
  },
  {
    path: "/auth/refresh",
    methods: ["POST"],
    category: "auth",
    distributed: false,
    applyTierMultipliers: false,
  },
  {
    path: "/auth/password-reset",
    methods: ["POST"],
    category: "sensitive",
    distributed: true,
    applyTierMultipliers: false,
  },

  // Listings
  {
    path: "/api/v1/listings",
    methods: ["GET"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/listings/*",
    methods: ["GET"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/listings",
    methods: ["POST"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/listings/*",
    methods: ["PUT", "PATCH"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/listings/*",
    methods: ["DELETE"],
    category: "delete",
    distributed: true,
    applyTierMultipliers: true,
  },

  // Search
  {
    path: "/api/v1/search",
    methods: ["GET", "POST"],
    category: "search",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/unified-search",
    methods: ["GET", "POST"],
    category: "search",
    distributed: false,
    applyTierMultipliers: true,
  },

  // Chat & Messaging
  {
    path: "/api/v1/chat/*",
    methods: ["GET"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/chat/*",
    methods: ["POST"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
  },

  // Reviews
  {
    path: "/api/v1/reviews",
    methods: ["GET"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/reviews",
    methods: ["POST"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
    customLimits: { perMinute: 10, perHour: 50 },
  },

  // Profile
  {
    path: "/api/v1/profile/*",
    methods: ["GET"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/profile/*",
    methods: ["PUT", "PATCH"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
  },

  // Uploads
  {
    path: "/upload/*",
    methods: ["POST"],
    category: "upload",
    distributed: true,
    applyTierMultipliers: true,
  },
  {
    path: "/api/v1/images",
    methods: ["POST"],
    category: "upload",
    distributed: true,
    applyTierMultipliers: true,
  },

  // BFF Endpoints
  {
    path: "/bff/*",
    methods: ["GET", "POST"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  },

  // Batch Operations
  {
    path: "/batch-operations",
    methods: ["POST"],
    category: "batch",
    distributed: true,
    applyTierMultipliers: true,
  },

  // Admin
  {
    path: "/api/v1/admin/*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    category: "admin",
    distributed: true,
    applyTierMultipliers: false,
    tierMultipliers: { admin: 1.0 }, // Only admins, base limit
  },

  // Favorites
  {
    path: "/atomic-favorites",
    methods: ["POST", "DELETE"],
    category: "write",
    distributed: false,
    applyTierMultipliers: true,
  },

  // Engagement
  {
    path: "/api/v1/engagement/*",
    methods: ["POST"],
    category: "write",
    distributed: false,
    applyTierMultipliers: true,
  },

  // Unified Notifications API
  {
    path: "/api-v1-notifications/*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
  },
  {
    path: "/api-v1-notifications/send",
    methods: ["POST"],
    category: "write",
    distributed: true,
    applyTierMultipliers: true,
    customLimits: { perMinute: 60, perHour: 1000 },
  },
  {
    path: "/api-v1-notifications/send/batch",
    methods: ["POST"],
    category: "batch",
    distributed: true,
    applyTierMultipliers: true,
  },
  {
    path: "/api-v1-notifications/webhook/*",
    methods: ["POST"],
    category: "write",
    distributed: false,
    applyTierMultipliers: false,
    customLimits: { perMinute: 1000, perHour: 10000 },
  },
];

// =============================================================================
// Config Lookup
// =============================================================================

/**
 * Find rate limit config for an endpoint
 */
export function findEndpointConfig(
  path: string,
  method: string
): EndpointRateLimitConfig | null {
  // Normalize path
  const normalizedPath = path.replace(/\/+$/, "").toLowerCase();
  const normalizedMethod = method.toUpperCase();

  for (const config of ENDPOINT_RATE_LIMITS) {
    if (!config.methods.includes(normalizedMethod)) continue;

    // Exact match
    if (config.path.toLowerCase() === normalizedPath) {
      return config;
    }

    // Wildcard match
    if (config.path.endsWith("/*")) {
      const basePath = config.path.slice(0, -2).toLowerCase();
      if (normalizedPath.startsWith(basePath)) {
        return config;
      }
    }
  }

  return null;
}

/**
 * Get effective limits for an endpoint and user tier
 */
export function getEffectiveLimits(
  config: EndpointRateLimitConfig,
  userTier: UserTier = "anonymous"
): CategoryLimits {
  const baseLimits = {
    ...CATEGORY_LIMITS[config.category],
    ...config.customLimits,
  };

  if (!config.applyTierMultipliers) {
    return baseLimits;
  }

  const multipliers = {
    ...DEFAULT_TIER_MULTIPLIERS,
    ...config.tierMultipliers,
  };
  const multiplier = multipliers[userTier];

  return {
    perMinute: Math.floor(baseLimits.perMinute * multiplier),
    perHour: Math.floor(baseLimits.perHour * multiplier),
    burstLimit: Math.floor(baseLimits.burstLimit * multiplier),
    burstWindowMs: baseLimits.burstWindowMs,
  };
}

/**
 * Get default config for unknown endpoints
 */
export function getDefaultConfig(): EndpointRateLimitConfig {
  return {
    path: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    category: "read",
    distributed: false,
    applyTierMultipliers: true,
  };
}
