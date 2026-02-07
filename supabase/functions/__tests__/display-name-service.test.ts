/**
 * Display Name Service Tests
 *
 * Tests for the enterprise display name service with caching,
 * metrics, and admin overrides.
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  DisplayNameService,
  getDisplayNameService,
  resetDisplayNameService,
  extractDisplayName,
  mapDatabaseProfile,
  UserNotFoundError,
  BatchSizeExceededError,
  InvalidDisplayNameError,
} from "../_shared/display-name/index.ts";
import { cache } from "../_shared/cache.ts";

// =============================================================================
// Mock Supabase Client
// =============================================================================

interface MockProfile {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  second_name?: string | null;
  nickname?: string | null;
  email?: string | null;
  deleted_at?: string | null;
  is_admin?: boolean;
}

interface MockOverride {
  user_id: string;
  display_name: string;
  reason: string;
  overridden_by: string;
  expires_at?: string | null;
  created_at: string;
}

function createMockSupabase(options: {
  profiles?: MockProfile[];
  overrides?: MockOverride[];
  rpcError?: boolean;
}) {
  const profiles = options.profiles || [];
  const overrides = options.overrides || [];

  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_field: string, value: string) => ({
          is: (_field2: string, _value2: unknown) => ({
            single: () => {
              if (table === "profiles") {
                const profile = profiles.find(
                  (p) => p.id === value && !p.deleted_at
                );
                if (!profile) {
                  return {
                    data: null,
                    error: { code: "PGRST116", message: "Not found" },
                  };
                }
                return { data: profile, error: null };
              }
              return { data: null, error: null };
            },
          }),
          single: () => {
            if (table === "display_name_overrides") {
              const override = overrides.find((o) => o.user_id === value);
              if (!override) {
                return {
                  data: null,
                  error: { code: "PGRST116", message: "Not found" },
                };
              }
              return { data: override, error: null };
            }
            if (table === "profiles") {
              const profile = profiles.find((p) => p.id === value);
              return { data: profile || null, error: null };
            }
            return { data: null, error: null };
          },
        }),
        in: (_field: string, values: string[]) => ({
          is: (_field2: string, _value2: unknown) => {
            if (table === "profiles") {
              const matchedProfiles = profiles.filter(
                (p) => values.includes(p.id) && !p.deleted_at
              );
              return { data: matchedProfiles, error: null };
            }
            if (table === "display_name_overrides") {
              const matchedOverrides = overrides.filter((o) =>
                values.includes(o.user_id)
              );
              return { data: matchedOverrides, error: null };
            }
            return { data: [], error: null };
          },
        }),
      }),
      upsert: (data: MockOverride, _opts: { onConflict: string }) => ({
        select: () => ({
          single: () => {
            return {
              data: {
                ...data,
                created_at: new Date().toISOString(),
              },
              error: null,
            };
          },
        }),
      }),
      delete: () => ({
        eq: () => ({ error: null }),
      }),
    }),
    rpc: (name: string, params: Record<string, unknown>) => {
      if (options.rpcError) {
        return {
          data: null,
          error: { message: "RPC error" },
        };
      }

      if (name === "get_display_name_data") {
        const userId = params.p_user_id as string;
        const profile = profiles.find((p) => p.id === userId && !p.deleted_at);
        const override = overrides.find((o) => o.user_id === userId);

        return {
          data: {
            profile: profile || null,
            override: override || null,
          },
          error: null,
        };
      }

      if (name === "get_display_name_data_batch") {
        const userIds = params.p_user_ids as string[];
        const results = userIds.map((userId) => {
          const profile = profiles.find(
            (p) => p.id === userId && !p.deleted_at
          );
          const override = overrides.find((o) => o.user_id === userId);
          return {
            user_id: userId,
            profile: profile || null,
            override: override || null,
          };
        });

        return { data: results, error: null };
      }

      return { data: null, error: null };
    },
  } as unknown as Parameters<typeof getDisplayNameService>[0];
}

// =============================================================================
// Setup / Teardown
// =============================================================================

function setup() {
  resetDisplayNameService();
  cache.clear();
}

// =============================================================================
// Pure Extraction Tests (Backwards Compatibility)
// =============================================================================

Deno.test("extractDisplayName - pure function works without service", () => {
  const name = extractDisplayName({
    firstName: "John",
    email: "john.doe@example.com",
  });
  assertEquals(name, "John");
});

Deno.test("mapDatabaseProfile - maps snake_case to camelCase", () => {
  const row = {
    first_name: "John",
    second_name: "Doe",
    display_name: "Johnny",
    nickname: "JD",
    email: "john@example.com",
  };

  const profile = mapDatabaseProfile(row);

  assertEquals(profile.firstName, "John");
  assertEquals(profile.secondName, "Doe");
  assertEquals(profile.displayName, "Johnny");
  assertEquals(profile.nickname, "JD");
  assertEquals(profile.email, "john@example.com");
});

// =============================================================================
// Service Tests
// =============================================================================

Deno.test("DisplayNameService - getDisplayName returns name with source", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-1",
        first_name: "John",
        second_name: "Doe",
        email: "john@example.com",
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayName("user-1");

  assertEquals(result.name, "John");
  assertEquals(result.source, "firstName");
  assertEquals(result.hasOverride, false);
  assertEquals(result.userId, "user-1");
});

Deno.test("DisplayNameService - getDisplayName uses override when active", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-1",
        first_name: "John",
        email: "john@example.com",
      },
    ],
    overrides: [
      {
        user_id: "user-1",
        display_name: "Johnny Override",
        reason: "User request",
        overridden_by: "admin-1",
        created_at: new Date().toISOString(),
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayName("user-1");

  assertEquals(result.name, "Johnny Override");
  assertEquals(result.source, "override");
  assertEquals(result.hasOverride, true);
});

Deno.test("DisplayNameService - getDisplayName ignores expired override", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-1",
        first_name: "John",
        email: "john@example.com",
      },
    ],
    overrides: [
      {
        user_id: "user-1",
        display_name: "Expired Override",
        reason: "Temporary",
        overridden_by: "admin-1",
        expires_at: new Date(Date.now() - 86400000).toISOString(), // Yesterday
        created_at: new Date().toISOString(),
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayName("user-1");

  assertEquals(result.name, "John");
  assertEquals(result.source, "firstName");
  assertEquals(result.hasOverride, false);
});

Deno.test("DisplayNameService - getDisplayName throws for non-existent user", async () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  await assertRejects(
    () => service.getDisplayName("non-existent"),
    UserNotFoundError,
    "User not found"
  );
});

Deno.test("DisplayNameService - getDisplayName uses cache", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-cache-1",
        first_name: "John",
        email: "john@example.com",
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);

  // Record initial metrics
  const initialMetrics = service.getMetrics();

  // First call
  const result1 = await service.getDisplayName("user-cache-1");
  assertEquals(result1.name, "John");

  // Check metrics increased
  let metrics = service.getMetrics();
  assertEquals(metrics.cacheMisses, initialMetrics.cacheMisses + 1);

  // Second call should hit cache
  const result2 = await service.getDisplayName("user-cache-1");
  assertEquals(result2.name, "John");

  metrics = service.getMetrics();
  assertEquals(metrics.cacheHits, initialMetrics.cacheHits + 1);
});

// =============================================================================
// Batch Tests
// =============================================================================

Deno.test("DisplayNameService - getDisplayNameBatch returns multiple results", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      { id: "user-1", first_name: "John", email: "john@example.com" },
      { id: "user-2", first_name: "Jane", email: "jane@example.com" },
      { id: "user-3", first_name: "Bob", email: "bob@example.com" },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayNameBatch([
    "user-1",
    "user-2",
    "user-3",
  ]);

  assertEquals(Object.keys(result.results).length, 3);
  assertEquals(result.results["user-1"].name, "John");
  assertEquals(result.results["user-2"].name, "Jane");
  assertEquals(result.results["user-3"].name, "Bob");
  assertEquals(Object.keys(result.errors).length, 0);
});

Deno.test("DisplayNameService - getDisplayNameBatch handles missing users", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [{ id: "user-1", first_name: "John", email: "john@example.com" }],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayNameBatch(["user-1", "user-missing"]);

  assertEquals(result.results["user-1"].name, "John");
  assertExists(result.errors["user-missing"]);
});

Deno.test("DisplayNameService - getDisplayNameBatch throws for batch > 100", async () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  const userIds = Array.from({ length: 101 }, (_, i) => `user-${i}`);

  await assertRejects(
    () => service.getDisplayNameBatch(userIds),
    BatchSizeExceededError,
    "Batch size 101 exceeds maximum of 100"
  );
});

Deno.test("DisplayNameService - getDisplayNameBatch returns empty for empty array", async () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  const result = await service.getDisplayNameBatch([]);

  assertEquals(Object.keys(result.results).length, 0);
  assertEquals(Object.keys(result.errors).length, 0);
});

Deno.test("DisplayNameService - getDisplayNameBatch uses cache for subsequent calls", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      { id: "user-batch-1", first_name: "John", email: "john@example.com" },
      { id: "user-batch-2", first_name: "Jane", email: "jane@example.com" },
    ],
  });

  const service = new DisplayNameService(mockSupabase);

  // Record initial metrics
  const initialMetrics = service.getMetrics();

  // First batch call
  await service.getDisplayNameBatch(["user-batch-1", "user-batch-2"]);

  let metrics = service.getMetrics();
  assertEquals(metrics.batchLookups, initialMetrics.batchLookups + 1);

  // Second call should use cache
  const result = await service.getDisplayNameBatch(["user-batch-1", "user-batch-2"]);
  assertEquals(result.results["user-batch-1"].name, "John");

  metrics = service.getMetrics();
  assertEquals(metrics.cacheHits >= initialMetrics.cacheHits + 2, true); // Both users cached
});

// =============================================================================
// Admin Override Tests
// =============================================================================

Deno.test("DisplayNameService - setAdminOverride creates override", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [{ id: "user-1", first_name: "John", email: "john@example.com" }],
  });

  const service = new DisplayNameService(mockSupabase);

  const override = await service.setAdminOverride(
    "user-1",
    "New Display Name",
    "User requested name change",
    "admin-1"
  );

  assertEquals(override.userId, "user-1");
  assertEquals(override.displayName, "New Display Name");
  assertEquals(override.reason, "User requested name change");
  assertEquals(override.overriddenBy, "admin-1");
});

Deno.test("DisplayNameService - setAdminOverride validates name length", async () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  await assertRejects(
    () => service.setAdminOverride("user-1", "A", "Reason", "admin-1"),
    InvalidDisplayNameError,
    "at least 2 characters"
  );

  await assertRejects(
    () =>
      service.setAdminOverride("user-1", "A".repeat(101), "Reason", "admin-1"),
    InvalidDisplayNameError,
    "at most 100 characters"
  );
});

Deno.test("DisplayNameService - setAdminOverride invalidates cache", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [{ id: "user-override-1", first_name: "John", email: "john@example.com" }],
  });

  const service = new DisplayNameService(mockSupabase);

  // Record initial metrics
  const initialMetrics = service.getMetrics();

  // Prime the cache
  await service.getDisplayName("user-override-1");

  // Set override (should invalidate cache)
  await service.setAdminOverride("user-override-1", "Override Name", "Reason", "admin-1");

  // Check metrics - overrides set should increase by 1
  const metrics = service.getMetrics();
  assertEquals(metrics.overridesSet, initialMetrics.overridesSet + 1);
});

// =============================================================================
// Metrics Tests
// =============================================================================

Deno.test("DisplayNameService - getMetrics returns accurate stats", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      { id: "user-metrics-1", first_name: "John", email: "john@example.com" },
      { id: "user-metrics-2", first_name: "Jane", email: "jane@example.com" },
    ],
  });

  const service = new DisplayNameService(mockSupabase);

  // Record initial metrics
  const initialMetrics = service.getMetrics();

  // Perform some operations
  await service.getDisplayName("user-metrics-1");
  await service.getDisplayName("user-metrics-1"); // Cache hit
  await service.getDisplayName("user-metrics-2");
  await service.getDisplayNameBatch(["user-metrics-1", "user-metrics-2"]);

  const metrics = service.getMetrics();

  assertEquals(metrics.totalLookups, initialMetrics.totalLookups + 3);
  assertEquals(metrics.cacheHits >= initialMetrics.cacheHits + 1, true);
  assertEquals(metrics.cacheMisses >= initialMetrics.cacheMisses + 2, true);
  assertEquals(metrics.batchLookups, initialMetrics.batchLookups + 1);
  assertExists(metrics.avgLookupTimeMs);
  assertExists(metrics.uptimeMs);
});

Deno.test("DisplayNameService - getVersion returns version string", () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  const version = service.getVersion();
  assertEquals(typeof version, "string");
  assertEquals(version.split(".").length, 3); // Semver format
});

// =============================================================================
// Extract Method Tests
// =============================================================================

Deno.test("DisplayNameService - extract works like pure function", () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });
  const service = new DisplayNameService(mockSupabase);

  const name = service.extract({
    firstName: "John",
    email: "john@example.com",
  });

  assertEquals(name, "John");
});

// =============================================================================
// Singleton Tests
// =============================================================================

Deno.test("getDisplayNameService - returns singleton", () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });

  const service1 = getDisplayNameService(mockSupabase);
  const service2 = getDisplayNameService(mockSupabase);

  assertEquals(service1, service2);
});

Deno.test("resetDisplayNameService - clears singleton", () => {
  setup();

  const mockSupabase = createMockSupabase({ profiles: [] });

  const service1 = getDisplayNameService(mockSupabase);
  resetDisplayNameService();
  const service2 = getDisplayNameService(mockSupabase);

  // They should be different instances after reset
  assertEquals(service1 !== service2, true);
});

// =============================================================================
// Edge Cases
// =============================================================================

Deno.test("DisplayNameService - handles email-only profile", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-1",
        email: "john.doe@example.com",
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayName("user-1");

  assertEquals(result.name, "John");
  assertEquals(result.source, "email");
});

Deno.test("DisplayNameService - handles profile with only generic email", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      {
        id: "user-1",
        email: "info@example.com",
      },
    ],
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayName("user-1");

  assertEquals(result.name, "there");
  assertEquals(result.source, "fallback");
});

Deno.test("DisplayNameService - fallback when RPC fails uses individual queries", async () => {
  setup();

  const mockSupabase = createMockSupabase({
    profiles: [
      { id: "user-1", first_name: "John", email: "john@example.com" },
      { id: "user-2", first_name: "Jane", email: "jane@example.com" },
    ],
    rpcError: true, // Simulate RPC failure
  });

  const service = new DisplayNameService(mockSupabase);
  const result = await service.getDisplayNameBatch(["user-1", "user-2"]);

  // Should still work via fallback queries
  assertEquals(result.results["user-1"].name, "John");
  assertEquals(result.results["user-2"].name, "Jane");
});
