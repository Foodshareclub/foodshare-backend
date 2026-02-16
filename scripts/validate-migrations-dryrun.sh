#!/usr/bin/env bash
# Migration dry-run validation
# Tests migrations in isolated container before applying to production

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[migration-dryrun] $*"; }
err() { echo "[migration-dryrun] ERROR: $*" >&2; }

# Create temporary test database
log "Creating test database container"
docker run -d --name migration-test-db \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=postgres \
  postgres:17 > /dev/null

cleanup() {
  log "Cleaning up test database"
  docker rm -f migration-test-db > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for database
log "Waiting for database..."
sleep 5

# Apply migrations to test database
log "Applying migrations to test database"
FAILED=0
for f in supabase/migrations/*.sql; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  
  log "Testing: $BASENAME"
  if ! docker exec -i migration-test-db psql -U postgres -d postgres < "$f" 2>&1 | grep -v "NOTICE"; then
    err "Migration failed: $BASENAME"
    FAILED=1
    break
  fi
done

if [ "$FAILED" -eq 0 ]; then
  log "✅ All migrations validated successfully"
  exit 0
else
  err "❌ Migration validation failed"
  exit 1
fi
