#!/usr/bin/env bash
# Blue-green deployment for edge functions
# Usage: ./scripts/deploy-functions-zero-downtime.sh

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[zero-downtime] $*"; }

# 1. Scale up to 2 instances
log "Scaling functions to 2 instances"
docker compose up -d --scale functions=2 --no-recreate

# 2. Wait for new instance to be healthy
log "Waiting for new instance..."
sleep 10

# 3. Reload functions in new instance
log "Reloading functions in new instance"
docker compose exec -T functions sh -c "pkill -HUP deno || true"

# 4. Health check new instance
log "Health checking new instance"
for i in {1..5}; do
  if curl -sf http://localhost:54321/functions/v1/_internal/health > /dev/null; then
    log "New instance healthy"
    break
  fi
  [ $i -eq 5 ] && { log "ERROR: New instance unhealthy"; exit 1; }
  sleep 2
done

# 5. Scale back to 1 (removes old instance)
log "Scaling back to 1 instance"
docker compose up -d --scale functions=1

log "Zero-downtime deployment complete"
