# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FoodShare Backend is an enterprise-grade shared Supabase backend serving cross-platform apps (Web, iOS, Android).

### Repository Structure

```
foodshare/
├── foodshare-backend/     ← This repo (source of truth)
├── foodshare-ios/
│   └── supabase → ../foodshare-backend  (symlink)
└── foodshare-web/
    └── supabase → ../foodshare-backend  (symlink)
```

Changes here are **instantly visible** to both iOS and Web apps via symlinks. No syncing required.

## Commands

```bash
# Local Development
supabase start                              # Start local Supabase stack
supabase functions serve                    # Serve Edge Functions locally

# Deployment
supabase functions deploy                   # Deploy all functions
supabase functions deploy <name> --no-verify-jwt  # Deploy webhook (no JWT)

# Database
supabase db push                            # Apply migrations
supabase migration new <name>               # Create migration
supabase migration list                     # View status

# Testing (from functions/ directory)
deno test --allow-all
```

## Architecture

```
functions/                  # Deno Edge Functions (50+ active)
├── _shared/               # Shared utilities (singleton patterns)
│   ├── api-handler.ts    # Unified API handler (Zod + Valibot support)
│   ├── cors.ts           # CORS with origin validation
│   ├── supabase.ts       # Connection-pooled Supabase client
│   ├── cache.ts          # In-memory TTL cache (70-90% DB reduction)
│   ├── logger.ts         # Structured JSON logging with context
│   ├── errors.ts         # Standardized error types
│   ├── context.ts        # Request context (requestId, userId, platform)
│   ├── circuit-breaker.ts # Circuit breaker pattern for resilience
│   ├── response-adapter.ts # Unified response format with backwards compatibility
│   ├── email/            # Multi-provider email system
│   └── geocoding.ts      # Nominatim with caching/retry
├── bff/                   # Backend-for-Frontend aggregation endpoints
├── email/                 # Unified email (4 providers)
├── send-push-notification/ # Cross-platform push (APNs/FCM/VAPID)
├── verify-attestation/    # iOS App Attest + DeviceCheck
├── check-login-rate/      # Brute force protection
└── */                     # Individual functions

migrations/                 # PostgreSQL migrations (enterprise security)
```

## Key Patterns

### API Handler (Unified)
All functions should use the unified API handler from `_shared/api-handler.ts`:

```typescript
import { createAPIHandler, ok } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const schema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export default createAPIHandler({
  service: "my-service",
  requireAuth: true,
  routes: {
    POST: {
      schema,
      handler: async (ctx) => {
        const { name, email } = ctx.body;
        // ... logic
        return ok({ success: true }, ctx);
      },
    },
  },
});
```

The handler supports both Zod and Valibot schemas automatically and includes:
- Automatic error tracking and alerting
- Performance monitoring
- Memory usage checks
- Request/response logging

### Performance Monitoring
Track performance of critical operations:

```typescript
import { measureAsync, PerformanceTimer } from "../_shared/performance.ts";

// Async operation
const result = await measureAsync("fetch-user-data", async () => {
  return await fetchUserData(userId);
}, { userId });

// Manual timing
const timer = new PerformanceTimer("complex-operation");
// ... do work
const durationMs = timer.end({ itemsProcessed: 100 });
```

### Query Optimization
Prevent N+1 queries with batch loading:

```typescript
import { createBatchLoader } from "../_shared/query-optimizer.ts";

const userLoader = createBatchLoader(async (userIds) => {
  const { data } = await supabase
    .from('users')
    .select('*')
    .in('id', userIds);
  return userIds.map(id => data.find(u => u.id === id));
});

// These will be batched into a single query
const user1 = await userLoader.load('id1');
const user2 = await userLoader.load('id2');
```

### Error Tracking
Automatic error tracking with severity classification:

```typescript
import { trackError } from "../_shared/error-tracking.ts";

try {
  await riskyOperation();
} catch (error) {
  trackError(error, {
    operation: "riskyOperation",
    userId,
    additionalContext: "...",
  });
  throw error;
}
```

Errors are automatically:
- Fingerprinted and deduplicated
- Classified by severity (low/medium/high/critical)
- Aggregated over time
- Alerted when thresholds are reached

