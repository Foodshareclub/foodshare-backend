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
  expectedStatus: number,
): Promise<T> {
  assertEquals(
    response.status,
    expectedStatus,
    `Expected status ${expectedStatus}, got ${response.status}`,
  );
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
  expectedCode?: string,
): Promise<{ error: { code: string; message: string } }> {
  const body = await assertResponseStatus<{ error: { code: string; message: string } }>(
    response,
    expectedStatus,
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
export function createMockProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
export function createMockProfile(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
// Extended Mock Factories
// ============================================================================

/**
 * Create a mock Supabase client with `.rpc()` support
 */
export function createMockSupabaseClientWithRpc(config: {
  user?: MockUser | null;
  queryResults?: Map<string, unknown[]>;
  queryErrors?: Map<string, Error>;
  rpcResults?: Map<string, unknown>;
  rpcErrors?: Map<string, Error>;
} = {}): MockSupabaseClient & { rpc: (name: string, params?: unknown) => Promise<{ data: unknown; error: unknown }> } {
  const base = createMockSupabaseClient(config);
  const { rpcResults = new Map(), rpcErrors = new Map() } = config;

  return {
    ...base,
    rpc: async (name: string, _params?: unknown) => {
      const error = rpcErrors.get(name);
      if (error) return { data: null, error };
      const data = rpcResults.get(name) ?? null;
      return { data, error: null };
    },
  };
}

/**
 * Create a mock NotificationContext for testing notification handlers
 */
export function createMockNotificationContext(overrides: {
  user?: MockUser | null;
  queryResults?: Map<string, unknown[]>;
  rpcResults?: Map<string, unknown>;
} = {}): {
  supabase: ReturnType<typeof createMockSupabaseClientWithRpc>;
  requestId: string;
  userId?: string;
  isAdmin?: boolean;
} {
  const supabase = createMockSupabaseClientWithRpc({
    user: overrides.user,
    queryResults: overrides.queryResults,
    rpcResults: overrides.rpcResults,
  });

  return {
    supabase,
    requestId: `test-req-${crypto.randomUUID().slice(0, 8)}`,
    userId: overrides.user?.id || "test-user-id-12345",
    isAdmin: false,
  };
}

/**
 * Create a mock chat room
 */
export function createMockRoom(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    post_id: Math.floor(Math.random() * 10000),
    buyer_id: "buyer-user-id",
    seller_id: "seller-user-id",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock chat message
 */
export function createMockMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    room_id: crypto.randomUUID(),
    sender_id: "test-user-id-12345",
    content: "Hello, is this still available?",
    type: "text",
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

// ============================================================================
// Security Test Helpers
// ============================================================================

/**
 * Common XSS attack payloads for testing sanitization
 */
export const XSS_PAYLOADS = {
  /** Basic script injection */
  scriptTag: '<script>alert("XSS")</script>',
  /** Image onerror handler */
  imgOnerror: '<img src="x" onerror="alert(1)">',
  /** Event handler in div */
  divOnclick: '<div onclick="alert(1)">click me</div>',
  /** JavaScript URL scheme */
  javascriptUrl: '<a href="javascript:alert(1)">click</a>',
  /** SVG with onload */
  svgOnload: '<svg onload="alert(1)">',
  /** Body onload */
  bodyOnload: '<body onload="alert(1)">',
  /** Input with onfocus */
  inputOnfocus: '<input onfocus="alert(1)" autofocus>',
  /** Encoded script */
  encodedScript: "&lt;script&gt;alert(1)&lt;/script&gt;",
  /** Nested quotes */
  nestedQuotes: `"><script>alert("XSS")</script><"`,
  /** Unicode escape */
  unicodeEscape: "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e",
  /** Data URL */
  dataUrl: '<a href="data:text/html,<script>alert(1)</script>">',
  /** CSS expression */
  cssExpression: '<div style="background:expression(alert(1))">',
  /** Base64 encoded */
  base64Script: '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
} as const;

/**
 * Get all XSS payloads as an array
 */
export function getAllXssPayloads(): string[] {
  return Object.values(XSS_PAYLOADS);
}

/**
 * Generate XSS payload variations with context
 */
export function generateXssVariations(basePayload: string): string[] {
  return [
    basePayload,
    basePayload.toUpperCase(),
    basePayload.replace(/<(\w)/g, "< $1"), // Space after <
    basePayload.replace(/=/g, " = "), // Spaces around =
    `test ${basePayload} test`, // Surrounded by text
    `${basePayload}${basePayload}`, // Doubled
  ];
}

/**
 * SQL injection payloads for testing (for validation testing, not actual injection)
 */
export const SQL_INJECTION_PAYLOADS = [
  "'; DROP TABLE users; --",
  "1; DELETE FROM posts WHERE 1=1; --",
  "' OR '1'='1",
  "1 UNION SELECT * FROM users",
  "admin'--",
  "1; TRUNCATE TABLE posts; --",
] as const;

// ============================================================================
// Webhook Test Helpers
// ============================================================================

/**
 * Compute HMAC-SHA256 signature for webhook testing
 */
export async function computeTestHmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a mock Meta (WhatsApp/Facebook) webhook request
 */
export async function createMetaWebhookRequest(
  payload: unknown,
  secret: string,
  options: { valid?: boolean; path?: string } = {},
): Promise<Request> {
  const { valid = true, path = "/whatsapp-bot-foodshare" } = options;
  const body = JSON.stringify(payload);
  const signature = valid ? await computeTestHmac(body, secret) : "invalid_signature_12345";

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });
}

/**
 * Create a mock Telegram webhook request
 */
export function createTelegramWebhookRequest(
  payload: unknown,
  secret: string,
  options: { valid?: boolean; path?: string } = {},
): Request {
  const { valid = true, path = "/telegram-bot-foodshare" } = options;
  const body = JSON.stringify(payload);

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": valid ? secret : "invalid_token",
    },
    body,
  });
}

