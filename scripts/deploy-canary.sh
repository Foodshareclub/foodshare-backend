#!/usr/bin/env bash
# Canary deployment - simplified without load balancer
# Uses feature flags to control rollout percentage

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
CANARY_PERCENT="${1:-10}"
cd "$DEPLOY_DIR"

log() { echo "[canary] $*"; }

# Update feature flag rollout percentage
log "Setting canary rollout to $CANARY_PERCENT%"

# Update feature-flags.ts with new percentage
sed -i.bak "s/rolloutPercent: [0-9]*/rolloutPercent: $CANARY_PERCENT/" \
  supabase/functions/_shared/feature-flags.ts

# Restart functions to pick up new config
log "Restarting edge functions"
docker compose restart supabase-edge-functions

# Monitor for 2 minutes
log "Monitoring for 2 minutes..."
sleep 120

# Check error rate from logs
ERROR_COUNT=$(docker logs supabase-edge-functions --since 2m 2>&1 | grep -c "ERROR" || echo "0")
REQUEST_COUNT=$(docker logs supabase-edge-functions --since 2m 2>&1 | grep -c "Request completed" || echo "1")
ERROR_RATE=$((ERROR_COUNT * 100 / REQUEST_COUNT))

log "Error rate: $ERROR_RATE% ($ERROR_COUNT errors / $REQUEST_COUNT requests)"

if [ "$ERROR_RATE" -gt 5 ]; then
  log "ERROR: High error rate detected, rolling back"
  # Restore backup
  mv supabase/functions/_shared/feature-flags.ts.bak supabase/functions/_shared/feature-flags.ts
  docker compose restart supabase-edge-functions
  exit 1
fi

# Clean up backup
rm -f supabase/functions/_shared/feature-flags.ts.bak

log "✅ Canary deployment successful at $CANARY_PERCENT%"