### Structured Logging
Always use the structured logger, never console.log:

```typescript
import { logger } from "../_shared/logger.ts";

logger.info("Operation completed", { userId, itemCount: 5 });
logger.error("Operation failed", error);
logger.warn("Rate limit approaching", { remaining: 10 });
```

### Response Format
Use the unified response format via `response-adapter.ts`:

```typescript
import { buildSuccessResponse, buildErrorResponse } from "../_shared/response-adapter.ts";

// Success
return buildSuccessResponse(data, corsHeaders, { 
  pagination: { offset, limit, total, hasMore },
  version: "1"
});

// Error
return buildErrorResponse(error, corsHeaders, { version: "1" });
```

### Circuit Breaker
Use circuit breakers for external services:

```typescript
import { withCircuitBreaker } from "../_shared/circuit-breaker.ts";

await withCircuitBreaker("email-provider", async () => {
  return await sendEmail(params);
}, { failureThreshold: 5, resetTimeoutMs: 60000 });
```

## Security Patterns

### iOS Device Attestation (`verify-attestation/`)
- **App Attest**: CBOR attestation format, certificate chain validation, counter replay protection
- **Assertion**: Subsequent request verification with stored public keys
- **DeviceCheck**: Fallback for older devices
- **Risk Scoring**: Trust levels (unknown → trusted → verified → suspicious → blocked)

### Rate Limiting (`check-login-rate/`)
```
5 failed attempts  → 5 minute lockout
10 failed attempts → 30 minute lockout
20 failed attempts → 24 hour lockout + email alert
100 attempts/hour per IP → 1 hour IP block
```

### Database Security (migrations)
- RLS enabled on all tables with granular policies
- Function `search_path` hardening against injection
- Audit schema with `logged_actions` table
- Soft delete support (`deleted_at` columns)
- Email/data validation triggers

## Resilience Patterns

### Circuit Breaker
Used in push notifications, WhatsApp bot, Telegram bot, and email providers.
States: CLOSED → OPEN (after threshold) → HALF_OPEN (after timeout) → CLOSED (on success)

### Retry Logic
Exponential backoff with jitter for external API calls:
```typescript
import { retryWithBackoff } from "../_shared/retry.ts";

await retryWithBackoff(async () => {
  return await externalApiCall();
}, { maxRetries: 3, baseDelayMs: 1000 });
```

### Caching Strategy
Three-tier caching:
1. **Memory**: In-process cache for hot data (TTL: 5 min)
2. **Redis**: Distributed cache for shared data (TTL: 1 hour)
3. **Database**: Persistent storage with materialized views

## Database Patterns

### BFF Aggregation Endpoints
Single-call endpoints that return all data for a screen:
- `get_user_dashboard()` - Profile, notifications, listings, stats
- `get_user_feed()` - Nearby listings with distance calculation
- `get_listing_detail()` - Listing with owner profile and reviews

### Performance Indexes
All indexes created with `CONCURRENTLY` to avoid blocking:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_profile_active_created
  ON posts(profile_id, is_active, created_at DESC)
  WHERE deleted_at IS NULL;
