# Foodshare Backend

Self-hosted Supabase backend (Docker Compose + Deno Edge Functions + PostgreSQL) serving Web, iOS, and Android.

**Self-hosted Supabase:**
- Studio (dashboard): https://studio.foodshare.club
- API: https://api.foodshare.club
- VPS: 152.53.136.84 (ARM64, 8GB RAM)

## Commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d` | Start all 14 services |
| `docker compose down` | Stop all services |
| `docker compose ps` | Check service health |
| `docker compose logs -f <service>` | Tail service logs |
| `docker compose restart <service>` | Restart a specific service |
| `docker exec supabase-db psql -U postgres` | PostgreSQL shell |
| `cd supabase/functions && deno test --allow-all` | Run all tests |

## Infrastructure

```
foodshare-backend/
  .env                             # Supabase secrets (gitignored)
  .env.functions                   # Edge function secrets (gitignored)
  docker-compose.yml               # 14 services (bleeding-edge images)
  supabase/                        # Shared across Web, iOS, Android
    config.toml                    # Function config (JWT exceptions)
    seed.sql                       # Email template seed data
    migrations/                    # PostgreSQL migrations
    functions/                     # Deno Edge Functions (27)
      main/index.ts                # Edge-runtime router (spawns workers)
      _shared/                     # Shared utilities (singletons)
      api-v1-*/                    # REST API endpoints (25)
      telegram-bot-foodshare/      # Telegram bot
      whatsapp-bot-foodshare/      # WhatsApp bot
  volumes/
    api/kong.yml                   # Kong API gateway config
    db/*.sql                       # DB init scripts (roles, jwt, webhooks, etc.)
    db/data/                       # PostgreSQL data (gitignored, docker-managed)
    functions -> ../supabase/functions  # Symlink for edge-runtime mount
    logs/vector.yml                # Log pipeline config
    pooler/pooler.exs              # Supavisor tenant config
    storage/                       # Supabase Storage data (gitignored)
    snippets/                      # Dashboard snippets (gitignored)
```

## Docker Services (14)

| Service | Image | Port |
|---------|-------|------|
| kong | kong:2.8.1 | 54321 (API gateway) |
| db | supabase/postgres:15.14.1.081 | internal (via Supavisor) |
| auth | supabase/gotrue:v2.186.0 | internal |
| rest | postgrest/postgrest:v14.4 | internal |
| realtime | supabase/realtime:v2.76.0 | internal |
| storage | supabase/storage-api:v1.37.7 | internal |
| imgproxy | darthsim/imgproxy:v3.30.1 | internal |
| meta | supabase/postgres-meta:v0.95.2 | internal |
| functions | supabase/edge-runtime:v1.70.1 | internal |
| studio | supabase/studio:2026.02.04 | internal |
| analytics | supabase/logflare:1.30.3 | internal |
| vector | timberio/vector:0.28.1-alpine | internal |
| supavisor | supabase/supavisor:2.7.4 | 5432, 6543 (pooler) |

Kong is the single entrypoint. Cloudflare tunnel routes to port 54321. Dashboard has basic-auth.

## Critical Rules

1. **Never use JSR imports** -- `import "jsr:@supabase/functions-js/edge-runtime.d.ts"` has a broken OpenAI dependency that hangs on cold start. Deno runtime provides all types for `Deno.serve()` and `Deno.env` automatically.
2. **Always use structured logger** -- Never `console.log`. Use `logger.info/error/warn` from `_shared/logger.ts` with structured context objects.
3. **All functions use `Deno.serve()` pattern** -- Self-hosted edge runtime requires `Deno.serve(createAPIHandler({...}))`, NOT `export default`. The `main/index.ts` router spawns isolated workers per function using `EdgeRuntime.userWorkers.create()`.
4. **Use the unified API handler** -- All functions use `createAPIHandler` from `_shared/api-handler.ts`. Supports both Zod and Valibot schemas, includes error tracking, performance monitoring, and request logging.
5. **Singleton Supabase client** -- Use `getSupabaseClient()` from `_shared/supabase.ts`. Never create multiple clients per request. Connection pooling is automatic.
6. **Create indexes CONCURRENTLY** -- Always `CREATE INDEX CONCURRENTLY` to avoid blocking production queries.
7. **RLS on all tables** -- No exceptions. Use service role client only for admin operations.
8. **Changes affect ALL platforms** -- `foodshare-web/supabase` and `foodshare-ios/supabase` symlink to `supabase/`. Every change instantly affects Web, iOS, and Android.
9. **Always return 200 from webhooks** -- Even on errors, to prevent retry storms from Telegram/WhatsApp/Meta.
10. **Edge function secrets in `.env.functions`** -- NOT vault. Vault encryption keys are per-DB-instance. All secrets go in `.env.functions` and are injected via docker-compose `env_file`.
11. **No deno.lock** -- Removed. Edge-runtime v1.70.1 resolves deps fresh. Old lock files cause boot errors.

## Functions (27 total)

