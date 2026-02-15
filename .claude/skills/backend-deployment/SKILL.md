---
name: backend-deployment
description: Deploy Foodshare backend to self-hosted VPS via CI/CD only. Use for monitoring deployments and production verification. Manual SSH deployment is NOT allowed.
disable-model-invocation: true
---

<objective>
Deploy backend changes safely to the self-hosted Supabase instance via automated CI/CD pipeline with minimal downtime and proper verification.
</objective>

<essential_principles>
## Infrastructure

- **VPS**: 152.53.136.84 (ARM64, 8GB RAM)
- **14 Docker services** running via docker-compose
- **Cloudflare tunnel** routes to Kong on port 54321
- **Studio**: https://studio.foodshare.club (basic-auth protected)
- **API**: https://api.foodshare.club

## Deployment Workflow

**⚠️ CRITICAL: All deployments MUST go through CI/CD pipeline. Manual SSH deployment is NOT allowed.**

### 1. Trigger Deployment

```bash
# Automatic: Push to main branch
git push origin main

# Manual: Trigger via GitHub Actions
gh workflow run deploy.yml

# With options:
gh workflow run deploy.yml -f force-restart=true
gh workflow run deploy.yml -f skip-backup=true
gh workflow run deploy.yml -f dry-run=true
```

### 2. Monitor Deployment

```bash
# Watch workflow status
gh run watch

# View logs
gh run view --log

# Check Telegram notifications (deploy channel)
```

### 3. Verify Deployment

```bash
# Test health endpoint
curl -s https://api.foodshare.club/functions/v1/api-v1-health | jq .

# Check specific function
curl -s https://api.foodshare.club/functions/v1/{function-name}
```

### 4. SSH Access (Debugging Only)

SSH access is for debugging and verification ONLY, not deployment:

```bash
autossh -M 0 \
  -o ServerAliveInterval=6000 \
  -o ServerAliveCountMax=6000 \
  -o ConnectTimeout=10 \
  -o ConnectionAttempts=6000 \
  -i ~/.ssh/id_rsa_gitlab \
  organic@vps.foodshare.club
```

**Allowed SSH operations:**
- View logs: `docker compose logs -f functions --tail=50`
- Check status: `docker compose ps`
- Debug issues: `docker compose logs <service>`

**NOT allowed:**
- `git pull` (CI/CD handles this)
- `docker compose restart` (CI/CD handles this)
- Manual deployments

## CI/CD Pipeline Details

The deployment pipeline (`.github/workflows/deploy.yml`) handles:

1. **CI Checks**: Lint, test, security scan, migration validation
2. **Deploy Gate**: Blocks deployment if any check fails
3. **Change Detection**: Determines what needs restarting
4. **Backup**: Pre-deploy backup (unless `skip-backup=true`)
5. **Deploy**: SSH to VPS, pull code, run migrations, restart services
6. **Smoke Tests**: Verify deployment health
7. **Notifications**: Telegram alerts for success/failure

**Workflow inputs:**
- `force-restart`: Full restart regardless of changes
- `skip-backup`: Skip pre-deploy backup (faster, less safe)
- `dry-run`: Validate only, don't deploy

## Adding New Secrets

Secrets must be added via SSH, then commit code changes to trigger deployment:

```bash
# 1. SSH to VPS
ssh organic@vps.foodshare.club

# 2. Edit secrets file
nano /home/organic/dev/foodshare-backend/.env.functions

# 3. Add new secret
NEW_SECRET=value

# 4. Exit SSH, commit code that uses the secret, push to trigger deploy
```

Secrets go in `.env.functions`, NOT vault. Vault encryption keys are per-DB-instance.

## Database Migrations (Production)

Migrations are applied automatically by CI/CD when changes are detected in `supabase/migrations/`.

**Manual migration (emergency only):**
```bash
ssh organic@vps.foodshare.club
docker exec supabase-db psql -U postgres -f /docker-entrypoint-initdb.d/migration.sql
```

## Rollback

```bash
# Revert commit and push to trigger rollback deployment
git revert <commit-sha>
git push origin main

# Emergency manual rollback (if CI/CD is broken)
ssh organic@vps.foodshare.club
cd /home/organic/dev/foodshare-backend
git checkout <previous-commit>
./scripts/deploy.sh restart functions
```

## Common Issues

| Problem | Solution |
|---------|----------|
| Deployment blocked | Check CI logs: `gh run view --log`. Fix failing checks |
| Edge function not loading | Check deploy logs for JSR imports, missing index.ts |
| 502 Bad Gateway | SSH to check Kong: `docker compose ps` |
| Database connection refused | Trigger restart: `gh workflow run deploy.yml -f force-restart=true` |
| Out of disk space | SSH and run: `docker system prune -f` |
| Supavisor connection issues | Username format: `postgres.foodshare` (not just `postgres`) |
| CI/CD pipeline broken | Emergency manual deploy via SSH (document incident) |
</essential_principles>

<success_criteria>
Deployment is successful when:
- [ ] CI/CD pipeline completes without errors
- [ ] Telegram notification shows success
- [ ] Health endpoint returns 200: `curl https://api.foodshare.club/functions/v1/api-v1-health`
- [ ] No errors in function logs (check via SSH if needed)
- [ ] Client apps can connect
- [ ] New features accessible via API
</success_criteria>