/**
 * Create a mock Stripe webhook request
 */
export async function createStripeWebhookRequest(
  payload: unknown,
  secret: string,
  options: { valid?: boolean; timestamp?: number; path?: string } = {},
): Promise<Request> {
  const { valid = true, path = "/stripe-webhook" } = options;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);

  const signedPayload = `${timestamp}.${body}`;
  const signature = valid ? await computeTestHmac(signedPayload, secret) : "invalid_signature";

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${timestamp},v1=${signature}`,
    },
    body,
  });
}

/**
 * Create a mock GitHub webhook request
 */
export async function createGitHubWebhookRequest(
  payload: unknown,
  secret: string,
  options: { valid?: boolean; event?: string; path?: string } = {},
): Promise<Request> {
  const { valid = true, event = "push", path = "/github-webhook" } = options;
  const body = JSON.stringify(payload);
  const signature = valid ? await computeTestHmac(body, secret) : "invalid_signature";

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${signature}`,
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": crypto.randomUUID(),
    },
    body,
  });
}

/**
 * Mock webhook payloads for testing
 */
export const MOCK_WEBHOOK_PAYLOADS = {
  whatsapp: {
    object: "whatsapp_business_account",
    entry: [{
      id: "123456789",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: "123456789" },
          messages: [{
            from: "1234567890",
            id: "wamid.test123",
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: "text",
            text: { body: "Hello" },
          }],
        },
      }],
    }],
  },
  telegram: {
    update_id: 123456789,
    message: {
      message_id: 1,
      from: { id: 123456, first_name: "Test", is_bot: false },
      chat: { id: 123456, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text: "/start",
    },
  },
  stripe: {
    id: "evt_test123",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test123",
        object: "checkout.session",
        amount_total: 1000,
        currency: "usd",
      },
    },
  },
  github: {
    ref: "refs/heads/main",
    repository: {
      id: 123456789,
      name: "test-repo",
      full_name: "user/test-repo",
    },
    pusher: { name: "testuser" },
    commits: [{ id: "abc123", message: "Test commit" }],
  },
} as const;

// ============================================================================
// CSRF Test Helpers
// ============================================================================

/**
 * Create a request with specific Origin header for CSRF testing
 */
export function createRequestWithOrigin(
  origin: string | null,
  options: { method?: string; path?: string; referer?: string } = {},
): Request {
  const { method = "POST", path = "/api/test", referer } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (origin !== null) {
    headers["Origin"] = origin;
  }
  if (referer) {
    headers["Referer"] = referer;
  }

  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify({}) : undefined,
  });
}

/**
 * Common CSRF bypass attempt origins
 */
