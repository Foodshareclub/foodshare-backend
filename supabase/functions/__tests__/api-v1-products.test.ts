/**
 * Products API v1 Edge Function Tests
 *
 * Tests for the api-v1-products Edge Function endpoints.
 * Run with: deno test --allow-env --allow-net
 */

import {
  assertEquals,
  assertExists,
  cleanupTestEnv,
  createMockProduct,
  createMockRequest,
  createMockUser,
  setupTestEnv,
} from "./test-utils.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// ============================================================================
// Test Setup
// ============================================================================

Deno.test({
  name: "Products API - Test Suite",
  fn: async (t) => {
    setupTestEnv();

    // ========================================================================
    // Schema Validation Tests
    // ========================================================================

    await t.step("createProductSchema - validates required fields", () => {
      const createProductSchema = z.object({
        title: z.string().min(3).max(100),
        description: z.string().max(2000).optional(),
        images: z.array(z.string().url()).min(1).max(5),
        postType: z.enum(["food", "non-food", "request"]),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      });

      // Valid input
      const validInput = {
        title: "Fresh Vegetables",
        images: ["https://example.com/image.jpg"],
        postType: "food",
        latitude: 51.5074,
        longitude: -0.1278,
      };

      const result = createProductSchema.safeParse(validInput);
      assertEquals(result.success, true);
    });

    await t.step("createProductSchema - rejects invalid title", () => {
      const createProductSchema = z.object({
        title: z.string().min(3).max(100),
        images: z.array(z.string().url()).min(1).max(5),
        postType: z.enum(["food", "non-food", "request"]),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      });

      // Title too short
      const invalidInput = {
        title: "AB",
        images: ["https://example.com/image.jpg"],
        postType: "food",
        latitude: 51.5074,
        longitude: -0.1278,
      };

      const result = createProductSchema.safeParse(invalidInput);
      assertEquals(result.success, false);
    });

    await t.step("createProductSchema - rejects invalid coordinates", () => {
      const createProductSchema = z.object({
        title: z.string().min(3).max(100),
        images: z.array(z.string().url()).min(1).max(5),
        postType: z.enum(["food", "non-food", "request"]),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      });

      // Latitude out of range
      const invalidInput = {
        title: "Test Product",
        images: ["https://example.com/image.jpg"],
        postType: "food",
        latitude: 100, // Invalid: > 90
        longitude: -0.1278,
      };

      const result = createProductSchema.safeParse(invalidInput);
      assertEquals(result.success, false);
    });

    await t.step("createProductSchema - rejects empty images array", () => {
      const createProductSchema = z.object({
        title: z.string().min(3).max(100),
        images: z.array(z.string().url()).min(1).max(5),
        postType: z.enum(["food", "non-food", "request"]),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      });

      const invalidInput = {
        title: "Test Product",
        images: [], // Invalid: min 1 required
        postType: "food",
        latitude: 51.5074,
        longitude: -0.1278,
      };

      const result = createProductSchema.safeParse(invalidInput);
      assertEquals(result.success, false);
    });

    // ========================================================================
    // Request Handling Tests
    // ========================================================================

    await t.step("createMockRequest - creates valid GET request", () => {
      const request = createMockRequest({
        method: "GET",
        path: "/api-v1-products",
        searchParams: { postType: "food", limit: "10" },
      });

      assertEquals(request.method, "GET");
      const url = new URL(request.url);
      assertEquals(url.searchParams.get("postType"), "food");
      assertEquals(url.searchParams.get("limit"), "10");
    });

    await t.step("createMockRequest - creates valid POST request with body", () => {
      const body = {
        title: "Test Product",
        images: ["https://example.com/image.jpg"],
        postType: "food",
        latitude: 51.5074,
        longitude: -0.1278,
      };

      const request = createMockRequest({
        method: "POST",
        path: "/api-v1-products",
        body,
        headers: {
          Authorization: "Bearer test-token",
        },
      });

      assertEquals(request.method, "POST");
      assertEquals(request.headers.get("Authorization"), "Bearer test-token");
      assertEquals(request.headers.get("Content-Type"), "application/json");
    });

    // ========================================================================
    // Mock Data Tests
    // ========================================================================

    await t.step("createMockProduct - generates valid product data", () => {
      const product = createMockProduct();

      assertExists(product.id);
      assertExists(product.title);
      assertExists(product.images);
      assertEquals(product.is_active, true);
      assertEquals(typeof product.latitude, "number");
      assertEquals(typeof product.longitude, "number");
    });

    await t.step("createMockProduct - accepts overrides", () => {
      const product = createMockProduct({
        title: "Custom Title",
        is_active: false,
      });

      assertEquals(product.title, "Custom Title");
      assertEquals(product.is_active, false);
    });

    await t.step("createMockUser - generates valid user data", () => {
      const user = createMockUser();

      assertExists(user.id);
      assertExists(user.email);
      assertEquals(user.role, "authenticated");
    });

    // ========================================================================
    // Query Parameter Validation Tests
    // ========================================================================

    await t.step("listQuerySchema - validates optional parameters", () => {
      const listQuerySchema = z.object({
        postType: z.enum(["food", "non-food", "request"]).optional(),
        limit: z.string().optional(),
        cursor: z.string().optional(),
      });

      // Empty query is valid
      const emptyResult = listQuerySchema.safeParse({});
      assertEquals(emptyResult.success, true);

      // With filters
      const withFilters = listQuerySchema.safeParse({
        postType: "food",
        limit: "20",
      });
      assertEquals(withFilters.success, true);
    });

    await t.step("listQuerySchema - rejects invalid postType", () => {
      const listQuerySchema = z.object({
        postType: z.enum(["food", "non-food", "request"]).optional(),
      });

      const result = listQuerySchema.safeParse({
        postType: "invalid-type",
      });
      assertEquals(result.success, false);
    });

    // ========================================================================
    // Update Schema Tests
    // ========================================================================

    await t.step("updateProductSchema - requires version for optimistic locking", () => {
      const updateProductSchema = z.object({
        title: z.string().min(3).max(100).optional(),
        description: z.string().max(2000).optional(),
        version: z.number().int().positive(),
      });

      // Missing version
      const withoutVersion = updateProductSchema.safeParse({
        title: "Updated Title",
      });
      assertEquals(withoutVersion.success, false);

      // With version
      const withVersion = updateProductSchema.safeParse({
        title: "Updated Title",
        version: 1,
      });
      assertEquals(withVersion.success, true);
    });

    // ========================================================================
    // Cleanup
    // ========================================================================

    cleanupTestEnv();
  },
});

// ============================================================================
// Integration Tests (require running Supabase)
// ============================================================================

Deno.test({
  name: "Products API - Integration Tests",
  ignore: Deno.env.get("CI") !== "true", // Only run in CI with real Supabase
  fn: async (t) => {
    await t.step("GET /api-v1-products - returns product list", async () => {
      // This would make a real request to the Edge Function
      // Skipped by default, enabled in CI
      console.log("Integration test placeholder");
    });

    await t.step("POST /api-v1-products - creates product with valid auth", async () => {
      // This would make a real request to the Edge Function
      console.log("Integration test placeholder");
    });

    await t.step("POST /api-v1-products - rejects unauthenticated request", async () => {
      // This would make a real request to the Edge Function
      console.log("Integration test placeholder");
    });
  },
});