| Category | Functions |
|----------|-----------|
| Core API | `api-v1-admin`, `api-v1-auth`, `api-v1-cache`, `api-v1-health`, `api-v1-feature-flags` |
| Content | `api-v1-products`, `api-v1-chat`, `api-v1-images`, `api-v1-reviews`, `api-v1-search`, `api-v1-forum` |
| Users | `api-v1-profile`, `api-v1-engagement`, `api-v1-metrics`, `api-v1-sync` |
| Comms | `api-v1-notifications`, `api-v1-email` |
| Platform | `api-v1-attestation`, `api-v1-geocoding`, `api-v1-localization`, `api-v1-validation` |
| Infra | `api-v1-ai`, `api-v1-alerts`, `api-v1-analytics`, `api-v1-subscription` |
| Bots | `telegram-bot-foodshare`, `whatsapp-bot-foodshare` |
| Runtime | `main` (edge-runtime router) |

All functions use `verify_jwt = false` in config.toml -- auth is handled internally by `createAPIHandler`.

## Key Patterns

**API handler**: All functions use `createAPIHandler` with route-based handlers returning `ok()`, `created()`, or `paginated()` helpers. Schemas validated automatically (Zod or Valibot).

**CORS**: Use `getCorsHeaders(request)` for origin-validated headers. Use `getCorsHeadersWithMobile()` for mobile clients. Handle OPTIONS with `handleCorsPrelight()`.

**Circuit breakers**: Wrap external services with `withCircuitBreaker(name, fn, opts)`. Used in bots, email providers, and geocoding. States: CLOSED -> OPEN (after threshold) -> HALF_OPEN (after timeout) -> CLOSED.

**Caching**: Three-tier: in-memory (TTL 5 min), Redis (distributed, TTL 1 hour), database (materialized views). `cache.get/set/getStats` from `_shared/cache.ts`.

**Location privacy**: `approximateLocation(lat, lng, postId)` applies deterministic 100-200m offset using seeded PRNG. Same postId always produces same offset.

## Security

**iOS attestation** (`api-v1-attestation`): App Attest (CBOR, certificate chain, counter replay), Assertion (subsequent requests), DeviceCheck (fallback). Risk scoring: unknown -> trusted -> verified -> suspicious -> blocked.

**Rate limiting**: Built into `createAPIHandler` via `rateLimit` config. Per-IP or per-user, configurable per function.

**Database security**: RLS on all tables, `search_path` hardening, audit schema (`audit.logged_actions` partitioned by month), soft deletes (`deleted_at` on posts, profiles, forum, challenges, rooms, comments), email/data validation triggers.

**Webhook verification**: Telegram uses secret token in `X-Telegram-Bot-Api-Secret-Token` header. WhatsApp/Meta uses HMAC `X-Hub-Signature-256` with constant-time comparison via `timingSafeEqual()` from `_shared/utils.ts`.

## Multi-Provider Systems

**Email** (`_shared/email/`): 4 providers with automatic failover (Resend, Brevo, MailerSend, AWS SES). Priority configured per email type (auth, chat, newsletter). Health/quota monitoring via `emailService.checkAllHealth()`.

## Testing

Tests in `supabase/functions/__tests__/`. Use `createTestContext()` and `mockSupabaseClient()` from `__tests__/test-utils.ts`.

## Environment Variables

Two env files (both gitignored, see `.env.example` and `.env.functions.example` for templates):

- **`.env`** -- Supabase infrastructure secrets (Postgres, JWT, Kong, GoTrue SMTP, Studio, Analytics)
- **`.env.functions`** -- Edge function secrets (AWS, R2, email providers, AI keys, bot tokens, Redis, RevenueCat, etc.)

## Deployment

Self-hosted on VPS — all deployments go through GitHub Actions CI/CD. **After every push, always check the deployment status via CI/CD:**

```bash
# Check latest CI/CD run status (always do this after pushing)
gh run list --limit 3
gh run view <run-id>              # Summary + job statuses
gh run view <run-id> --log-failed # Show failure logs
gh run watch <run-id>             # Live-stream a running deploy
```

The CI/CD pipeline runs: detect changes → test → security scan → validate migrations → lint → deploy gate → deploy to VPS → dry-run summary. Never SSH into the VPS to deploy manually — always push to `main` and let CI/CD handle it.

```bash
# Manual VPS access (debugging only, not for deploying)
autossh -M 0 -o ServerAliveInterval=6000 -o ServerAliveCountMax=6000 -o ConnectTimeout=10 -o ConnectionAttempts=6000 -i ~/.ssh/id_rsa_gitlab organic@vps.foodshare.club
```

## Common Pitfalls

- **Edge function not loading** -- Check `docker compose logs functions`. Ensure function dir has `index.ts` with `Deno.serve()`. No deno.lock.
- **CORS errors** -- Use `getCorsHeadersWithMobile()` for all responses. Handle OPTIONS preflight. Add custom origins to `additionalOrigins` in API handler config.
- **Webhook returning 401** -- Function missing from `supabase/config.toml` with `verify_jwt = false`. Per-function configs are ignored.
- **Bot not responding** -- Check health: `curl <bot-url>/health`. Verify JWT disabled in config. Re-register webhook via `/setup-webhook` endpoint. Check circuit breaker status.
- **Database connection issues** -- Use singleton client from `_shared/supabase.ts`. Never create multiple clients per request.
- **Cold start hanging** -- Remove any JSR imports. They cause indefinite hangs.
- **New secrets** -- Add to `.env.functions` on VPS, then `docker compose restart functions`.
- **Supavisor usernames** -- Tenant-qualified format: `postgres.foodshare` (not just `postgres`).
