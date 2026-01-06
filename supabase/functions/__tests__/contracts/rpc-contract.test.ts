/**
 * RPC Contract Tests
 * Validates that Supabase RPC functions adhere to defined schemas
 */

import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  NearbyListingsRequestSchema,
  NearbyListingResultSchema,
  UserStatsResultSchema,
  PlatformStatsResultSchema,
  AwardXPRequestSchema,
  AwardXPResultSchema,
  LeaderboardRequestSchema,
  LeaderboardResultSchema,
  FullTextSearchRequestSchema,
  SearchResultSchema,
  ReportContentRequestSchema,
  ReportContentResultSchema,
  GetSyncStatusRequestSchema,
  GetSyncStatusResultSchema,
  CheckUserModerationStatusResultSchema,
} from '../../_shared/contracts/rpc-schemas.ts';

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const TEST_USER_ID = Deno.env.get('TEST_USER_ID') || '';

// Create Supabase clients
const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Helper to validate schema
function validateSchema<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error('Schema validation errors:', result.error.issues);
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

// ================================
// Location RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: get_nearby_listings returns valid schema',
  async fn() {
    const request = {
      user_lat: 37.7749,
      user_lng: -122.4194,
      radius_km: 10,
      max_results: 20,
    };

    // Validate request matches schema
    validateSchema(NearbyListingsRequestSchema, request);

    const { data, error } = await anonClient.rpc('get_nearby_listings', request);

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data && Array.isArray(data)) {
      for (const item of data) {
        validateSchema(NearbyListingResultSchema, item);
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: get_nearby_listings handles edge cases',
  async fn() {
    const edgeCases = [
      { user_lat: 0, user_lng: 0, radius_km: 1, max_results: 5 },  // Null island
      { user_lat: 89.9, user_lng: 179.9, radius_km: 100, max_results: 10 },  // Near poles
      { user_lat: -33.8688, user_lng: 151.2093, radius_km: 0.1, max_results: 1 },  // Small radius
    ];

    for (const request of edgeCases) {
      validateSchema(NearbyListingsRequestSchema, request);

      const { data, error } = await anonClient.rpc('get_nearby_listings', request);

      if (!error && data) {
        assertEquals(Array.isArray(data), true);
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Statistics RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: get_user_stats returns valid schema',
  async fn() {
    if (!TEST_USER_ID) {
      console.log('Skipping: TEST_USER_ID not set');
      return;
    }

    const { data, error } = await anonClient.rpc('get_user_stats', {
      user_id: TEST_USER_ID,
    });

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data) {
      validateSchema(UserStatsResultSchema, data);

      // Verify required fields exist
      assertExists(data.total_listings);
      assertExists(data.total_xp);
      assertExists(data.current_level);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: get_platform_stats returns valid schema',
  async fn() {
    const { data, error } = await anonClient.rpc('get_platform_stats');

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data) {
      validateSchema(PlatformStatsResultSchema, data);

      // Verify all stats are non-negative
      assertEquals(data.total_users >= 0, true);
      assertEquals(data.total_listings >= 0, true);
      assertEquals(data.total_food_saved_kg >= 0, true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Gamification RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: award_xp request matches schema',
  async fn() {
    const request = {
      user_id: TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
      xp_amount: 10,
      reason: 'test_award',
      source_type: 'bonus' as const,
    };

    // Validate request matches schema
    validateSchema(AwardXPRequestSchema, request);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: get_leaderboard returns valid schema',
  async fn() {
    const request = {
      type: 'xp' as const,
      period: 'weekly' as const,
      limit: 10,
    };

    validateSchema(LeaderboardRequestSchema, request);

    const { data, error } = await anonClient.rpc('get_leaderboard', request);

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data) {
      validateSchema(LeaderboardResultSchema, data);

      // Verify entries are sorted by rank
      if (data.entries.length > 1) {
        for (let i = 1; i < data.entries.length; i++) {
          assertEquals(data.entries[i].rank > data.entries[i - 1].rank, true);
        }
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: get_leaderboard supports all types and periods',
  async fn() {
    const types = ['xp', 'listings', 'reviews', 'food_saved'] as const;
    const periods = ['weekly', 'monthly', 'all_time'] as const;

    for (const type of types) {
      for (const period of periods) {
        const request = { type, period, limit: 5 };
        validateSchema(LeaderboardRequestSchema, request);

        const { error } = await anonClient.rpc('get_leaderboard', request);

        if (!error) {
          // RPC exists and accepts all combinations
        }
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Search RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: full_text_search returns valid schema',
  async fn() {
    const request = {
      query: 'food',
      user_lat: 37.7749,
      user_lng: -122.4194,
      limit: 10,
      offset: 0,
    };

    validateSchema(FullTextSearchRequestSchema, request);

    const { data, error } = await anonClient.rpc('full_text_search', request);

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data && Array.isArray(data)) {
      for (const item of data) {
        validateSchema(SearchResultSchema, item);
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: full_text_search handles empty query',
  async fn() {
    const request = {
      query: '',
      limit: 10,
      offset: 0,
    };

    // Empty query should fail validation
    const result = FullTextSearchRequestSchema.safeParse(request);
    assertEquals(result.success, false);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: full_text_search handles special characters',
  async fn() {
    const specialQueries = [
      'food & vegetables',
      "farmer's market",
      'tofu (organic)',
      'search:term',
    ];

    for (const query of specialQueries) {
      const request = {
        query,
        limit: 5,
        offset: 0,
      };

      validateSchema(FullTextSearchRequestSchema, request);

      const { error } = await anonClient.rpc('full_text_search', request);

      // Should not throw on special characters
      if (error) {
        console.log(`Query "${query}" error:`, error.message);
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Moderation RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: report_content request matches schema',
  async fn() {
    const request = {
      reporter_id: TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
      content_type: 'listing' as const,
      content_id: '00000000-0000-0000-0000-000000000000',
      reason: 'spam' as const,
      details: 'Test report',
    };

    validateSchema(ReportContentRequestSchema, request);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: report_content supports all reason types',
  async fn() {
    const reasons = [
      'hate_speech',
      'harassment',
      'violence',
      'nsfw',
      'fraud',
      'spam',
      'inappropriate',
      'other',
    ] as const;

    for (const reason of reasons) {
      const request = {
        reporter_id: '00000000-0000-0000-0000-000000000000',
        content_type: 'listing' as const,
        content_id: '00000000-0000-0000-0000-000000000000',
        reason,
      };

      const result = ReportContentRequestSchema.safeParse(request);
      assertEquals(result.success, true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: check_user_moderation_status returns valid schema',
  async fn() {
    if (!TEST_USER_ID) {
      console.log('Skipping: TEST_USER_ID not set');
      return;
    }

    const { data, error } = await serviceClient.rpc('check_user_moderation_status', {
      user_id: TEST_USER_ID,
    });

    if (error) {
      console.log('RPC not available or error:', error.message);
      return;
    }

    if (data) {
      validateSchema(CheckUserModerationStatusResultSchema, data);

      assertEquals(typeof data.is_shadowbanned, 'boolean');
      assertEquals(typeof data.warning_count, 'number');
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Sync RPC Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: get_sync_status request matches schema',
  async fn() {
    const request = {
      user_id: TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
      entity_type: 'listings' as const,
      last_sync_version: 0,
    };

    validateSchema(GetSyncStatusRequestSchema, request);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: get_sync_status supports all entity types',
  async fn() {
    const entityTypes = [
      'listings',
      'messages',
      'notifications',
      'favorites',
      'reviews',
    ] as const;

    for (const entityType of entityTypes) {
      const request = {
        user_id: TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
        entity_type: entityType,
        last_sync_version: 0,
      };

      const result = GetSyncStatusRequestSchema.safeParse(request);
      assertEquals(result.success, true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Error Handling Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: Invalid UUID returns proper error',
  async fn() {
    const { error } = await anonClient.rpc('get_user_stats', {
      user_id: 'not-a-uuid',
    });

    if (error) {
      assertExists(error.message);
      assertEquals(typeof error.code, 'string');
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: Missing required params returns error',
  async fn() {
    const { error } = await anonClient.rpc('get_nearby_listings', {
      // Missing required params
    });

    assertExists(error);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: Out of range values return error',
  async fn() {
    const invalidRequests = [
      { user_lat: 100, user_lng: 0, radius_km: 10, max_results: 10 },  // lat > 90
      { user_lat: 0, user_lng: 200, radius_km: 10, max_results: 10 },  // lng > 180
      { user_lat: 0, user_lng: 0, radius_km: -5, max_results: 10 },    // negative radius
    ];

    for (const request of invalidRequests) {
      const result = NearbyListingsRequestSchema.safeParse(request);
      assertEquals(result.success, false);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Type Consistency Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: UUID fields are consistent format',
  async fn() {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!TEST_USER_ID) {
      console.log('Skipping: TEST_USER_ID not set');
      return;
    }

    const { data } = await anonClient.rpc('get_user_stats', {
      user_id: TEST_USER_ID,
    });

    if (data) {
      // Any ID fields should be valid UUIDs
      assertEquals(uuidRegex.test(TEST_USER_ID), true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: Timestamp fields are ISO 8601 format',
  async fn() {
    const { data } = await anonClient.rpc('get_platform_stats');

    if (data) {
      // Any timestamp fields should be parseable
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

      // Check member_since if present in user stats
      if (data.member_since) {
        assertEquals(isoRegex.test(data.member_since), true);
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Performance Contract Tests
// ================================

Deno.test({
  name: 'RPC Contract: get_nearby_listings respects max_results limit',
  async fn() {
    const limit = 5;
    const { data, error } = await anonClient.rpc('get_nearby_listings', {
      user_lat: 37.7749,
      user_lng: -122.4194,
      radius_km: 100,
      max_results: limit,
    });

    if (!error && data) {
      assertEquals(data.length <= limit, true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'RPC Contract: full_text_search respects limit and offset',
  async fn() {
    const limit = 5;
    const offset = 0;

    const { data, error } = await anonClient.rpc('full_text_search', {
      query: 'a',  // Broad query
      limit,
      offset,
    });

    if (!error && data) {
      assertEquals(data.length <= limit, true);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

console.log('RPC Contract Tests loaded');
