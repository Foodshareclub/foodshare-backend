# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FoodShare Backend is a shared Supabase backend serving cross-platform apps (Web, iOS, Android). It's designed to be used as a Git submodule in client applications.

## Commands

### Local Development
```bash
supabase start              # Start local Supabase
supabase functions serve    # Serve all Edge Functions locally
```

### Deployment
```bash
supabase functions deploy                    # Deploy all functions
supabase functions deploy <name> --no-verify-jwt  # Deploy single function (webhooks)
```

### Database
```bash
supabase db push                      # Apply migrations
supabase migration new <name>         # Create new migration
supabase migration list               # View migration status
```

### Testing (Deno)
```bash
deno test --allow-all                 # Run tests (from functions directory)
```

## Architecture

### Structure
```
supabase/
├── migrations/     # PostgreSQL migrations (40+ files)
└── functions/      # Deno Edge Functions (40+ functions)
    ├── _shared/    # Shared utilities
    └── */          # Individual functions
```

### Edge Functions Runtime
- **Runtime**: Deno (not Node.js)
- **Config**: `supabase/functions/deno.json` - imports, compiler options
- **Key imports**: `@supabase/supabase-js`, `grammy` (Telegram), `zod`, `redis`

### Shared Utilities (`_shared/`)
- `cors.ts` - CORS handling with origin validation; use `getCorsHeaders(request)` for secure endpoints, `getPermissiveCorsHeaders()` for public APIs
- `supabase.ts` - Singleton Supabase client with connection pooling via `getSupabaseClient()`
- `response.ts` - Standard JSON response wrapper
- `geocoding.ts` - Nominatim geocoding with caching, rate limiting, retry logic
- `cache.ts` - Caching utilities
- `location-privacy.ts` - Location privacy utilities

### Platform Categorization (see `PLATFORM_GUIDE.md`)
- **Core (all platforms)**: `email/`, `send-push-notification/`, `search-functions/`, `health/`, `geolocate-user/`
- **Web-only**: Bot integrations (`telegram-bot-foodshare/`, `whatsapp-bot-foodshare/`), notifications, analytics
- **Mobile-only**: `verify-attestation/`, `get-certificate-pins/`, listing CRUD, cache management

### JWT Verification
Most functions require JWT auth. Exceptions (no JWT):
- `telegram-bot-foodshare/` - Webhook
- `whatsapp-bot-foodshare/` - Webhook
- `email/` - Service-to-service
- `health/` - Public endpoint

### Email Service (`email/`)
Unified email function supporting multiple providers with action-based routing:
- `action: "send"` - Send with explicit provider (resend, brevo, aws_ses, mailersend)
- `action: "process-queue"` - Process queued emails
- `action: "route"` - Get provider recommendation based on health/quota
- `action: "health"` - Monitor provider health

### Edge Function Pattern
Standard function structure:
```typescript
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const corsHeaders = getCorsHeaders(req);
  const supabase = getSupabaseClient();
  // ... handler logic
});
```

## Environment Variables

Required secrets (set in Supabase dashboard):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `APPLE_TEAM_ID`, `APP_BUNDLE_ID` (iOS attestation)
- Email provider API keys (Resend, Brevo, AWS SES, MailerSend)
