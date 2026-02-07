# Foodshare Backend

Shared Supabase backend (Deno Edge Functions + PostgreSQL) serving Web, iOS, and Android.

## Commands

| Command | Purpose |
|---------|---------|
| `supabase start` | Start local Supabase stack |
| `supabase functions serve` | Serve Edge Functions locally |
| `supabase functions deploy` | Deploy all functions |
| `supabase functions deploy <name> --no-verify-jwt` | Deploy webhook (no JWT) |
| `supabase db push` | Apply migrations |
| `supabase migration new <name>` | Create migration |
| `cd functions && deno test --allow-all` | Run all tests |

## Critical Rules

1. **Never use JSR imports** -- `import "jsr:@supabase/functions-js/edge-runtime.d.ts"` has a broken OpenAI dependency that hangs on cold start. Deno runtime provides all types for `Deno.serve()` and `Deno.env` automatically.
2. **Always use structured logger** -- Never `console.log`. Use `logger.info/error/warn` from `_shared/logger.ts` with structured context objects.
3. **Webhook functions MUST be in root config.toml** -- Per-function config.toml files are NOT used. Without root config, Supabase enables JWT verification by default, causing 401 on all webhook requests.
   ```toml
   # config.toml (root level ONLY)
   [functions.telegram-bot-foodshare]
   verify_jwt = false
   ```
4. **Use the unified API handler** -- All functions use `createAPIHandler` from `_shared/api-handler.ts`. Supports both Zod and Valibot schemas, includes error tracking, performance monitoring, and request logging.
5. **Singleton Supabase client** -- Use `getSupabaseClient()` from `_shared/supabase.ts`. Never create multiple clients per request. Connection pooling is automatic.
6. **Create indexes CONCURRENTLY** -- Always `CREATE INDEX CONCURRENTLY` to avoid blocking production queries.
7. **RLS on all tables** -- No exceptions. Use service role client only for admin operations.
8. **Changes affect ALL platforms** -- This repo is symlinked from `foodshare-web/supabase/` and `foodshare-ios/supabase/`. Every change instantly affects Web, iOS, and Android.
9. **Always return 200 from webhooks** -- Even on errors, to prevent retry storms from Telegram/WhatsApp/Meta.

## Architecture

```
functions/                    # Deno Edge Functions (50+)
  _shared/                    # Shared utilities (singletons)
    api-handler.ts            # Unified API handler (Zod + Valibot)
    cors.ts                   # CORS with origin validation
    supabase.ts               # Connection-pooled Supabase client
    cache.ts                  # In-memory TTL cache (70-90% DB reduction)
    logger.ts                 # Structured JSON logging (auto-redaction)
    errors.ts                 # Standardized error types
    context.ts                # Request context (requestId, userId, platform)
    circuit-breaker.ts        # Circuit breaker for external services
    response-adapter.ts       # Unified response format
    performance.ts            # measureAsync, PerformanceTimer
    error-tracking.ts         # Fingerprinted, severity-classified, auto-alerted
    query-optimizer.ts        # Batch loader (prevent N+1)
    retry.ts                  # Exponential backoff with jitter
    location-privacy.ts       # Deterministic 100-200m offset (seeded PRNG)
    email/                    # 4-provider email (Resend, Brevo, MailerSend, SES)
    aws-signer.ts             # AWSV4 signer (shared by SES + R2)
    r2-storage.ts             # Cloudflare R2 client
    webhook-security.ts       # Telegram/WhatsApp verification
    geocoding.ts              # Nominatim with caching/retry
    utils.ts                  # retryWithJitter, processInParallel, deduplicate, withTimeout
  bff/                        # Backend-for-Frontend aggregation endpoints
  email/                      # Unified email service
  send-push-notification/     # Cross-platform push (APNs/FCM/VAPID)
  verify-attestation/         # iOS App Attest + DeviceCheck
  check-login-rate/           # Brute force protection
  telegram-bot-foodshare/     # Telegram bot
  whatsapp-bot-foodshare/     # WhatsApp bot
  api-v1-*/                   # REST API endpoints

migrations/                   # PostgreSQL migrations
config.toml                   # Root config (JWT exceptions)
```

## Platform Categorization

| Category | Functions |
|----------|-----------|
| Core (all platforms) | `email/`, `send-push-notification/`, `api-v1-health/`, `geolocate-user/`, `feature-flags/` |
| API v1 (REST) | `api-v1-products/`, `api-v1-chat/`, `api-v1-metrics/`, `api-v1-images/` |
| Sync & Events | `sync/`, `track-event/` |
| Web-only | `telegram-bot-foodshare/`, `whatsapp-bot-foodshare/`, notifications |
| Mobile-only | `verify-attestation/`, `get-certificate-pins/`, `check-login-rate/`, listing CRUD |

**JWT exceptions** (configured in root `config.toml`): telegram-bot, whatsapp-bot, email (service-to-service), api-v1-health (public), api-v1-products GET (public listings).

## Key Patterns

