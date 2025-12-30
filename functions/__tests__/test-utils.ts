/**
 * Edge Function Test Utilities
 *
 * Provides mocking and helper functions for testing Supabase Edge Functions.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Re-export assertions for convenience
export { assertEquals, assertExists };
export { assertRejects, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ============================================================================
// Types
// ============================================================================

export interface MockUser {
  id: string;
  email: string;
  role?: "authenticated" | "anon";
}

export interface MockRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
}

export interface MockSupabaseClient {
  auth: {
    getUser: () => Promise<{ data: { user: MockUser | null }; error: null }>;
  };
  from: (table: string) => MockQueryBuilder;
}

export interface MockQueryBuilder {
  select: (columns?: string) => MockQueryBuilder;
  insert: (data: unknown) => MockQueryBuilder;
  update: (data: unknown) => MockQueryBuilder;
  delete: () => MockQueryBuilder;
  eq: (column: string, value: unknown) => MockQueryBuilder;
  neq: (column: string, value: unknown) => MockQueryBuilder;
  in: (column: string, values: unknown[]) => MockQueryBuilder;
  is: (column: string, value: unknown) => MockQueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => MockQueryBuilder;
  limit: (count: number) => MockQueryBuilder;
  range: (from: number, to: number) => MockQueryBuilder;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (resolve: (result: { data: unknown[]; error: unknown }) => void) => void;
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock user for testing
 */
export function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: "test-user-id-12345",
    email: "test@example.com",
    role: "authenticated",
    ...overrides,
  };
}

/**
 * Create a mock Request object
 */
export function createMockRequest(config: MockRequest): Request {
  const url = new URL(`http://localhost${config.path}`);

  if (config.searchParams) {
    Object.entries(config.searchParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    ...config.headers,
  });

  return new Request(url.toString(), {
    method: config.method,
    headers,
    body: config.body ? JSON.stringify(config.body) : undefined,
  });
}

/**
 * Create a mock Supabase client
 */
export function createMockSupabaseClient(config: {
  user?: MockUser | null;
  queryResults?: Map<string, unknown[]>;
  queryErrors?: Map<string, Error>;
} = {}): MockSupabaseClient {
  const { user = createMockUser(), queryResults = new Map(), queryErrors = new Map() } = config;

  let currentTable = "";
  let currentQuery: unknown[] = [];

  const queryBuilder: MockQueryBuilder = {
    select: () => queryBuilder,
    insert: () => queryBuilder,
    update: () => queryBuilder,
    delete: () => queryBuilder,
    eq: () => queryBuilder,
    neq: () => queryBuilder,
    in: () => queryBuilder,
    is: () => queryBuilder,
    order: () => queryBuilder,
    limit: () => queryBuilder,
    range: () => queryBuilder,
    single: async () => {
      const error = queryErrors.get(currentTable);
      if (error) return { data: null, error };
      const data = queryResults.get(currentTable)?.[0] || null;
      return { data, error: null };
    },
    maybeSingle: async () => {
      const error = queryErrors.get(currentTable);
      if (error) return { data: null, error };
      const data = queryResults.get(currentTable)?.[0] || null;
      return { data, error: null };
    },
    then: (resolve) => {
      const error = queryErrors.get(currentTable);
      if (error) {
        resolve({ data: [], error });
        return;
      }
      currentQuery = queryResults.get(currentTable) || [];
      resolve({ data: currentQuery, error: null });
    },
  };

  return {
    auth: {
      getUser: async () => ({
        data: { user },
        error: null,
      }),
    },
    from: (table: string) => {
      currentTable = table;
      return queryBuilder;
    },
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Parse JSON response body
 */
export async function parseJsonResponse<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Failed to parse JSON response: ${text}`);
  }
}

/**
 * Assert response status and return parsed body
 */
export async function assertResponseStatus<T = unknown>(
  response: Response,
  expectedStatus: number
): Promise<T> {
  assertEquals(response.status, expectedStatus, `Expected status ${expectedStatus}, got ${response.status}`);
  return parseJsonResponse<T>(response);
}

/**
 * Assert successful JSON response
 */
export async function assertSuccessResponse<T = unknown>(response: Response): Promise<T> {
  const body = await assertResponseStatus<{ data: T }>(response, 200);
  assertExists(body.data, "Response should have data property");
  return body.data;
}

/**
 * Assert error response
 */
export async function assertErrorResponse(
  response: Response,
  expectedStatus: number,
  expectedCode?: string
): Promise<{ error: { code: string; message: string } }> {
  const body = await assertResponseStatus<{ error: { code: string; message: string } }>(
    response,
    expectedStatus
  );
  assertExists(body.error, "Response should have error property");
  if (expectedCode) {
    assertEquals(body.error.code, expectedCode, `Expected error code ${expectedCode}`);
  }
  return body;
}

// ============================================================================
// Test Data Generators
// ============================================================================

/**
 * Generate a mock product
 */
export function createMockProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Math.floor(Math.random() * 10000),
    title: "Test Product",
    description: "A test product description",
    images: ["https://example.com/image.jpg"],
    post_type: "food",
    latitude: 51.5074,
    longitude: -0.1278,
    pickup_address: "123 Test Street",
    is_active: true,
    profile_id: "test-user-id-12345",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

/**
 * Generate a mock profile
 */
export function createMockProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-user-id-12345",
    first_name: "Test",
    second_name: "User",
    email: "test@example.com",
    avatar_url: "https://example.com/avatar.jpg",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Environment Setup
// ============================================================================

/**
 * Set up test environment variables
 */
export function setupTestEnv(): void {
  Deno.env.set("SUPABASE_URL", "http://localhost:54321");
  Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
}

/**
 * Clean up test environment
 */
export function cleanupTestEnv(): void {
  Deno.env.delete("SUPABASE_URL");
  Deno.env.delete("SUPABASE_ANON_KEY");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
}
