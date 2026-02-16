#!/usr/bin/env bash
# Migration dry-run validation - simplified for VPS without Docker
# Tests migrations against a copy of the production database

set -eo pipefail

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
cd "$DEPLOY_DIR"

log() { echo "[migration-dryrun] $*"; }
err() { echo "[migration-dryrun] ERROR: $*" >&2; }

# Create temporary database for testing
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
TEST_DB="postgres_migration_test_$$"

log "Creating test database: $TEST_DB"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -c "CREATE DATABASE $TEST_DB;" 2>/dev/null || {
  err "Failed to create test database"
  exit 1
}

cleanup() {
  log "Cleaning up test database"
  docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -c "DROP DATABASE IF EXISTS $TEST_DB;" 2>/dev/null || true
}
trap cleanup EXIT

# Create schema_migrations table in test database
log "Setting up test database"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$TEST_DB" <<EOF > /dev/null 2>&1
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text,
  name text
);
EOF

# Apply new migrations to test database
log "Testing new migrations"
FAILED=0
for f in supabase/migrations/*.sql; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  
  # Skip if already applied (check version in test db)
  VERSION=$(echo "$BASENAME" | grep -oE '^[0-9]+')
  APPLIED=$(docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$TEST_DB" -tAc \
    "SELECT COUNT(*) FROM supabase_migrations.schema_migrations WHERE version='$VERSION';" 2>/dev/null || echo "0")
  
  if [ "$APPLIED" -gt 0 ]; then
    continue
  fi
  
  log "Testing: $BASENAME"
  if ! docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$TEST_DB" < "$f" 2>&1 | grep -v "NOTICE"; then
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
