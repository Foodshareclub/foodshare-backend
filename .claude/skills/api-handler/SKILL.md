---
name: api-handler
description: Using createAPIHandler for Foodshare Edge Functions. Use when understanding the unified API handler pattern, route definitions, schema validation, response helpers, and error tracking.
---

<objective>
Use the createAPIHandler abstraction correctly for all Edge Functions with proper route handlers, schema validation, and response formatting.
</objective>

<essential_principles>
## Core File: `_shared/api-handler.ts`

All 27 Edge Functions use `createAPIHandler` which provides:
- Route-based request dispatching
- Schema validation (Zod or Valibot)
- Error tracking and performance monitoring
- Request logging via structured logger
- CORS handling
- Rate limiting

## Usage Pattern

```typescript
import { createAPIHandler, ok, created, paginated } from "../_shared/api-handler.ts";

Deno.serve(createAPIHandler({
  functionName: "api-v1-products",
  routes: {
    "GET /": handleListProducts,
    "GET /:id": handleGetProduct,
    "POST /": handleCreateProduct,
    "PUT /:id": handleUpdateProduct,
    "DELETE /:id": handleDeleteProduct,
  },
  cors: {
    allowMobile: true,
    additionalOrigins: ["https://foodshare.club"],
  },
  rateLimit: {
    maxRequests: 100,
    windowMs: 60_000,
  },
}));
```

## Route Handlers

Each handler receives `(req: Request, params: Record<string, string>)` and returns a Response:

```typescript
async function handleGetProduct(req: Request, params: Record<string, string>) {
  const { id } = params;
  const supabase = getSupabaseClient(req);

  const { data, error } = await supabase
    .from("food_listings")
    .select("*, profiles(display_name, avatar_url)")
    .eq("id", id)
    .single();

  if (error) throw error;
  if (!data) return notFound("Product not found");

  return ok(data);
}
```

## Response Helpers

| Helper | HTTP Status | Use When |
|--------|-------------|----------|
| `ok(data)` | 200 | Successful read/update |
| `created(data)` | 201 | Successful create |
| `paginated(data, total, page, limit)` | 200 | Paginated list |
| `notFound(message)` | 404 | Resource not found |
| `badRequest(message)` | 400 | Invalid input |

## Schema Validation

Supports both Zod and Valibot schemas:

```typescript
import { z } from "zod";

const CreateProductSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().min(10),
  quantity: z.number().positive(),
  latitude: z.number(),
  longitude: z.number(),
});

// In handler
async function handleCreateProduct(req: Request, params: Record<string, string>) {
  const body = await req.json();
  const validated = CreateProductSchema.parse(body);
  // ... use validated data
}
```

## Error Handling

Errors thrown in handlers are automatically caught, logged, and returned as structured error responses. The API handler:
1. Catches the error
2. Logs it with structured context via `logger.error`
3. Returns appropriate HTTP status
4. Tracks error metrics
</essential_principles>

<success_criteria>
API handler usage is correct when:
- [ ] All functions use `createAPIHandler` (not raw Deno.serve)
- [ ] Routes defined with HTTP method + path pattern
- [ ] Response helpers used (ok, created, paginated)
- [ ] Schema validation for POST/PUT bodies
- [ ] Errors thrown (not manually caught and formatted)
- [ ] CORS configured with `allowMobile: true`
</success_criteria>
