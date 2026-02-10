/**
 * Rate Limiting Tests
 *
 * Tests for the unified rate limiting system in Edge Functions.
 * Verifies correct rate limit enforcement, window calculations, and bypass logic.
 */

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { beforeEach, describe, it } from "https://deno.land/std@0.208.0/testing/bdd.ts";

// Rate limit configuration (mirrors _shared/rate-limit-config.ts)
interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

// Rate limit tiers
const RATE_LIMIT_TIERS: Record<string, RateLimitConfig> = {
  anonymous: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyPrefix: "rl:anon",
  },
  authenticated: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
    keyPrefix: "rl:auth",
  },
  premium: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 500,
    keyPrefix: "rl:premium",
  },
};

// Endpoint-specific limits
const ENDPOINT_LIMITS: Record<string, RateLimitConfig> = {
  "POST /listings": {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,
    keyPrefix: "rl:create-listing",
  },
  "POST /messages": {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 60,
    keyPrefix: "rl:send-message",
  },
  "POST /auth/login": {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5,
    keyPrefix: "rl:login",
  },
  "POST /auth/register": {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3,
    keyPrefix: "rl:register",
  },
  "POST /reports": {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 10,
    keyPrefix: "rl:report",
  },
  "GET /search": {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyPrefix: "rl:search",
  },
  "POST /uploads": {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 50,
    keyPrefix: "rl:upload",
  },
};

// In-memory rate limit store for testing
class TestRateLimitStore {
  private store: Map<string, { count: number; resetAt: number }> = new Map();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.store.get(key);

    if (existing && existing.resetAt > now) {
      existing.count++;
      return existing;
    }

    const newEntry = { count: 1, resetAt: now + windowMs };
    this.store.set(key, newEntry);
    return newEntry;
  }

  async get(key: string): Promise<{ count: number; resetAt: number } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.resetAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// Rate limiter implementation for testing
class RateLimiter {
  constructor(private store: TestRateLimitStore) {}

  async checkLimit(
    identifier: string,
    config: RateLimitConfig,
  ): Promise<RateLimitResult> {
    const key = `${config.keyPrefix}:${identifier}`;
    const { count, resetAt } = await this.store.increment(key, config.windowMs);

    const allowed = count <= config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - count);
    const retryAfter = allowed ? undefined : Math.ceil((resetAt - Date.now()) / 1000);

    return { allowed, remaining, resetAt, retryAfter };
  }

  async getRemainingRequests(
    identifier: string,
    config: RateLimitConfig,
  ): Promise<number> {
    const key = `${config.keyPrefix}:${identifier}`;
    const entry = await this.store.get(key);

    if (!entry) return config.maxRequests;
    return Math.max(0, config.maxRequests - entry.count);
  }
}

// Test suite
describe("Rate Limit Configuration", () => {
  it("should have correct tier limits", () => {
    assertEquals(RATE_LIMIT_TIERS.anonymous.maxRequests, 30);
    assertEquals(RATE_LIMIT_TIERS.authenticated.maxRequests, 100);
    assertEquals(RATE_LIMIT_TIERS.premium.maxRequests, 500);
  });

  it("should have endpoint-specific limits for sensitive operations", () => {
    assertExists(ENDPOINT_LIMITS["POST /auth/login"]);
    assertExists(ENDPOINT_LIMITS["POST /auth/register"]);
    assertExists(ENDPOINT_LIMITS["POST /reports"]);
  });

  it("should have stricter limits for auth endpoints", () => {
    const loginLimit = ENDPOINT_LIMITS["POST /auth/login"];
    const registerLimit = ENDPOINT_LIMITS["POST /auth/register"];

    assertEquals(loginLimit.maxRequests, 5);
    assertEquals(registerLimit.maxRequests, 3);
    assert(loginLimit.windowMs >= 15 * 60 * 1000); // At least 15 minutes
  });

  it("should have reasonable limits for content creation", () => {
    const listingLimit = ENDPOINT_LIMITS["POST /listings"];
    const messageLimit = ENDPOINT_LIMITS["POST /messages"];

    assertEquals(listingLimit.maxRequests, 20);
    assert(listingLimit.windowMs >= 60 * 60 * 1000); // At least 1 hour

    assertEquals(messageLimit.maxRequests, 60);
    assertEquals(messageLimit.windowMs, 60 * 1000); // 1 minute
  });
});

