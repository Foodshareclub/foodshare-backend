# FoodShare Backend

Shared Supabase backend for FoodShare cross-platform apps (Web, iOS, Android).

## Structure

```
supabase/
├── config.toml           # Supabase CLI configuration
├── migrations/           # Database migrations (40 files)
├── functions/            # Edge Functions (42 functions)
│   ├── _shared/          # Shared utilities
│   ├── PLATFORM_GUIDE.md # Platform categorization
│   └── */                # Individual functions
└── types/                # Generated TypeScript types
```

## Usage

This repository is intended to be used as a Git submodule in client applications:

```bash
# Add as submodule to your project
git submodule add git@github.com:your-org/foodshare-backend.git supabase

# Update to latest version
git submodule update --remote supabase
git add supabase
git commit -m "chore: update supabase submodule"
```

## Edge Functions

See `supabase/functions/PLATFORM_GUIDE.md` for platform categorization.

### Deploy Functions

```bash
# Deploy all functions
supabase functions deploy

# Deploy specific function
supabase functions deploy email
```

### Local Development

```bash
# Start local Supabase
supabase start

# Serve functions locally
supabase functions serve
```

## Migrations

```bash
# Apply migrations
supabase db push

# Create new migration
supabase migration new migration_name

# View migration status
supabase migration list
```

## Client Apps

- **Web**: [foodshare](https://github.com/your-org/foodshare) - Next.js 16 app
- **iOS**: [foodshare-ios](https://github.com/your-org/foodshare-ios) - Swift app
- **Android**: Coming soon

## Environment Variables

Required secrets (set in Supabase dashboard):

- `SUPABASE_URL` - Project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key
- `APPLE_TEAM_ID` - For iOS attestation
- `APP_BUNDLE_ID` - App bundle identifier
- Various API keys for email, push notifications, etc.
