---
name: backend-testing
description: Testing Edge Functions for Foodshare backend. Use when writing tests, setting up test contexts, or mocking Supabase clients. Covers createTestContext, mockSupabaseClient, and Deno test patterns.
---

<objective>
Write comprehensive tests for Edge Functions using the shared test utilities, mock Supabase clients, and Deno's built-in test runner.
</objective>

<essential_principles>
## Test Location & Commands

```
supabase/functions/__tests__/          # Test files
supabase/functions/__tests__/test-utils.ts  # Shared test utilities

# Run all tests
cd supabase/functions && deno test --allow-all

# Run specific test
cd supabase/functions && deno test --allow-all __tests__/api-v1-products.test.ts
```

## Test Utilities

### createTestContext

Creates a test request context with mocked auth and headers:

```typescript
import { createTestContext, mockSupabaseClient } from "./test-utils.ts";

Deno.test("GET / returns listings", async () => {
  const ctx = createTestContext({
    method: "GET",
    path: "/",
    userId: "test-user-uuid",
    headers: {
      Authorization: "Bearer test-token",
    },
  });

  // Use ctx.request in handler
  const response = await handleListProducts(ctx.request, {});

  assertEquals(response.status, 200);
  const body = await response.json();
  assertExists(body.data);
});
```

### mockSupabaseClient

Mocks the Supabase client for isolated testing:

```typescript
Deno.test("POST / creates listing", async () => {
  const mockClient = mockSupabaseClient({
    from: {
      food_listings: {
        insert: { data: { id: "new-id", title: "Test" }, error: null },
        select: { data: [{ id: "1", title: "Bread" }], error: null },
      },
    },
  });

  // Inject mock client into handler context
  const ctx = createTestContext({
    method: "POST",
    path: "/",
    body: { title: "Fresh Bread", description: "Homemade sourdough" },
    supabaseClient: mockClient,
  });

  const response = await handleCreateProduct(ctx.request, {});
  assertEquals(response.status, 201);
});
```

## Test Patterns

### Testing error handling
```typescript
Deno.test("GET /:id returns 404 for missing item", async () => {
  const mockClient = mockSupabaseClient({
    from: {
      food_listings: {
        select: { data: null, error: null },
      },
    },
  });

  const ctx = createTestContext({
    method: "GET",
    path: "/nonexistent-id",
    supabaseClient: mockClient,
  });

  const response = await handleGetProduct(ctx.request, { id: "nonexistent-id" });
  assertEquals(response.status, 404);
});
```

### Testing validation
```typescript
Deno.test("POST / rejects invalid body", async () => {
  const ctx = createTestContext({
    method: "POST",
    path: "/",
    body: { title: "" },  // too short
  });

  const response = await handleCreateProduct(ctx.request, {});
  assertEquals(response.status, 400);
});
```

### Testing CORS
```typescript
Deno.test("OPTIONS returns CORS headers", async () => {
  const ctx = createTestContext({
    method: "OPTIONS",
    path: "/",
    headers: { Origin: "https://foodshare.club" },
  });

  const response = await handler(ctx.request);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "https://foodshare.club");
});
```
</essential_principles>

<success_criteria>
Tests are correct when:
- [ ] Each Edge Function has a test file
- [ ] Test context created with `createTestContext`
- [ ] Supabase client mocked (no real database calls)
- [ ] Success, error, and edge cases covered
- [ ] CORS handling verified
- [ ] Validation rejection tested
- [ ] All tests pass with `deno test --allow-all`
</success_criteria>