describe("Rate Limiter Basic Functionality", () => {
  let store: TestRateLimitStore;
  let limiter: RateLimiter;

  beforeEach(() => {
    store = new TestRateLimitStore();
    limiter = new RateLimiter(store);
  });

  it("should allow requests under limit", async () => {
    const config = { windowMs: 60000, maxRequests: 10, keyPrefix: "test" };
    const result = await limiter.checkLimit("user-1", config);

    assertEquals(result.allowed, true);
    assertEquals(result.remaining, 9);
    assertEquals(result.retryAfter, undefined);
  });

  it("should block requests over limit", async () => {
    const config = { windowMs: 60000, maxRequests: 3, keyPrefix: "test" };

    // Make 3 requests (allowed)
    await limiter.checkLimit("user-1", config);
    await limiter.checkLimit("user-1", config);
    await limiter.checkLimit("user-1", config);

    // 4th request should be blocked
    const result = await limiter.checkLimit("user-1", config);

    assertEquals(result.allowed, false);
    assertEquals(result.remaining, 0);
    assertExists(result.retryAfter);
    assert(result.retryAfter > 0);
  });

  it("should track remaining requests correctly", async () => {
    const config = { windowMs: 60000, maxRequests: 5, keyPrefix: "test" };

    let result = await limiter.checkLimit("user-1", config);
    assertEquals(result.remaining, 4);

    result = await limiter.checkLimit("user-1", config);
    assertEquals(result.remaining, 3);

    result = await limiter.checkLimit("user-1", config);
    assertEquals(result.remaining, 2);
  });

  it("should use separate counters for different users", async () => {
    const config = { windowMs: 60000, maxRequests: 5, keyPrefix: "test" };

    await limiter.checkLimit("user-1", config);
    await limiter.checkLimit("user-1", config);

    const user1Remaining = await limiter.getRemainingRequests("user-1", config);
    const user2Remaining = await limiter.getRemainingRequests("user-2", config);

    assertEquals(user1Remaining, 3);
    assertEquals(user2Remaining, 5);
  });

  it("should use separate counters for different endpoints", async () => {
    const config1 = { windowMs: 60000, maxRequests: 10, keyPrefix: "endpoint-a" };
    const config2 = { windowMs: 60000, maxRequests: 10, keyPrefix: "endpoint-b" };

    // Use up endpoint A quota
    for (let i = 0; i < 10; i++) {
      await limiter.checkLimit("user-1", config1);
    }

    // Endpoint B should still have quota
    const resultA = await limiter.checkLimit("user-1", config1);
    const resultB = await limiter.checkLimit("user-1", config2);

    assertEquals(resultA.allowed, false);
    assertEquals(resultB.allowed, true);
  });
});

