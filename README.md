# FoodShare Backend

Shared Supabase backend for FoodShare cross-platform apps (Web, iOS, Android).

## Structure

```
foodshare-backend/
├── functions/            # Deno Edge Functions (40+)
│   ├── _shared/          # Shared utilities (Vault, logger, etc.)
│   └── */                # Individual functions
└── migrations/           # Database migrations
```

## Usage

This repository is the source of truth. Client apps link to it via symlinks:

```bash
# From foodshare (web) or foodshare-ios directory:
ln -s ../foodshare-backend supabase
```

Changes here are instantly visible to all client apps.

## Edge Functions

The backend orchestrates 28 Edge Functions (25 API endpoints, 2 bots, and 1 main router).

```bash
# Deploy all functions
supabase functions deploy

# Deploy specific function
supabase functions deploy email
```

## Local Development

```bash
supabase start            # Start local Supabase
supabase functions serve  # Serve functions locally
```

## Migrations

```bash
supabase db push                    # Apply migrations
supabase migration new <name>       # Create migration
supabase migration list             # View status
```

## Client Apps

- **Web**: [foodshare](https://github.com/Foodsharecom.flutterflow.foodshare) - Next.js app
- **iOS**: [foodshare-ios](https://github.com/Foodsharecom.flutterflow.foodshare-ios) - Swift app

## VPS Access

To access the self-hosted Supabase backend VPS:

```bash
autossh -M 0 -o ServerAliveInterval=6000 -o ServerAliveCountMax=6000 -o ConnectTimeout=10 -o ConnectionAttempts=6000 -i ~/.ssh/foodshare_id_ed25519 organic@backend.foodshare.club
```

## Secret Management

Operational secrets (API keys, credentials) are stored in the **Supabase Vault** with a fallback to `.env.functions`.

To access secrets in Edge Functions:
```typescript
import { getSecret } from "../_shared/vault.ts";
const apiKey = await getSecret("MY_API_KEY");
```
# Google OAuth configured - Sun Mar  8 18:10:24 PDT 2026