```

### Audit Logging
All sensitive operations logged to `audit.logged_actions`:
```sql
INSERT INTO audit.logged_actions (
  schema_name, table_name, action, row_data, changed_fields, user_id
) VALUES (...);
```

## Testing

### Unit Tests
```bash
cd functions
deno test --allow-all __tests__/my-function.test.ts
```

### Integration Tests
```bash
deno test --allow-all __tests__/bff-integration.test.ts
```

### Run All Tests
```bash
cd functions
deno test --allow-all __tests__/*.test.ts
```

### Test Coverage
- API Handler: Comprehensive tests for validation, auth, CORS, pagination
- Response Format: Ensures consistent response structure
- Circuit Breaker: Tests state transitions and failure handling
- Performance: Benchmarks for critical operations

### Test Utilities
Use shared test utilities from `__tests__/test-utils.ts`:
```typescript
import { createTestContext, mockSupabaseClient } from "./__tests__/test-utils.ts";

const ctx = createTestContext({ userId: "test-user-id" });
const supabase = mockSupabaseClient();
```

## Monitoring & Observability

### Health Check
Advanced health endpoint at `/health-advanced`:
```bash
curl https://your-project.supabase.co/functions/v1/health-advanced
```

Returns:
- System metrics (memory, uptime)
- Database connectivity and latency
- Performance metrics and slow queries
- Error statistics and recent alerts
- Circuit breaker status
- Overall health status (healthy/degraded/unhealthy)

### Performance Metrics
Access performance data:
```typescript
import { getMetricsSummary, getSlowQueries } from "../_shared/performance.ts";

const metrics = getMetricsSummary(); // All operations
const slowQueries = getSlowQueries(10); // Last 10 slow queries
```

### Error Tracking
Access error data:
```typescript
import { getTrackedErrors, getErrorStats } from "../_shared/error-tracking.ts";

const errors = getTrackedErrors({ severity: "critical", limit: 20 });
const stats = getErrorStats();
```

## Best Practices

1. **Always use structured logging** - Never use console.log
2. **Use the unified API handler** - Consistent error handling and validation
3. **Add circuit breakers for external services** - Prevent cascading failures
4. **Create indexes CONCURRENTLY** - Avoid blocking production queries
5. **Use BFF endpoints for complex queries** - Reduce N+1 queries
6. **Enable RLS on all tables** - Security by default
7. **Add audit logging for sensitive operations** - Compliance and debugging
8. **Use soft deletes** - Data recovery and audit trail
9. **Cache aggressively** - Reduce database load
10. **Test edge cases** - Especially auth, rate limiting, and validation

## Common Issues

### Function Not Deploying
- Check `deno.json` for correct permissions
- Verify environment variables are set
- Check function logs: `supabase functions logs <name>`

### Database Connection Issues
- Use the shared Supabase client from `_shared/supabase.ts`
- Don't create multiple clients per request
- Connection pooling is handled automatically

### CORS Errors
- Use `getCorsHeadersWithMobile()` for all responses
- Handle OPTIONS preflight with `handleMobileCorsPrelight()`
- Add custom origins to `additionalOrigins` in API handler config

### Rate Limiting Not Working
- Use distributed rate limiting for multi-instance deployments
- Check Redis connection if using distributed mode
- Verify rate limit keys are unique per user/IP

### Webhook Functions Returning 401 Unauthorized
- **Root cause**: Function missing from root `config.toml` with `verify_jwt = false`
- Supabase enables JWT verification by default for all functions
- External webhooks (Telegram, WhatsApp, Meta) don't include JWT tokens
- **Fix**: Add function to root `config.toml`:
  ```toml
  [functions.telegram-bot-foodshare]
  verify_jwt = false
  ```
- Then redeploy: `supabase functions deploy <name> --no-verify-jwt`
- Verify with health check: `curl <function-url>/health`

## Migration Guide

### From Old API Handler to Unified Handler
1. Replace `import { createAPIHandler } from "../_shared/api-handler-v2.ts"` with `import { createAPIHandler } from "../_shared/api-handler.ts"`
2. Update response builders to use `ok()`, `created()`, `paginated()` helpers
3. Ensure error handling uses typed errors from `_shared/errors.ts`
4. Test thoroughly - response format is backwards compatible

### From Console.log to Structured Logger
1. Replace `console.log()` with `logger.info()`
2. Replace `console.error()` with `logger.error()`
3. Replace `console.warn()` with `logger.warn()`
4. Add structured context: `logger.info("message", { key: value })`

## Performance Optimization

### Query Optimization
- Use BFF endpoints for complex queries
- Add covering indexes for common query patterns
- Use `EXPLAIN ANALYZE` to identify slow queries
- Consider materialized views for expensive aggregations

### Caching Strategy
- Cache frequently accessed data in memory
- Use Redis for shared cache across instances
- Set appropriate TTLs based on data freshness requirements
- Invalidate cache on data mutations

### Function Optimization
- Minimize cold start time by reducing dependencies
- Use connection pooling for database connections
- Batch operations when possible
- Use streaming for large responses

## Monitoring & Observability

### Metrics
- Function execution time tracked automatically
- Error rates logged to `metrics.function_calls`
- Circuit breaker states exposed via health endpoints

### Logging
- All requests logged with requestId and correlationId
- Errors include stack traces and context
- Sensitive data automatically redacted

### Alerts
- Email alerts for critical errors
- Telegram notifications for rate limit violations
- Sentry integration for error tracking

## Support

For questions or issues:
1. Check this CLAUDE.md file
2. Review function README files
3. Check migration comments for database schema
4. Review test files for usage examples

### Retry with Exponential Backoff
```typescript
// Built into push notifications: 3 retries, 1s base delay, 10s max
await withRetry(operation, platform, CONFIG.maxRetries);
```

### Rate Limiting
```typescript
// Distributed (database-backed)
const result = await checkRateLimitDistributed(phoneNumber, 30, 60000);

// In-memory (sync, fast)
const allowed = checkRateLimit(phoneNumber, 30, 60000);
```

## Multi-Provider Systems

### Email Service (`_shared/email/`)
4 providers with automatic failover: Resend, Brevo, MailerSend, AWS SES

```typescript
import { getEmailService } from "../_shared/email/index.ts";

const emailService = getEmailService();

// Automatic provider selection by email type
await emailService.sendEmail(params, "welcome");

// Explicit provider
await emailService.sendEmailWithProvider(params, "resend");

// Health/quota monitoring
const health = await emailService.checkAllHealth();
```

Provider priority configured per email type (auth, chat, newsletter, etc.).

### Push Notifications (`send-push-notification/`)
Cross-platform with platform-specific optimizations:
- **iOS (APNs)**: JWT auth, ES256 signing, cached tokens (50 min)
- **Android (FCM v1)**: OAuth2, RS256 JWT, priority/TTL support
- **Web (VAPID)**: web-push library, subscription management

Features: Batch processing (100 concurrent), dead token cleanup, per-platform circuit breakers.

## Shared Utilities

### Supabase Client (singleton, connection pooled)
```typescript
import { getSupabaseClient } from "../_shared/supabase.ts";
const supabase = getSupabaseClient();  // Reuses connection
```

### CORS
```typescript
import { getCorsHeaders, handleCorsPrelight, getPermissiveCorsHeaders } from "../_shared/cors.ts";

// Secure (origin validation)
const headers = getCorsHeaders(request);

// Public APIs
const headers = getPermissiveCorsHeaders();
```

### Cache (in-memory with TTL)
```typescript
import { cache } from "../_shared/cache.ts";

const data = cache.get<T>("key");
cache.set("key", data, 300000);  // 5 min TTL
cache.getStats();  // { hits, misses, hitRate }
```

## Edge Function Pattern

**⚠️ DO NOT use JSR imports in Edge Functions:**
```typescript
// ❌ NEVER use this - causes cold start timeouts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ✅ Deno runtime provides types automatically - no import needed
```

The JSR package `@supabase/functions-js` has a broken OpenAI dependency that causes functions to hang indefinitely on cold start. Deno's runtime already provides all necessary types for `Deno.serve()` and `Deno.env`.

```typescript
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

const VERSION = "1.0.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsPrelight(req);

  const corsHeaders = getCorsHeaders(req);
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    const supabase = getSupabaseClient();
    // ... handler logic

    return new Response(JSON.stringify({ success: true, requestId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message, requestId }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
```

## Platform Categorization

| Category | Functions |
|----------|-----------|
| **Core (all)** | `email/`, `send-push-notification/`, `health/`, `geolocate-user/`, `feature-flags/` |
| **API v1 (REST)** | `api-v1-products/`, `api-v1-chat/`, `api-v1-metrics/` |
| **Sync & Events** | `sync/`, `track-event/` |
| **Web-only** | `telegram-bot-foodshare/`, `whatsapp-bot-foodshare/`, notifications |
| **Mobile-only** | `verify-attestation/`, `get-certificate-pins/`, `check-login-rate/`, listing CRUD |

### JWT Exceptions (no verification)
- `telegram-bot-foodshare/` - Webhook
- `whatsapp-bot-foodshare/` - Webhook
- `email/` - Service-to-service
- `health/` - Public endpoint
- `api-v1-products/` (GET only) - Public listing access

**⚠️ CRITICAL: Webhook functions MUST be configured in root `config.toml`:**
```toml
# config.toml (root level - NOT in function subdirectory)
[functions.telegram-bot-foodshare]
verify_jwt = false

[functions.whatsapp-bot-foodshare]
verify_jwt = false
```

Without this configuration, Supabase enables JWT verification by default, causing all webhook requests to fail with 401 Unauthorized. Per-function `config.toml` files are NOT used - only the root config matters.

## Database Patterns

### Audit Logging
```sql
-- All modifications logged to audit.logged_actions
-- Partitioned by month, indexed by table/action/timestamp
```

### Soft Deletes
Tables with `deleted_at`: posts, profiles, forum, challenges, rooms, comments

### Performance Indexes
- Covering indexes for common queries
- GiST indexes for geospatial (`location`)
- Partial indexes (`WHERE deleted_at IS NULL AND active = true`)

## Webhook Patterns

### Telegram Webhook Security
Telegram uses a secret token for webhook verification (simpler than HMAC):
```typescript
import { verifyTelegramWebhook } from "../_shared/webhook-security.ts";

// Telegram sends secret in X-Telegram-Bot-Api-Secret-Token header
const result = verifyTelegramWebhook(req.headers, WEBHOOK_SECRET);
if (!result.valid) {
  return new Response("Unauthorized", { status: 401 });
}
```

**Setup**: When calling `setWebhook`, include the secret token:
```typescript
await fetch(`${TELEGRAM_API}/setWebhook`, {
  method: "POST",
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: TELEGRAM_WEBHOOK_SECRET,  // Telegram will send this back
    allowed_updates: ["message", "callback_query"],
  }),
});
```

### WhatsApp/Meta Webhook Verification
```typescript
// GET: Meta webhook verification (hub.challenge)
if (req.method === "GET") {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
}

// POST: HMAC signature verification (X-Hub-Signature-256)
const signature = req.headers.get("X-Hub-Signature-256");
const isValid = await verifyWebhookSignature(rawBody, signature); // Constant-time comparison
```

### Webhook Response Pattern
```typescript
// Always return 200 to prevent retries (even on errors)
return new Response(JSON.stringify({ ok: false, error }), { status: 200 });
```

## Internationalization (i18n)

### Structure (`whatsapp-bot-foodshare/locales/`)
```typescript
// locales/en.ts, ru.ts, de.ts
export const en = {
  welcome: { title: "Welcome!", subtitle: "..." },
  auth: { invalidEmail: "...", codeExpired: "..." },
  // nested keys with {placeholder} support
};
```

### Usage
```typescript
import { t, detectLanguage, getUserLanguage } from "./lib/i18n.ts";

// Get translation with replacements
const msg = t("en", "impact.foodShared", { count: 5 });

// Detect from browser/device language code
const lang = detectLanguage("de");  // → "de"

// Get user preference from database
const userLang = await getUserLanguage(phoneNumber);
```

### i18n CLI Tool (`foodshare-i18n`)

Enterprise translation management CLI located in `tools/bins/foodshare-i18n/`.

```bash
# Build the CLI
cd tools && cargo build --release --package foodshare-i18n

# Basic commands
foodshare-i18n status                    # Translation system status
foodshare-i18n health --timing           # Health check with response times
foodshare-i18n locales                   # List supported locales (21 languages)
foodshare-i18n audit de --missing        # Audit German translations

# Testing
foodshare-i18n test en --delta --cache   # Test delta sync and ETag caching
foodshare-i18n test-llm --target es      # Test LLM translation endpoint
foodshare-i18n test-translation --locale ru  # End-to-end post translation test

# Deployment
foodshare-i18n deploy                    # Deploy migrations + edge functions
foodshare-i18n deploy --no-migrations    # Deploy only edge functions

# Translation updates
foodshare-i18n translate de --apply      # Auto-translate missing German keys
foodshare-i18n sync --apply              # Sync all locales
foodshare-i18n update-from-file de ./translations.json  # Update from file
foodshare-i18n update-batch de,fr,es     # Batch update multiple locales

# Backfill existing content
foodshare-i18n backfill --dry-run        # Preview posts to translate
foodshare-i18n backfill --limit 100      # Translate first 100 posts
foodshare-i18n backfill -b 20 -d 3000    # Custom batch size and delay

# Performance
foodshare-i18n bench --count 100         # Benchmark with 100 requests
```

Environment variables:
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for admin operations
- `LLM_TRANSLATION_ENDPOINT` - LLM API endpoint (optional)
- `LLM_TRANSLATION_API_KEY` - LLM API key (optional)

## Location Privacy

Deterministic 100-200m offset for user safety:
```typescript
import { approximateLocation } from "../_shared/location-privacy.ts";

// Same postId always produces same offset (seeded PRNG)
const approx = approximateLocation(lat, lng, postId);
// → { latitude: lat + offset, longitude: lng + offset }
```

## Utility Functions (`_shared/utils.ts`)

```typescript
import {
  retryWithJitter,      // Exponential backoff with jitter
  processInParallel,    // Batch processing with concurrency
  deduplicate,          // Request deduplication
  withTimeout,          // Timeout wrapper
  errorResponse,        // Standardized error response
  successResponse       // Standardized success response
} from "../_shared/utils.ts";

// Retry with jitter (prevents thundering herd)
await retryWithJitter(fn, 3, 1000);

// Process with concurrency limit
await processInParallel(items, processor, 10);

// Deduplicate concurrent identical requests
await deduplicate("cache-key", expensiveOperation);

// Timeout wrapper
await withTimeout(promise, 5000, "Request timed out");
```

## Structured Logging (`_shared/logger.ts`)

```typescript
import { logger } from "../_shared/logger.ts";

// Info logging with context
logger.info("Message handled", { userId, durationMs: 45 });

// Error logging with Error object
logger.error("Failed to process", new Error("Connection timeout"));

// Warning with sensitive data (auto-redacted)
logger.warn("Rate limit exceeded", { email: "user@example.com" });

// Timing helper
const done = logger.time("database query");
await db.query(...);
done({ rowCount: 42 });  // Logs: "database query completed" with duration

// Child logger with preset context
const requestLogger = logger.child({ requestId, service: "api-v1" });
requestLogger.info("Request started");
```

Features: Auto-redaction of sensitive fields (tokens, passwords), request context injection, log levels.

## Environment Variables

Required secrets (Supabase dashboard):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **iOS**: `APPLE_TEAM_ID`, `APP_BUNDLE_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`
- **Android**: `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`
- **Web Push**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- **Email**: `RESEND_API_KEY`, `BREVO_API_KEY`, `AWS_*` (SES), `MAILERSEND_API_KEY`
- **WhatsApp**: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
- **Telegram**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`

## Bot Health Monitoring

### Telegram Bot Health Check
```bash
# Health endpoint (no auth required)
curl https://***REMOVED***/functions/v1/telegram-bot-foodshare/health

# Metrics endpoint
curl https://***REMOVED***/functions/v1/telegram-bot-foodshare/metrics

# Re-register webhook (if bot stops responding)
curl "https://***REMOVED***/functions/v1/telegram-bot-foodshare/setup-webhook?url=https://***REMOVED***/functions/v1/telegram-bot-foodshare"
```

### Health Response Fields
```json
{
  "status": "healthy",           // healthy | degraded
  "version": "3.4.0",
  "dependencies": {
    "telegram": {
      "status": "CLOSED",        // Circuit breaker: CLOSED (ok) | OPEN (failing)
      "failures": 0
    }
  },
  "metrics": {
    "requestsTotal": 100,
    "requestsSuccess": 98,
    "requestsError": 2,
    "requests429": 0,            // Rate limited requests
    "avgLatencyMs": 45
  }
}
```

### Troubleshooting Bot Issues
1. **Check health**: `curl <bot-url>/health` - should return `status: "healthy"`
2. **Verify JWT disabled**: Check root `config.toml` has `verify_jwt = false`
3. **Re-register webhook**: Hit `/setup-webhook` endpoint
4. **Check circuit breaker**: If `telegram.status: "OPEN"`, Telegram API is failing
5. **Check secrets**: Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set
