# 100x Pro Deployment Guide

## Features Implemented

### 1. Zero-Downtime Deployments ✅
**What:** Edge functions deploy without any downtime
**How:** Blue-green deployment with health checks
```bash
./scripts/deploy-functions-zero-downtime.sh
```
**Automatic:** Used automatically when functions change in CI/CD

### 2. Migration Dry-Run Validation ✅
**What:** Test migrations in isolated container before production
**How:** Spins up temp Postgres, validates all migrations
```bash
./scripts/validate-migrations-dryrun.sh
```
**Automatic:** Runs before every migration in CI/CD

### 3. Feature Flags ✅
**What:** Control feature rollout without redeployment
**How:** 
```typescript
import { isFeatureEnabled } from "./_shared/feature-flags.ts";

if (await isFeatureEnabled("new-chat-ui", userId)) {
  // New feature code
}
```
**Config:** Edit `supabase/functions/_shared/feature-flags.ts`

### 4. Canary Deployments ✅
**What:** Gradual rollout (10% → 50% → 100%)
**How:** Manual workflow with monitoring
```bash
# Via GitHub Actions UI:
Actions → Canary Deploy → Run workflow → Select percentage

# Or via CLI:
gh workflow run canary-deploy.yml -f percentage=10
```
**Monitoring:** Auto-rollback if error rate > 5%

### 5. Enhanced Observability ✅
**What:** Deployment metrics + Prometheus endpoint
**Endpoints:**
- `/_internal/health` - Health check
- `/_internal/deployments` - Recent deployments
- `/_internal/prometheus` - Prometheus metrics

## Deployment Flow

### Standard Deploy (Automatic on push to main)
```
1. CI checks (lint, test, security)
2. Change detection
3. Migration dry-run (if migrations changed)
4. Apply migrations
5. Zero-downtime function restart
6. Smoke tests
7. Auto-rollback on failure
```

### Canary Deploy (Manual)
```
1. Deploy to 10% → Monitor 2min → Check error rate
2. If healthy: Deploy to 50% → Monitor 2min
3. If healthy: Deploy to 100% (full rollout)
4. Auto-rollback if error rate > 5%
```

## Usage Examples

### Deploy with Feature Flag
```typescript
// Deploy code but keep feature disabled
const FLAGS = {
  "ai-recommendations": { enabled: false }
};

// Enable for 10% of users
const FLAGS = {
  "ai-recommendations": { enabled: true, rolloutPercent: 10 }
};

// Enable for specific users
const FLAGS = {
  "ai-recommendations": { 
    enabled: true, 
    allowedUsers: ["user-123", "user-456"] 
  }
};
```

### Manual Canary Rollout
```bash
# 1. Deploy to 10%
gh workflow run canary-deploy.yml -f percentage=10

# 2. Monitor metrics
curl https://api.foodshare.club/functions/v1/_internal/deployments

# 3. If healthy, increase to 50%
gh workflow run canary-deploy.yml -f percentage=50

# 4. Full rollout
gh workflow run canary-deploy.yml -f percentage=100
```

### Test Migrations Locally
```bash
# Validate all migrations without touching production
./scripts/validate-migrations-dryrun.sh
```

## Monitoring

### Deployment Metrics
```bash
# View recent deployments
curl https://api.foodshare.club/functions/v1/_internal/deployments

# Prometheus metrics
curl https://api.foodshare.club/functions/v1/_internal/prometheus
```

### Telegram Notifications
- Deploy started/succeeded/failed
- Canary status updates
- Rollback alerts

## Best Practices

1. **Use feature flags for risky changes**
   - Deploy code disabled
   - Enable for 10% of users
   - Monitor metrics
   - Gradually increase

2. **Use canary for major updates**
   - Breaking API changes
   - New algorithms
   - Performance optimizations

3. **Always validate migrations**
   - Automatic in CI/CD
   - Run manually before risky migrations

4. **Monitor after deployment**
   - Check error rates
   - Watch latency metrics
   - Review Telegram notifications

## Rollback

### Automatic
- Smoke tests fail → Auto-rollback
- Canary error rate > 5% → Auto-rollback

### Manual
```bash
# Via GitHub Actions
gh workflow run deploy.yml # Deploys previous commit

# Or SSH to VPS
cd /home/organic/dev/foodshare-backend
./scripts/deploy.sh rollback
```
