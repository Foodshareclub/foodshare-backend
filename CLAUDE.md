# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FoodShare Backend is an enterprise-grade shared Supabase backend serving cross-platform apps (Web, iOS, Android). Used as a Git submodule in client applications.

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
functions/                  # Deno Edge Functions (40+)
├── _shared/               # Shared utilities (singleton patterns)
│   ├── cors.ts           # CORS with origin validation
│   ├── supabase.ts       # Connection-pooled Supabase client
│   ├── cache.ts          # In-memory TTL cache (70-90% DB reduction)
│   ├── email/            # Multi-provider email system
│   └── geocoding.ts      # Nominatim with caching/retry
├── email/                 # Unified email (4 providers)
├── send-push-notification/ # Cross-platform push (APNs/FCM/VAPID)
├── verify-attestation/    # iOS App Attest + DeviceCheck
├── check-login-rate/      # Brute force protection
└── */                     # Individual functions

migrations/                 # PostgreSQL migrations (enterprise security)
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
Used in push notifications, WhatsApp bot, and email providers:
```typescript
import { withCircuitBreaker } from "./utils/circuit-breaker.ts";

await withCircuitBreaker("serviceName", async () => {
  // operation that may fail
}, { failureThreshold: 5, resetTimeout: 60000 });
```
States: CLOSED → OPEN (after threshold) → HALF_OPEN (after timeout) → CLOSED (on success)

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
| **Core (all)** | `email/`, `send-push-notification/`, `health/`, `geolocate-user/` |
| **Web-only** | `telegram-bot-foodshare/`, `whatsapp-bot-foodshare/`, notifications |
| **Mobile-only** | `verify-attestation/`, `get-certificate-pins/`, `check-login-rate/`, listing CRUD |

### JWT Exceptions (no verification)
- `telegram-bot-foodshare/` - Webhook
- `whatsapp-bot-foodshare/` - Webhook
- `email/` - Service-to-service
- `health/` - Public endpoint

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

## Environment Variables

Required secrets (Supabase dashboard):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **iOS**: `APPLE_TEAM_ID`, `APP_BUNDLE_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`
- **Android**: `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`
- **Web Push**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
- **Email**: `RESEND_API_KEY`, `BREVO_API_KEY`, `AWS_*` (SES), `MAILERSEND_API_KEY`
