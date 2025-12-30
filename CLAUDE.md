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
└── foodshare/  (web)
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
functions/                  # Deno Edge Functions (42 active)
├── _shared/               # Shared utilities (singleton patterns)
│   ├── cors.ts           # CORS with origin validation
│   ├── supabase.ts       # Connection-pooled Supabase client
│   ├── cache.ts          # In-memory TTL cache (70-90% DB reduction)
│   ├── logger.ts         # Structured JSON logging with context
│   ├── errors.ts         # Standardized error types (AppError, NotFoundError, etc.)
│   ├── context.ts        # Request context (requestId, userId, platform)
│   ├── circuit-breaker.ts # Circuit breaker pattern for resilience
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
Used in push notifications, WhatsApp bot, Telegram bot, and email providers:
```typescript
import { withCircuitBreaker } from "../_shared/circuit-breaker.ts";

await withCircuitBreaker("serviceName", async () => {
  // operation that may fail
}, { failureThreshold: 5, resetTimeoutMs: 60000 });
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

### WhatsApp/Telegram Webhook Verification
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
- **Telegram**: `TELEGRAM_BOT_TOKEN`
