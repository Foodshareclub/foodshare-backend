---
name: backend-deployment
description: Deploy Foodshare backend to self-hosted VPS. Use for SSH deployment, Docker Compose restarts, and production verification. Covers the complete deploy workflow.
disable-model-invocation: true
---

<objective>
Deploy backend changes safely to the self-hosted Supabase instance with minimal downtime and proper verification.
</objective>

<essential_principles>
## Infrastructure

- **VPS**: 152.53.136.84 (ARM64, 8GB RAM)
- **14 Docker services** running via docker-compose
- **Cloudflare tunnel** routes to Kong on port 54321
- **Studio**: https://studio.foodshare.club (basic-auth protected)
- **API**: https://api.foodshare.club

## Deployment Workflow

### 1. SSH into VPS

```bash
autossh -M 0 \
  -o ServerAliveInterval=6000 \
  -o ServerAliveCountMax=6000 \
  -o ConnectTimeout=10 \
  -o ConnectionAttempts=6000 \
  -i ~/.ssh/id_rsa_gitlab \
  organic@vps.foodshare.club
```

### 2. Update code

```bash
cd /home/organic/dev/foodshare-backend
git pull
```

### 3. Restart services

```bash
# Full restart (if docker-compose.yml or configs changed)
docker compose up -d

# Edge functions only (after function code changes)
docker compose restart functions

# Specific service
docker compose restart <service-name>
```

### 4. Verify deployment

```bash
# Check all services healthy
docker compose ps

# Check edge function logs
docker compose logs -f functions --tail=50

# Test health endpoint
curl -s https://api.foodshare.club/functions/v1/api-v1-health | jq .

# Check specific function
docker compose logs functions 2>&1 | grep "api-v1-{name}"
```

## Adding New Secrets

```bash
# Edit on VPS
nano /home/organic/dev/foodshare-backend/.env.functions

# Add new secret
NEW_SECRET=value

# Restart functions to pick up changes
docker compose restart functions
```

Secrets go in `.env.functions`, NOT vault. Vault encryption keys are per-DB-instance.

## Database Migrations (Production)

```bash
# Apply migration directly
docker exec supabase-db psql -U postgres -f /docker-entrypoint-initdb.d/migration.sql

# Or enter psql shell
docker exec -it supabase-db psql -U postgres
```

## Rollback

```bash
# Revert to previous code
cd /home/organic/dev/foodshare-backend
git log --oneline -5  # Find commit to revert to
git checkout <commit>
docker compose restart functions

# Database rollback (manual)
docker exec -it supabase-db psql -U postgres
# Run rollback SQL
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Edge function not loading | `docker compose logs functions`. Check for JSR imports, missing index.ts |
| 502 Bad Gateway | `docker compose ps` - check if Kong is running |
| Database connection refused | `docker compose restart db supavisor` |
| Out of disk space | `docker system prune -f` |
| Supavisor connection issues | Username format: `postgres.foodshare` (not just `postgres`) |
</essential_principles>

<success_criteria>
Deployment is successful when:
- [ ] `docker compose ps` shows all services healthy
- [ ] Health endpoint returns 200
- [ ] No errors in function logs
- [ ] Client apps can connect
- [ ] New features accessible via API
</success_criteria>
