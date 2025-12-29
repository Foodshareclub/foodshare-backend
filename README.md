# FoodShare Backend

Shared Supabase backend for FoodShare cross-platform apps (Web, iOS, Android).

## Structure

```
foodshare-backend/
├── functions/            # Deno Edge Functions (40+)
│   ├── _shared/          # Shared utilities
│   ├── PLATFORM_GUIDE.md # Platform categorization
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

See `functions/PLATFORM_GUIDE.md` for platform categorization.

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

- **Web**: [foodshare](https://github.com/Foodshareclub/foodshare) - Next.js app
- **iOS**: [foodshare-ios](https://github.com/Foodshareclub/foodshare-ios) - Swift app