export const MALICIOUS_ORIGINS = [
  "https://evil.com",
  "https://localhost.evil.com",
  "https://example.com.evil.com",
  "capacitor://localhost.evil.com",
  "ionic://localhost.attacker.com",
  "null", // Sandboxed iframe
  "file://",
  "http://localhost:3000", // Wrong protocol/port
] as const;

// ============================================================================
// Performance Test Helpers
// ============================================================================

/**
 * Measure async operation execution time
 */
export async function measureExecutionTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Measure sync operation execution time
 */
export function measureSyncExecutionTime<T>(
  fn: () => T,
): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Run a function multiple times and return statistics
 */
export async function benchmark(
  fn: () => Promise<void>,
  iterations: number = 100,
): Promise<{
  min: number;
  max: number;
  avg: number;
  p95: number;
  p99: number;
}> {
  const times: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const { durationMs } = await measureExecutionTime(fn);
    times.push(durationMs);
  }

  times.sort((a, b) => a - b);

  return {
    min: times[0],
    max: times[times.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    p95: times[Math.floor(times.length * 0.95)],
    p99: times[Math.floor(times.length * 0.99)],
  };
}

/**
 * Assert that an operation completes within a time limit
 */
export async function assertExecutionTime<T>(
  fn: () => Promise<T>,
  maxMs: number,
  description?: string,
): Promise<T> {
  const { result, durationMs } = await measureExecutionTime(fn);
  if (durationMs > maxMs) {
    throw new Error(
      `${description || "Operation"} took ${durationMs.toFixed(2)}ms, ` +
        `exceeding limit of ${maxMs}ms`,
    );
  }
  return result;
}

// ============================================================================
// Input Validation Test Helpers
// ============================================================================

/**
 * Boundary values for numeric input testing
 */
export const NUMERIC_BOUNDARIES = {
  int32: {
    min: -2147483648,
    max: 2147483647,
    overflow: 2147483648,
    underflow: -2147483649,
  },
  positiveInt: {
    valid: [1, 100, 1000000],
    invalid: [0, -1, -100, 1.5, NaN, Infinity],
  },
  latitude: {
    valid: [0, 45.5, 90, -90, -45.5],
    invalid: [-91, 91, 180, -180],
  },
  longitude: {
    valid: [0, 90, 180, -180, -90],
    invalid: [-181, 181, 360, -360],
  },
  pagination: {
    validLimit: [1, 10, 50, 100],
    invalidLimit: [0, -1, 1001, NaN],
    validOffset: [0, 10, 100],
    invalidOffset: [-1, NaN],
  },
} as const;

/**
 * String edge cases for input validation testing
 */
export const STRING_EDGE_CASES = {
  /** Empty and whitespace */
  empty: "",
  whitespace: "   ",
  tabs: "\t\t\t",
  newlines: "\n\n\n",
  mixedWhitespace: " \t\n ",

  /** Unicode edge cases */
  unicode: "Hello 世界 🌍",
  rtl: "مرحبا",
  zalgo: "H̷̡̛̺̤̫̯̖̊̈́̃̓̋̅e̵̢̛̞̣̹̣̬̱̊͆̓̑́̋̅l̵̨͖̤̱̞̣͖̓́̽͜͝l̵͔̟̫̯̈́̓̈́̀͆͝o̵̡̨̭̲͖̬̓́͋̑̀̅̚",
  homoglyph: "рaypal.com", // Cyrillic 'р' looks like Latin 'p'

  /** Length edge cases */
  veryLong: "x".repeat(10000),
  maxUint16: "x".repeat(65535),

  /** Control characters */
  nullByte: "test\x00value",
  controlChars: "\x00\x01\x02\x03",
} as const;

/**
 * Email validation test cases
 */
export const EMAIL_TEST_CASES = {
  valid: [
    "user@example.com",
    "user.name@example.com",
    "user+tag@example.com",
    "user@subdomain.example.com",
  ],
  invalid: [
    "", // Empty
    "user", // No @
    "@example.com", // No local part
    "user@", // No domain
    "user@@example.com", // Double @
    "user@.com", // Domain starts with dot
    "user@example..com", // Consecutive dots
    "user@example.c", // Single char TLD
    "user@example.toolongtldtoolongtld", // TLD too long
    " user@example.com", // Leading space
    "user@example.com ", // Trailing space
  ],
} as const;
