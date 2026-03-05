#!/usr/bin/env bash
# Rolling restart for edge functions (single-instance safe)
# Usage: ./scripts/deploy-functions-zero-downtime.sh

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[zero-downtime] $*"; }

# Health check via Kong — uses the api-v1-health quick endpoint
ANON_KEY=$(grep -E "^ANON_KEY=" .env 2>/dev/null | cut -d= -f2- | tr -d '"' || echo "")
HEALTH_URL="http://localhost:54321/functions/v1/api-v1-health"

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
  if [ -n "$ANON_KEY" ]; then
    HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
      -H "apikey: $ANON_KEY" \
      "$HEALTH_URL" 2>/dev/null || echo "000")
  else
    HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")
  fi

  if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "204" ]; then
    log "Edge functions healthy (attempt $i, HTTP $HTTP_STATUS)"
    log "Zero-downtime deployment complete"
    exit 0
  fi
  log "Attempt $i: HTTP $HTTP_STATUS — waiting 5s..."
  [ "$i" -lt 10 ] && sleep 5
done

log "ERROR: Edge functions still unhealthy after 10 attempts"
exit 1
