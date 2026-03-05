#!/usr/bin/env bash
# Rolling restart for edge functions (single-instance safe)
# Usage: ./scripts/deploy-functions-zero-downtime.sh

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[zero-downtime] $*"; }

# Read ANON_KEY: prefer env var (set by GitHub Actions), fall back to .env file
if [ -z "$ANON_KEY" ]; then
  if [ -f "$DEPLOY_DIR/.env" ]; then
    ANON_KEY=$(grep -E "^ANON_KEY=" "$DEPLOY_DIR/.env" | cut -d= -f2- | tr -d '"' || echo "")
  fi
fi

if [ -z "$ANON_KEY" ]; then
  log "ERROR: ANON_KEY not found. Set ANON_KEY env var or ensure .env file exists."
  exit 1
fi

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
  HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "apikey: $ANON_KEY" \
    -H "Host: api.foodshare.club" \
    "$HEALTH_URL" 2>/dev/null || echo "000")

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
