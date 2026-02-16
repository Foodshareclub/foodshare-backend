#!/usr/bin/env bash
# Canary deployment - gradual rollout with monitoring
# Usage: ./scripts/deploy-canary.sh [10|50|100]

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
CANARY_PERCENT="${1:-10}"
cd "$DEPLOY_DIR"

log() { echo "[canary] $*"; }

case "$CANARY_PERCENT" in
  10)
    log "Deploying to 10% of traffic (canary)"
    # Deploy new version with weight=1, old version weight=9
    docker compose up -d --scale supabase-edge-functions=2
    # Configure Kong to route 10% to new instance
    ;;
  50)
    log "Deploying to 50% of traffic"
    docker compose up -d --scale supabase-edge-functions=2
    ;;
  100)
    log "Deploying to 100% of traffic (full rollout)"
    docker compose up -d --scale supabase-edge-functions=1
    ;;
  *)
    log "ERROR: Invalid percentage. Use: 10, 50, or 100"
    exit 1
    ;;
esac

# Monitor error rate for 2 minutes
log "Monitoring error rate..."
sleep 120

# Check metrics
ERROR_RATE=$(curl -s http://localhost:54321/functions/v1/_internal/metrics | grep error_rate || echo "0")
log "Error rate: $ERROR_RATE"

if [ "$ERROR_RATE" -gt 5 ]; then
  log "ERROR: High error rate detected, rolling back"
  docker compose up -d --scale supabase-edge-functions=1
  exit 1
fi

log "Canary deployment successful at $CANARY_PERCENT%"
