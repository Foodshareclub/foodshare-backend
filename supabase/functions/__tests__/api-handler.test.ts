/**
 * API Handler Tests
 *
 * Comprehensive test suite for the unified API handler
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createAPIHandler, created, ok, paginated } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// Mock Supabase client (available for future test expansion)
// @ts-ignore Kept for future tests
const _mockSupabase = {
  auth: {
    getUser: () =>
      Promise.resolve({
        data: { user: { id: "test-user-id" } },
        error: null,
      }),
  },
  from: () => ({
    select: () => ({
      eq: () => Promise.resolve({ data: [], error: null }),
    }),
  }),
};

Deno.test("API Handler - GET request without auth", async () => {
  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      GET: {
        handler: async (ctx) => {
          return ok({ message: "Hello World" }, ctx);
        },
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "GET",
  });

  const response = await handler(request);
  assertEquals(response.status, 200);

  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.data.message, "Hello World");
  assertExists(body.meta.requestId);
  assertExists(body.meta.timestamp);
});

Deno.test("API Handler - POST with Zod validation", async () => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
  });

  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      POST: {
        schema,
        handler: async (ctx) => {
          return created({ id: "123", ...(ctx.body as Record<string, unknown>) }, ctx);
        },
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "John", email: "john@example.com" }),
  });

  const response = await handler(request);
  assertEquals(response.status, 201);

  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.data.name, "John");
  assertEquals(body.data.email, "john@example.com");
});

Deno.test("API Handler - Validation error", async () => {
  const schema = z.object({
    email: z.string().email(),
  });

  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      POST: {
        schema,
        handler: async (ctx) => {
          return ok(ctx.body, ctx);
        },
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "invalid-email" }),
  });

  const response = await handler(request);
  assertEquals(response.status, 400);

  const body = await response.json();
  assertEquals(body.success, false);
  assertEquals(body.error.code, "VALIDATION_ERROR");
});

Deno.test("API Handler - Method not allowed", async () => {
  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      GET: {
        handler: async (ctx) => ok({ message: "OK" }, ctx),
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "POST",
  });

  const response = await handler(request);
  assertEquals(response.status, 405);

  const body = await response.json();
  assertEquals(body.success, false);
  assertEquals(body.error.code, "METHOD_NOT_ALLOWED");
});

Deno.test("API Handler - CORS preflight", async () => {
  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      GET: {
        handler: async (ctx) => ok({ message: "OK" }, ctx),
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "OPTIONS",
  });

  const response = await handler(request);
  assertEquals(response.status, 204);
  assertExists(response.headers.get("Access-Control-Allow-Origin"));
});

Deno.test("API Handler - Pagination helper", async () => {
  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      GET: {
        handler: async (ctx) => {
          const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
          return paginated(items, ctx, {
            offset: 0,
            limit: 10,
            total: 100,
          });
        },
      },
    },
  });

  const request = new Request("https://example.com/test", {
    method: "GET",
  });

  const response = await handler(request);
  assertEquals(response.status, 200);

  const body = await response.json();
  assertEquals(body.success, true);
  assertEquals(body.data.length, 3);
  assertExists(body.pagination);
  assertEquals(body.pagination.hasMore, true);
  assertEquals(body.pagination.nextOffset, 10);
});

Deno.test("API Handler - Query parameter validation", async () => {
  const querySchema = z.object({
    page: z.string(),
    limit: z.string(),
  });

  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    routes: {
      GET: {
        querySchema,
        handler: async (ctx) => {
          return ok({ page: Number(ctx.query.page), limit: Number(ctx.query.limit) }, ctx);
        },
      },
    },
  });

  const request = new Request("https://example.com/test?page=2&limit=20", {
    method: "GET",
  });

  const response = await handler(request);
  assertEquals(response.status, 200);

  const body = await response.json();
  assertEquals(body.data.page, 2);
  assertEquals(body.data.limit, 20);
});

Deno.test("API Handler - Path parameter extraction", async () => {
  const handler = createAPIHandler({
    service: "test-service",
    requireAuth: false,
    pathPattern: "/products/:productId/reviews/:reviewId",
    routes: {
      GET: {
        handler: async (ctx) => {
          return ok({
            productId: ctx.params.productId,
            reviewId: ctx.params.reviewId,
          }, ctx);
        },
      },
    },
  });

  const request = new Request("https://example.com/products/123/reviews/456", {
    method: "GET",
  });

  const response = await handler(request);
  assertEquals(response.status, 200);

  const body = await response.json();
  assertEquals(body.data.productId, "123");
  assertEquals(body.data.reviewId, "456");
});
