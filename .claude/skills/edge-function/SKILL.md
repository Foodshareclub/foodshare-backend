---
name: edge-function
description: Create and modify Deno Edge Functions for Foodshare backend. Use when adding new API endpoints, modifying existing functions, or troubleshooting edge function issues. Covers Deno.serve pattern, createAPIHandler, route handlers, CORS, and validation.
---

<objective>
Create production-ready Edge Functions using the Deno.serve + createAPIHandler pattern with proper CORS, validation, error handling, and structured logging.
</objective>

<essential_principles>
## Critical Rules (Non-Negotiable)

1. **Never use JSR imports** - They have a broken OpenAI dependency that hangs on cold start
2. **Always use `Deno.serve()`** - Self-hosted edge runtime requires `Deno.serve(createAPIHandler({...}))`, NOT `export default`
3. **Always use `createAPIHandler`** - From `_shared/api-handler.ts`. Includes error tracking, performance monitoring, request logging
4. **Always use structured logger** - Never `console.log`. Use `logger.info/error/warn` from `_shared/logger.ts`
5. **Singleton Supabase client** - Use `getSupabaseClient()` from `_shared/supabase.ts`
6. **No deno.lock** - Removed. Edge-runtime v1.70.1 resolves deps fresh
7. **Changes affect ALL platforms** - Web, iOS, and Android symlink to this `supabase/` directory

## New Function Template

```typescript
// supabase/functions/api-v1-{name}/index.ts
import { createAPIHandler, ok, created } from "../_shared/api-handler.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";

Deno.serve(createAPIHandler({
  functionName: "api-v1-{name}",
  routes: {
    "GET /": handleList,
    "GET /:id": handleGetById,
    "POST /": handleCreate,
  },
  cors: {
    allowMobile: true,
  },
}));

async function handleList(req: Request, params: Record<string, string>) {
  const supabase = getSupabaseClient(req);

  const { data, error } = await supabase
    .from("table_name")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("Failed to fetch items", { error });
    throw error;
  }

  return ok(data);
}

async function handleCreate(req: Request, params: Record<string, string>) {
  const body = await req.json();
  const supabase = getSupabaseClient(req);

  const { data, error } = await supabase
    .from("table_name")
    .insert(body)
    .select()
    .single();

  if (error) throw error;
  return created(data);
}
```

## Config Registration

Add to `supabase/config.toml`:
```toml
[functions.api-v1-{name}]
verify_jwt = false
```

JWT is handled internally by `createAPIHandler`, not by the runtime.

## CORS

```typescript
// For web clients
import { getCorsHeaders } from "../_shared/cors.ts";

// For mobile clients (iOS/Android)
import { getCorsHeadersWithMobile } from "../_shared/cors.ts";

// Handle preflight
import { handleCorsPrelight } from "../_shared/cors.ts";
```

## Key Shared Modules

| Module | Import | Purpose |
|--------|--------|---------|
| `_shared/api-handler.ts` | `createAPIHandler, ok, created, paginated` | Unified API handler |
| `_shared/supabase.ts` | `getSupabaseClient()` | Singleton Supabase client |
| `_shared/logger.ts` | `logger` | Structured logging |
| `_shared/cache.ts` | `cache` | Three-tier caching |
| `_shared/utils.ts` | `timingSafeEqual()` | Security utilities |
| `_shared/cors.ts` | `getCorsHeaders, getCorsHeadersWithMobile` | CORS headers |
| `_shared/circuit-breaker.ts` | `withCircuitBreaker` | Circuit breaker for external services |
| `_shared/webhook-security.ts` | `verifyWebhookSignature` | Webhook verification utilities |
| `_shared/rate-limiter.ts` | `rateLimit` | Rate limiting |
| `_shared/health-handler.ts` | `handleHealthCheck` | Health check handler |
</essential_principles>

## Common Pitfalls

| Problem | Solution |
|---------|----------|
| Function not loading | Check `docker compose logs functions`. Ensure `index.ts` with `Deno.serve()`. No deno.lock |
| CORS errors | Use `getCorsHeadersWithMobile()`. Handle OPTIONS preflight |
| 401 on webhook | Add to `config.toml` with `verify_jwt = false` |
| Cold start hanging | Remove any JSR imports |
| Connection issues | Use singleton `getSupabaseClient()`, never create multiple clients |

<success_criteria>
Edge function is correct when:
- [ ] Uses `Deno.serve(createAPIHandler({...}))` pattern
- [ ] Registered in `config.toml` with `verify_jwt = false`
- [ ] Uses structured logger (no console.log)
- [ ] Uses singleton Supabase client
- [ ] CORS configured for mobile clients
- [ ] No JSR imports
- [ ] No deno.lock file
</success_criteria>
