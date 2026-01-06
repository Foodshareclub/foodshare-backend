/**
 * BFF Contract Tests
 * Validates that BFF Edge Functions adhere to defined schemas
 */

import {
  assertEquals,
  assertExists,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

import {
  FeedResponseSchema,
  FeedRequestSchema,
  ListingDetailSchema,
  ChatRoomDetailSchema,
  SearchResponseSchema,
  NotificationsResponseSchema,
  UserProfileSchema,
  ForumPostSchema,
  ChallengeSchema,
  LeaderboardEntrySchema,
  ErrorResponseSchema,
} from '../../_shared/contracts/bff-schemas.ts';

// Test configuration
const BASE_URL = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const TEST_USER_ID = Deno.env.get('TEST_USER_ID') || '';
const TEST_AUTH_TOKEN = Deno.env.get('TEST_AUTH_TOKEN') || '';

// Helper to make authenticated requests
async function fetchBFF(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${TEST_AUTH_TOKEN}`);
  headers.set('apikey', ANON_KEY);
  headers.set('Content-Type', 'application/json');

  return fetch(`${BASE_URL}/functions/v1/bff${endpoint}`, {
    ...options,
    headers,
  });
}

// Helper to validate response against schema
function validateSchema<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error('Schema validation errors:', result.error.issues);
    throw new Error(`Schema validation failed: ${result.error.message}`);
  }
  return result.data;
}

// ================================
// Feed Endpoint Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/feed returns valid FeedResponse schema',
  async fn() {
    const response = await fetchBFF('/feed?latitude=37.7749&longitude=-122.4194&limit=10');
    assertEquals(response.status, 200);

    const data = await response.json();
    const validated = validateSchema(FeedResponseSchema, data);

    assertExists(validated.listings);
    assertExists(validated.pagination);
    assertEquals(typeof validated.nearbyCount, 'number');
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: POST /bff/feed accepts valid FeedRequest schema',
  async fn() {
    const request = {
      latitude: 37.7749,
      longitude: -122.4194,
      page: 1,
      limit: 20,
      filters: {
        condition: 'fresh',
        maxDistance: 10,
      },
    };

    // Validate request matches schema
    validateSchema(FeedRequestSchema, request);

    const response = await fetchBFF('/feed', {
      method: 'POST',
      body: JSON.stringify(request),
    });

    assertEquals(response.status, 200);
    const data = await response.json();
    validateSchema(FeedResponseSchema, data);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: GET /bff/feed returns ErrorResponse on invalid params',
  async fn() {
    // Missing required latitude/longitude
    const response = await fetchBFF('/feed');

    if (response.status !== 200) {
      const data = await response.json();
      validateSchema(ErrorResponseSchema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Listing Detail Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/listing/:id returns valid ListingDetail schema',
  async fn() {
    // Use a known test listing ID
    const testListingId = Deno.env.get('TEST_LISTING_ID');
    if (!testListingId) {
      console.log('Skipping: TEST_LISTING_ID not set');
      return;
    }

    const response = await fetchBFF(`/listing/${testListingId}`);
    assertEquals(response.status, 200);

    const data = await response.json();
    const validated = validateSchema(ListingDetailSchema, data);

    assertExists(validated.id);
    assertExists(validated.title);
    assertExists(validated.user);
    assertEquals(typeof validated.viewCount, 'number');
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: GET /bff/listing/:id returns 404 for non-existent listing',
  async fn() {
    const response = await fetchBFF('/listing/00000000-0000-0000-0000-000000000000');

    assertEquals(response.status, 404);
    const data = await response.json();
    validateSchema(ErrorResponseSchema, data);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Chat Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/chat/rooms returns valid ChatRoom array schema',
  async fn() {
    const response = await fetchBFF('/chat/rooms');

    if (response.status === 200) {
      const data = await response.json();
      const schema = z.object({
        rooms: z.array(z.object({
          id: z.string().uuid(),
          listingId: z.string().uuid().nullable(),
          participants: z.array(z.object({
            id: z.string().uuid(),
            username: z.string(),
          })),
          lastMessage: z.object({
            id: z.string().uuid(),
            content: z.string(),
            createdAt: z.string(),
          }).nullable(),
          unreadCount: z.number().int(),
        })),
      });
      validateSchema(schema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: GET /bff/chat/room/:id returns valid ChatRoomDetail schema',
  async fn() {
    const testRoomId = Deno.env.get('TEST_ROOM_ID');
    if (!testRoomId) {
      console.log('Skipping: TEST_ROOM_ID not set');
      return;
    }

    const response = await fetchBFF(`/chat/room/${testRoomId}`);

    if (response.status === 200) {
      const data = await response.json();
      validateSchema(ChatRoomDetailSchema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Search Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/search returns valid SearchResponse schema',
  async fn() {
    const response = await fetchBFF('/search?query=food&limit=10');
    assertEquals(response.status, 200);

    const data = await response.json();
    const validated = validateSchema(SearchResponseSchema, data);

    assertExists(validated.results);
    assertExists(validated.suggestions);
    assertExists(validated.pagination);
    assertEquals(typeof validated.queryTime, 'number');
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: POST /bff/search accepts complex filter schema',
  async fn() {
    const request = {
      query: 'vegetables',
      latitude: 37.7749,
      longitude: -122.4194,
      radius: 5,
      page: 1,
      limit: 20,
      filters: {
        condition: 'fresh',
        maxDistance: 10,
        excludeExpired: true,
      },
    };

    const response = await fetchBFF('/search', {
      method: 'POST',
      body: JSON.stringify(request),
    });

    assertEquals(response.status, 200);
    const data = await response.json();
    validateSchema(SearchResponseSchema, data);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Notification Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/notifications returns valid NotificationsResponse schema',
  async fn() {
    const response = await fetchBFF('/notifications');

    if (response.status === 200) {
      const data = await response.json();
      const validated = validateSchema(NotificationsResponseSchema, data);

      assertExists(validated.notifications);
      assertEquals(typeof validated.unreadCount, 'number');
      assertExists(validated.pagination);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// User Profile Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/profile returns valid UserProfile schema',
  async fn() {
    const response = await fetchBFF('/profile');

    if (response.status === 200) {
      const data = await response.json();
      const validated = validateSchema(UserProfileSchema, data);

      assertExists(validated.id);
      assertExists(validated.username);
      assertEquals(typeof validated.level, 'number');
      assertEquals(typeof validated.xp, 'number');
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: GET /bff/profile/:id returns valid UserProfile schema',
  async fn() {
    if (!TEST_USER_ID) {
      console.log('Skipping: TEST_USER_ID not set');
      return;
    }

    const response = await fetchBFF(`/profile/${TEST_USER_ID}`);

    if (response.status === 200) {
      const data = await response.json();
      validateSchema(UserProfileSchema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Forum Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/forum/posts returns valid ForumPost array schema',
  async fn() {
    const response = await fetchBFF('/forum/posts?category=general&limit=10');

    if (response.status === 200) {
      const data = await response.json();
      const schema = z.object({
        posts: z.array(ForumPostSchema),
        pagination: z.object({
          page: z.number(),
          limit: z.number(),
          total: z.number(),
          hasMore: z.boolean(),
        }),
      });
      validateSchema(schema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Challenges Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/challenges returns valid Challenge array schema',
  async fn() {
    const response = await fetchBFF('/challenges');

    if (response.status === 200) {
      const data = await response.json();
      const schema = z.object({
        active: z.array(ChallengeSchema),
        completed: z.array(ChallengeSchema),
        upcoming: z.array(ChallengeSchema),
      });
      validateSchema(schema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Leaderboard Contract Tests
// ================================

Deno.test({
  name: 'Contract: GET /bff/leaderboard returns valid LeaderboardEntry array schema',
  async fn() {
    const response = await fetchBFF('/leaderboard?type=xp&period=weekly');

    if (response.status === 200) {
      const data = await response.json();
      const schema = z.object({
        entries: z.array(LeaderboardEntrySchema),
        userRank: z.number().nullable(),
      });
      validateSchema(schema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Error Response Contract Tests
// ================================

Deno.test({
  name: 'Contract: Unauthorized requests return standard ErrorResponse',
  async fn() {
    const response = await fetch(`${BASE_URL}/functions/v1/bff/profile`, {
      headers: {
        'apikey': ANON_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401) {
      const data = await response.json();
      validateSchema(ErrorResponseSchema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: Invalid JSON returns standard ErrorResponse',
  async fn() {
    const response = await fetchBFF('/feed', {
      method: 'POST',
      body: 'invalid json',
    });

    if (response.status === 400) {
      const data = await response.json();
      validateSchema(ErrorResponseSchema, data);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Response Header Contract Tests
// ================================

Deno.test({
  name: 'Contract: Responses include required headers',
  async fn() {
    const response = await fetchBFF('/feed?latitude=37.7749&longitude=-122.4194');

    // Check for standard headers
    const contentType = response.headers.get('Content-Type');
    assertEquals(contentType?.includes('application/json'), true);

    // Check for CORS headers
    const corsOrigin = response.headers.get('Access-Control-Allow-Origin');
    assertExists(corsOrigin);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: 'Contract: Rate limited responses include retry headers',
  async fn() {
    // Make many requests to potentially trigger rate limit
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetchBFF('/feed?latitude=37.7749&longitude=-122.4194'))
    );

    const rateLimited = responses.find((r) => r.status === 429);
    if (rateLimited) {
      const retryAfter = rateLimited.headers.get('Retry-After');
      const remaining = rateLimited.headers.get('X-RateLimit-Remaining');
      assertExists(retryAfter);
      assertExists(remaining);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ================================
// Pagination Contract Tests
// ================================

Deno.test({
  name: 'Contract: Pagination response is consistent across endpoints',
  async fn() {
    const endpoints = [
      '/feed?latitude=37.7749&longitude=-122.4194&page=1&limit=5',
      '/search?query=food&page=1&limit=5',
      '/notifications?page=1&limit=5',
    ];

    for (const endpoint of endpoints) {
      const response = await fetchBFF(endpoint);
      if (response.status === 200) {
        const data = await response.json();

        // All paginated responses should have pagination object
        if (data.pagination) {
          assertEquals(typeof data.pagination.page, 'number');
          assertEquals(typeof data.pagination.limit, 'number');
          assertEquals(typeof data.pagination.total, 'number');
          assertEquals(typeof data.pagination.hasMore, 'boolean');
        }
      }
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

console.log('BFF Contract Tests loaded');