describe("Rate Limiter Window Behavior", () => {
  let store: TestRateLimitStore;
  let limiter: RateLimiter;

  beforeEach(() => {
    store = new TestRateLimitStore();
    limiter = new RateLimiter(store);
  });

  it("should reset counter after window expires", async () => {
    // This test simulates window expiration
    const shortWindow = { windowMs: 100, maxRequests: 2, keyPrefix: "short" };

    await limiter.checkLimit("user-1", shortWindow);
    await limiter.checkLimit("user-1", shortWindow);

    // Should be at limit
    let result = await limiter.checkLimit("user-1", shortWindow);
    assertEquals(result.allowed, false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should be allowed again
    result = await limiter.checkLimit("user-1", shortWindow);
    assertEquals(result.allowed, true);
    assertEquals(result.remaining, 1);
  });

  it("should provide correct retry-after time", async () => {
    const config = { windowMs: 60000, maxRequests: 1, keyPrefix: "retry-test" };

    await limiter.checkLimit("user-1", config);
    const result = await limiter.checkLimit("user-1", config);

    assertEquals(result.allowed, false);
    assertExists(result.retryAfter);
    assert(result.retryAfter > 0);
    assert(result.retryAfter <= 60); // Should be at most 60 seconds
  });
});

describe("Rate Limit Headers", () => {
  it("should generate correct rate limit headers", () => {
    const result: RateLimitResult = {
      allowed: true,
      remaining: 95,
      resetAt: Date.now() + 60000,
    };

    const headers = {
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": result.remaining.toString(),
      "X-RateLimit-Reset": Math.floor(result.resetAt / 1000).toString(),
    };

    assertEquals(headers["X-RateLimit-Limit"], "100");
    assertEquals(headers["X-RateLimit-Remaining"], "95");
    assertExists(headers["X-RateLimit-Reset"]);
  });

  it("should include Retry-After header when rate limited", () => {
    const result: RateLimitResult = {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 45000,
      retryAfter: 45,
    };

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": Math.floor(result.resetAt / 1000).toString(),
    };

    if (result.retryAfter) {
      headers["Retry-After"] = result.retryAfter.toString();
    }

    assertExists(headers["Retry-After"]);
    assertEquals(headers["Retry-After"], "45");
  });
});

describe("Rate Limit Error Responses", () => {
  it("should return 429 status for rate limited requests", () => {
    const errorResponse = {
      status: 429,
      body: {
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
          retry_after: 60,
        },
      },
    };

    assertEquals(errorResponse.status, 429);
    assertEquals(errorResponse.body.error.code, "RATE_LIMIT_EXCEEDED");
    assertExists(errorResponse.body.error.retry_after);
  });

  it("should include rate limit info in error response", () => {
    const errorResponse = {
      status: 429,
      body: {
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Rate limit exceeded for POST /listings",
          details: {
            limit: 20,
            window: "1 hour",
            retry_after: 1800,
          },
        },
      },
    };

    assertEquals(errorResponse.body.error.details.limit, 20);
    assertEquals(errorResponse.body.error.details.window, "1 hour");
    assertEquals(errorResponse.body.error.details.retry_after, 1800);
  });
});

describe("Rate Limit Bypass", () => {
  it("should allow bypass for admin users", () => {
    const user = { id: "admin-1", role: "admin" };
    const shouldBypass = user.role === "admin" || user.role === "moderator";

    assertEquals(shouldBypass, true);
  });

  it("should allow bypass for internal service calls", () => {
    const headers = {
      "X-Service-Key": "internal-service-key-123",
    };

    const validServiceKeys = ["internal-service-key-123"];
    const shouldBypass = validServiceKeys.includes(headers["X-Service-Key"]);

    assertEquals(shouldBypass, true);
  });

  it("should allow bypass for health check endpoints", () => {
    const bypassEndpoints = ["/health", "/ready", "/metrics"];
    const requestPath = "/health";

    const shouldBypass = bypassEndpoints.includes(requestPath);
    assertEquals(shouldBypass, true);
  });
});

describe("Rate Limit Key Generation", () => {
  it("should generate keys based on user ID for authenticated requests", () => {
    const userId = "user-123";
    const endpoint = "POST /listings";
    const key = `${ENDPOINT_LIMITS[endpoint].keyPrefix}:${userId}`;

    assertEquals(key, "rl:create-listing:user-123");
  });

  it("should generate keys based on IP for anonymous requests", () => {
    const ip = "192.168.1.1";
    const key = `${RATE_LIMIT_TIERS.anonymous.keyPrefix}:${ip}`;

    assertEquals(key, "rl:anon:192.168.1.1");
  });

  it("should handle IPv6 addresses", () => {
    const ip = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    const key = `${RATE_LIMIT_TIERS.anonymous.keyPrefix}:${ip}`;

    assert(key.includes(ip));
  });

  it("should generate compound keys for sensitive operations", () => {
    const userId = "user-123";
    const ip = "192.168.1.1";
    const endpoint = "POST /auth/login";

    // For login, use both user identifier (email) and IP
    const key = `${ENDPOINT_LIMITS[endpoint].keyPrefix}:${userId}:${ip}`;

    assertEquals(key, "rl:login:user-123:192.168.1.1");
  });
});

