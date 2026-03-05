#!/usr/bin/env bash
# Rolling restart for edge functions (single-instance safe)
# Usage: ./scripts/deploy-functions-zero-downtime.sh

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[zero-downtime] $*"; }
HEALTH_URL="http://localhost:54321/functions/v1/_internal/health"

# 1. Pull latest code (already done by deploy script, but be safe)
log "Pulling latest code"
git pull --ff-only || true

# 2. Restart edge functions container in-place
log "Restarting edge functions container"
docker compose up -d --force-recreate functions

# 3. Wait for container to start
log "Waiting for container to initialise (15s)..."
sleep 15

# 4. Health check with retries
log "Health checking edge functions"
for i in {1..10}; do
  HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" = "200" ]; then
    log "Edge functions healthy (attempt $i)"
    break
  fi
  log "Attempt $i: HTTP $HTTP_STATUS — waiting..."
  [ $i -eq 10 ] && { log "ERROR: Edge functions still unhealthy after 10 attempts"; exit 1; }
  sleep 5
done

log "Zero-downtime deployment complete"
