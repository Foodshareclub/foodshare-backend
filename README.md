# FoodShare Backend

[![CI/CD](https://github.com/Foodshareclub/foodshare-backend/actions/workflows/backend.yml/badge.svg)](https://github.com/Foodshareclub/foodshare-backend/actions/workflows/backend.yml)

Self-hosted Supabase backend (Docker Compose + Deno Edge Functions + PostgreSQL) serving the unified cross-platform FoodShare app (Web, iOS, Android).

## Structure

```
foodshare-backend/
├── .github/
│   ├── actions/              # Reusable composite actions
│   └── workflows/
│       └── backend.yml       # CI/CD pipeline
├── docker-compose.yml        # 14 Docker services
├── Dockerfile.caddy          # Custom Caddy with Cloudflare DNS
├── scripts/
│   ├── deploy.sh             # Main deployment script
│   ├── deploy-functions-zero-downtime.sh
│   ├── backup-to-r2.ts       # R2 backup utility
│   └── new-migration.sh      # Migration scaffolding
├── supabase/
│   ├── config.toml           # Function config (JWT exceptions)
│   ├── seed.sql              # Email template seed data
│   ├── migrations/           # PostgreSQL migrations (16)
│   └── functions/            # Deno Edge Functions (28)
│       ├── _shared/          # Shared utilities (singletons)
│       ├── __tests__/        # Test suite
│       ├── main/             # Edge-runtime router
│       ├── api-v1-* (25)     # REST API endpoints
│       ├── telegram-bot-foodshare/
│       └── whatsapp-bot-foodshare/
└── volumes/                  # Docker volume configs
    ├── api/ (kong.yml)
    ├── db/ (init scripts)
    ├── logs/ (vector.yml)
    └── pooler/ (pooler.exs)
```

## Self-Hosted Supabase

- **Studio**: https://studio.foodshare.club
- **API**: https://api.foodshare.club
- **VPS**: backend.foodshare.club (ARM64, 8GB RAM)

## Client Apps

This repository is the source of truth for database schema and Edge Functions. Client apps link via symlinks:

- **Web**: [`foodshare-web`](https://github.com/Foodshareclub/foodshare-web) — Next.js 16 (symlinks `supabase/` → `../foodshare-backend/supabase/`)
- **Mobile**: [`foodshare-app`](https://github.com/Foodshareclub/foodshare-app) — Skip Fuse cross-platform (iOS + Android)

## Deployment

All deployments go through GitHub Actions CI/CD. Never SSH to deploy manually.

```bash
# Check latest CI/CD run status
gh run list --limit 3
gh run view <run-id>
gh run view <run-id> --log-failed
```

## Secret Management

Operational secrets are stored in **Supabase Vault** with fallback to `.env.functions`.

```typescript
import { getSecret } from "../_shared/vault.ts";
const apiKey = await getSecret("MY_API_KEY");
```

## VPS Access (debugging only)

```bash
autossh -M 0 -o ServerAliveInterval=6000 -o ServerAliveCountMax=6000 \
  -o ConnectTimeout=10 -o ConnectionAttempts=6000 \
  -i ~/.ssh/foodshare_id_ed25519 organic@backend.foodshare.club
```