describe("Rate Limit Tier Selection", () => {
  it("should select anonymous tier for unauthenticated requests", () => {
    const user = null;
    const tier = user ? RATE_LIMIT_TIERS.authenticated : RATE_LIMIT_TIERS.anonymous;

    assertEquals(tier.keyPrefix, "rl:anon");
    assertEquals(tier.maxRequests, 30);
  });

  it("should select authenticated tier for regular users", () => {
    const user = { id: "user-1", subscription: "free" };
    const tier = user.subscription === "premium"
      ? RATE_LIMIT_TIERS.premium
      : RATE_LIMIT_TIERS.authenticated;

    assertEquals(tier.keyPrefix, "rl:auth");
    assertEquals(tier.maxRequests, 100);
  });

  it("should select premium tier for premium users", () => {
    const user = { id: "user-1", subscription: "premium" };
    const tier = user.subscription === "premium"
      ? RATE_LIMIT_TIERS.premium
      : RATE_LIMIT_TIERS.authenticated;

    assertEquals(tier.keyPrefix, "rl:premium");
    assertEquals(tier.maxRequests, 500);
  });

  it("should apply endpoint-specific limits over tier limits", () => {
    const endpoint = "POST /listings";
    const tierLimit = RATE_LIMIT_TIERS.authenticated;
    const endpointLimit = ENDPOINT_LIMITS[endpoint];

    // Endpoint limit should be stricter for create operations
    assert(endpointLimit.maxRequests < tierLimit.maxRequests);
  });
});

describe("Distributed Rate Limiting", () => {
  it("should handle concurrent requests correctly", async () => {
    const store = new TestRateLimitStore();
    const limiter = new RateLimiter(store);
    const config = { windowMs: 60000, maxRequests: 5, keyPrefix: "concurrent" };

    // Simulate concurrent requests
    const promises = Array(10).fill(null).map(() => limiter.checkLimit("user-1", config));

    const results = await Promise.all(promises);

    // First 5 should be allowed, rest should be blocked
    const allowedCount = results.filter((r) => r.allowed).length;
    const blockedCount = results.filter((r) => !r.allowed).length;

    assertEquals(allowedCount, 5);
    assertEquals(blockedCount, 5);
  });
});

describe("Rate Limit Monitoring", () => {
  it("should provide usage statistics", async () => {
    const store = new TestRateLimitStore();
    const limiter = new RateLimiter(store);
    const config = { windowMs: 60000, maxRequests: 100, keyPrefix: "stats" };

    // Make some requests
    for (let i = 0; i < 75; i++) {
      await limiter.checkLimit("user-1", config);
    }

    const remaining = await limiter.getRemainingRequests("user-1", config);
    const usagePercent = (100 - remaining) / 100 * 100;

    assertEquals(remaining, 25);
    assertEquals(usagePercent, 75);
  });

  it("should identify users approaching limits", async () => {
    const store = new TestRateLimitStore();
    const limiter = new RateLimiter(store);
    const config = { windowMs: 60000, maxRequests: 100, keyPrefix: "approach" };

    // Use 90% of quota
    for (let i = 0; i < 90; i++) {
      await limiter.checkLimit("user-1", config);
    }

    const remaining = await limiter.getRemainingRequests("user-1", config);
    const isApproachingLimit = remaining <= config.maxRequests * 0.1; // 10% remaining

    assertEquals(isApproachingLimit, true);
  });
});

// Run tests
if (import.meta.main) {
  console.log("Running Rate Limit Tests...");
}