**API handler**: All functions use `createAPIHandler` with route-based handlers returning `ok()`, `created()`, or `paginated()` helpers. Schemas validated automatically (Zod or Valibot).

**CORS**: Use `getCorsHeaders(request)` for origin-validated headers. Use `getCorsHeadersWithMobile()` for mobile clients. Handle OPTIONS with `handleCorsPrelight()`.

**Circuit breakers**: Wrap external services with `withCircuitBreaker(name, fn, opts)`. Used in push notifications, bots, and email providers. States: CLOSED -> OPEN (after threshold) -> HALF_OPEN (after timeout) -> CLOSED.

**Caching**: Three-tier: in-memory (TTL 5 min), Redis (distributed, TTL 1 hour), database (materialized views). `cache.get/set/getStats` from `_shared/cache.ts`.

**Batch loading**: `createBatchLoader()` from `_shared/query-optimizer.ts` to prevent N+1 queries in BFF endpoints.

**BFF endpoints**: Single-call aggregation for screens: `get_user_dashboard()`, `get_user_feed()`, `get_listing_detail()`.

**Location privacy**: `approximateLocation(lat, lng, postId)` applies deterministic 100-200m offset using seeded PRNG. Same postId always produces same offset.

## Security

**iOS attestation** (`verify-attestation/`): App Attest (CBOR, certificate chain, counter replay), Assertion (subsequent requests), DeviceCheck (fallback). Risk scoring: unknown -> trusted -> verified -> suspicious -> blocked.

**Rate limiting** (`check-login-rate/`):

| Threshold | Action |
|-----------|--------|
| 5 failed attempts | 5 min lockout |
| 10 failed attempts | 30 min lockout |
| 20 failed attempts | 24 hour lockout + email alert |
| 100 attempts/hour per IP | 1 hour IP block |

**Database security**: RLS on all tables, `search_path` hardening, audit schema (`audit.logged_actions` partitioned by month), soft deletes (`deleted_at` on posts, profiles, forum, challenges, rooms, comments), email/data validation triggers.

**Webhook verification**: Telegram uses secret token in `X-Telegram-Bot-Api-Secret-Token` header. WhatsApp/Meta uses HMAC `X-Hub-Signature-256` with constant-time comparison, plus `hub.challenge` for subscription verification.

## Multi-Provider Systems

**Email** (`_shared/email/`): 4 providers with automatic failover (Resend, Brevo, MailerSend, AWS SES). Priority configured per email type (auth, chat, newsletter). Health/quota monitoring via `emailService.checkAllHealth()`.

**Push notifications** (`send-push-notification/`): iOS (APNs JWT ES256, 50 min cached tokens), Android (FCM v1 OAuth2 RS256), Web (VAPID). Batch processing (100 concurrent), dead token cleanup, per-platform circuit breakers.

## Testing

Tests in `functions/__tests__/`. Use `createTestContext()` and `mockSupabaseClient()` from `__tests__/test-utils.ts`.

Coverage areas: API handler (validation, auth, CORS, pagination), response format, circuit breaker state transitions, performance benchmarks.

## i18n

WhatsApp bot locales in `whatsapp-bot-foodshare/locales/`. Use `t(locale, key, replacements)`, `detectLanguage()`, `getUserLanguage()`.

CLI tool `foodshare-i18n` in `tools/bins/foodshare-i18n/`: `status`, `audit <locale>`, `translate <locale> --apply`, `sync --apply`, `backfill`, `bench`. Build: `cd tools && cargo build --release --package foodshare-i18n`.

## Environment Variables

Required secrets (set in Supabase dashboard):

| Group | Variables |
|-------|-----------|
| Core | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| iOS (APNs) | `APPLE_TEAM_ID`, `APP_BUNDLE_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` |
| Android (FCM) | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` |
| Web Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |
| Email | `RESEND_API_KEY`, `BREVO_API_KEY`, `AWS_*` (SES), `MAILERSEND_API_KEY` |
| WhatsApp | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |
| R2 Storage | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` |
| i18n CLI | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LLM_TRANSLATION_ENDPOINT` (optional) |

Note: Vault secrets and Edge Function secrets are separate -- must set both independently.

## Common Pitfalls

- **Function not deploying** -- Check `deno.json` permissions, verify env vars are set, check logs: `supabase functions logs <name>`
- **CORS errors** -- Use `getCorsHeadersWithMobile()` for all responses. Handle OPTIONS preflight. Add custom origins to `additionalOrigins` in API handler config.
- **Webhook returning 401** -- Function missing from root `config.toml` with `verify_jwt = false`. Per-function configs are ignored.
- **Bot not responding** -- Check health: `curl <bot-url>/health`. Verify JWT disabled in root config. Re-register webhook via `/setup-webhook` endpoint. Check circuit breaker status.
- **Database connection issues** -- Use singleton client from `_shared/supabase.ts`. Never create multiple clients per request.
- **Cold start hanging** -- Remove any JSR imports. They cause indefinite hangs.
- **Rate limiting not working** -- Check Redis connection for distributed mode. Verify rate limit keys are unique per user/IP.
