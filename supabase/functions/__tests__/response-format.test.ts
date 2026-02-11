/**
 * Response Format Tests
 *
 * Ensures consistent response format across all endpoints
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildErrorResponse,
  buildSuccessResponse,
} from "../_shared/response-adapter.ts";
import { AppError, ValidationError } from "../_shared/errors.ts";

const mockCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

Deno.test("Response Format - Success response structure", () => {
  const data = { id: "123", name: "Test" };
  const response = buildSuccessResponse(data, mockCorsHeaders);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("Response Format - Success response body", async () => {
  const data = { id: "123", name: "Test" };
  const response = buildSuccessResponse(data, mockCorsHeaders);
  const body = await response.json();

  assertEquals(body.success, true);
  assertEquals(body.data, data);
  assertExists(body.meta);
  assertExists(body.meta.requestId);
  assertExists(body.meta.timestamp);
  assertExists(body.meta.responseTime);
});

Deno.test("Response Format - Error response structure", () => {
  const error = new ValidationError("Invalid input", { field: "email" });
  const response = buildErrorResponse(error, mockCorsHeaders);

  assertEquals(response.status, 400);
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("Response Format - Error response body", async () => {
  const error = new ValidationError("Invalid input", { field: "email" });
  const response = buildErrorResponse(error, mockCorsHeaders);
  const body = await response.json();

  assertEquals(body.success, false);
  assertExists(body.error);
  assertEquals(body.error.code, "VALIDATION_ERROR");
  assertEquals(body.error.message, "Invalid input");
  assertExists(body.meta);
});

Deno.test("Response Format - Pagination metadata", async () => {
  const items = [{ id: 1 }, { id: 2 }];
  const response = buildSuccessResponse(items, mockCorsHeaders, {
    pagination: {
      offset: 0,
      limit: 10,
      total: 50,
      hasMore: true,
      nextOffset: 10,
    },
  });

  const body = await response.json();
  assertExists(body.pagination);
  assertEquals(body.pagination.offset, 0);
  assertEquals(body.pagination.limit, 10);
  assertEquals(body.pagination.total, 50);
  assertEquals(body.pagination.hasMore, true);
  assertEquals(body.pagination.nextOffset, 10);
});

Deno.test("Response Format - Custom status code", () => {
  const data = { created: true };
  const response = buildSuccessResponse(data, mockCorsHeaders, { status: 201 });

  assertEquals(response.status, 201);
});

Deno.test("Response Format - Cache headers", () => {
  const data = { cached: true };
  const response = buildSuccessResponse(data, mockCorsHeaders, { cacheTTL: 300 });

  assertEquals(response.headers.get("Cache-Control"), "public, max-age=300");
});

Deno.test("Response Format - Version header", () => {
  const data = { versioned: true };
  const response = buildSuccessResponse(data, mockCorsHeaders, { version: "2.0" });

  assertExists(response.headers.get("X-API-Version"));
});

Deno.test("Response Format - Error with retry-after", () => {
  const error = new AppError("Rate limited", "RATE_LIMITED", 429);
  const response = buildErrorResponse(error, mockCorsHeaders, { retryAfterMs: 60000 });

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "60");
});
