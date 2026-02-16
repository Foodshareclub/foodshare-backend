#!/usr/bin/env bash
# Usage: ./scripts/deploy.sh <stage> [options]
#
# Stages: backup, pull, detect, migrate, restart, smoke, rollback, status
# State:  /tmp/deploy-state.json (persists between stages)
#
# Examples:
#   ./scripts/deploy.sh status        # Check service health
#   ./scripts/deploy.sh smoke         # Run smoke tests
#   ./scripts/deploy.sh backup        # Pre-deploy backup
#   ./scripts/deploy.sh restart full  # Full stack restart

set -eo pipefail

# ── Deploy lock (prevent concurrent deploys) ─────────────────────────────
exec 9>/tmp/deploy.lock
if ! flock -n 9; then
  echo "[deploy] ERROR: Another deploy is already running" >&2
  exit 1
fi
cleanup() { exec 9>&-; rm -f /tmp/deploy.lock; }
trap cleanup EXIT

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
STATE_FILE="/tmp/deploy-state.json"
BACKUP_DIR="/home/organic/backups"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"

# ── Dependency check ────────────────────────────────────────────────────

for cmd in jq curl docker git; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[deploy] ERROR: Required: $cmd" >&2; exit 1; }
done

# ── Helpers ─────────────────────────────────────────────────────────────

log() { echo "[deploy] $*"; }
err() { echo "[deploy] ERROR: $*" >&2; }

state_read() {
  if [ -f "$STATE_FILE" ]; then
    jq -r ".$1 // \"$2\"" "$STATE_FILE" 2>/dev/null || echo "$2"
  else
    echo "$2"
  fi
}

state_write() {
  if [ -f "$STATE_FILE" ]; then
    TEMP=$(mktemp)
    jq ".$1 = \"$2\"" "$STATE_FILE" > "$TEMP" && mv "$TEMP" "$STATE_FILE" || { rm -f "$TEMP"; return 1; }
  else
    echo "{\"$1\": \"$2\"}" > "$STATE_FILE"
  fi
}

state_init() {
  echo '{}' > "$STATE_FILE"
  state_write "started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  state_write "stage" "$1"
}

require_dir() {
  if [ ! -d "$DEPLOY_DIR" ]; then
    err "Deploy directory not found: $DEPLOY_DIR"
    exit 1
  fi
  cd "$DEPLOY_DIR"
}

get_env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env | head -1
}

get_anon_key()    { get_env_value "ANON_KEY"; }
get_service_key() { get_env_value "SERVICE_ROLE_KEY"; }

# ── Stage: backup ───────────────────────────────────────────────────────

do_backup() {
  require_dir
  state_init "backup"

  DAILY=false
  for arg in "$@"; do
    [ "$arg" = "--daily" ] && DAILY=true
  done

  # Disk space check (<1GB = abort)
  AVAIL_KB=$(df /home | tail -1 | awk '{print $4}')
  if [ "$AVAIL_KB" -lt 1048576 ]; then
    err "Low disk space: $(( AVAIL_KB / 1024 ))MB available"
    exit 1
  fi

  TIMESTAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
  DATE=$(date -u +%Y-%m-%d)

  if [ "$DAILY" = true ]; then
    log "Daily backup"
    mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/db"
    DB_TARGET="$BACKUP_DIR/db/foodshare-$DATE.sql.gz"
  else
    log "Pre-deploy backup"
    mkdir -p backups
    DB_TARGET="backups/db.sql.gz"
  fi

  # Database dump
  log "Database dump..."
  timeout 120 docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --clean --if-exists \
    -N _analytics -N _realtime -N supabase_functions \
    | gzip > "$DB_TARGET"
  DB_SIZE=$(du -h "$DB_TARGET" | cut -f1)
  log "DB dump: $DB_SIZE"

  # Verify dump is non-empty
  if [ ! -s "$DB_TARGET" ]; then
    err "Database dump is empty!"
    exit 1
  fi

  # Secrets snapshot
  log "Secrets snapshot..."
  if [ "$DAILY" = true ]; then
    SECRETS_FILE="$BACKUP_DIR/daily/secrets-$DATE.tar.gz"
    tar czf "$SECRETS_FILE" \
      .env \
      .env.functions \
      docker-compose.override.yml \
      2>/dev/null || tar czf "$SECRETS_FILE" .env .env.functions 2>/dev/null || true
    log "Secrets: $(du -h "$SECRETS_FILE" | cut -f1)"
  else
    cp .env backups/.env 2>/dev/null || true
    cp .env.functions backups/.env.functions 2>/dev/null || true
    cp docker-compose.override.yml backups/docker-compose.override.yml 2>/dev/null || true

    # Save copy for fast rollback (restricted permissions — contains PII)
    cp "$DB_TARGET" /tmp/pre-deploy-db.sql.gz
    chmod 600 /tmp/pre-deploy-db.sql.gz
  fi

  # Git snapshot
  BRANCH_NAME="backup/pre-deploy"
  [ "$DAILY" = true ] && BRANCH_NAME="backup/vps"

  git add -A
  [ "$DAILY" != true ] && git add -f backups/
  TREE=$(git write-tree)
  git reset HEAD --quiet
  PARENT=$(git rev-parse --verify "refs/heads/$BRANCH_NAME" 2>/dev/null || echo "")
  SKIP=false
  if [ -n "$PARENT" ]; then
    [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ] && SKIP=true
  fi
  if [ "$SKIP" = true ]; then
    log "No changes since last backup — skipped git snapshot"
  else
    if [ "$DAILY" = true ]; then
      MSG="backup: $DATE ($TIMESTAMP)
main: $(git rev-parse --short HEAD)
dirty: $(git status --porcelain | wc -l | tr -d ' ') files"
    else
      MSG="pre-deploy: $TIMESTAMP ($(git rev-parse --short HEAD))"
    fi
    if [ -n "$PARENT" ]; then
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT")
    else
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE")
    fi
    git update-ref "refs/heads/$BRANCH_NAME" "$COMMIT"
    if git push origin "$BRANCH_NAME" --force-with-lease --quiet 2>/dev/null; then
      log "Pushed $BRANCH_NAME: $(git rev-parse --short "$COMMIT")"
    else
      log "WARNING: Could not push backup branch (read-only key?) — local ref updated"
    fi
  fi

  # Cleanup
  if [ "$DAILY" = true ]; then
    # Rotate (keep 14 days)
    find "$BACKUP_DIR/db" -name "*.sql.gz" -mtime +14 -delete 2>/dev/null || true
    find "$BACKUP_DIR/daily" -name "*.tar.gz" -mtime +14 -delete 2>/dev/null || true
    log "Rotated backups older than 14 days"
  else
    rm -rf backups/
  fi

  state_write "backup" "done"
  state_write "db_size" "$DB_SIZE"
  log "Backup complete"
}

# ── Stage: pull ─────────────────────────────────────────────────────────

do_pull() {
  require_dir
  state_write "stage" "pull"

  PREV_HEAD=$(git rev-parse HEAD)
  state_write "prev_head" "$PREV_HEAD"

  log "Pulling latest code..."
  git pull --ff-only

  NEW_HEAD=$(git rev-parse HEAD)
  state_write "new_head" "$NEW_HEAD"

  if [ "$PREV_HEAD" = "$NEW_HEAD" ]; then
    log "Already up to date"
    state_write "changed_files" ""
  else
    CHANGED=$(git diff --name-only "$PREV_HEAD" "$NEW_HEAD")
    state_write "changed_files" "$(echo "$CHANGED" | tr '\n' ',')"
    log "Changed files ($PREV_HEAD..$NEW_HEAD):"
    echo "$CHANGED"
  fi

  log "Pull complete"
}

# ── Stage: migrate ──────────────────────────────────────────────────────

do_migrate() {
  require_dir
  state_write "stage" "migrate"

  LATEST_APPLIED=$(timeout 30 docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -c \
    "SELECT COALESCE(MAX(version), '0') FROM supabase_migrations.schema_migrations;" 2>/dev/null | tr -d ' ' || echo "0")
  log "Latest applied migration: $LATEST_APPLIED"

  APPLIED=0
  FAILED=0

  for f in supabase/migrations/*.sql; do
    [ -f "$f" ] || continue
    VERSION=$(basename "$f" | grep -oE '^[0-9]+')

    if [ "$VERSION" -gt "$LATEST_APPLIED" ] 2>/dev/null; then
      log "Applying: $(basename "$f")"

      if grep -qi "CONCURRENTLY" "$f"; then
        if ! timeout 60 docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$f"; then
          err "Migration FAILED: $(basename "$f")"
          FAILED=1
          break
        fi
        # CONCURRENT migrations can't run in a transaction — track version separately
        if ! timeout 30 docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
          "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('$VERSION');"; then
          err "Migration applied but version tracking FAILED: $VERSION"
          FAILED=1
          break
        fi
      else
        if ! (echo "BEGIN;" && cat "$f" && echo "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('$VERSION');" && echo "COMMIT;") | timeout 60 docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1; then
          err "Migration FAILED (rolled back): $(basename "$f")"
          FAILED=1
          break
        fi
      fi
      APPLIED=$((APPLIED + 1))
    fi
  done

  state_write "migrations_applied" "$APPLIED"

  if [ "$FAILED" -ne 0 ]; then
    state_write "migrations_failed" "true"
    err "Migration failed — triggering rollback"
    do_rollback
    exit 1
  fi

  log "Applied $APPLIED migration(s)"
}

# ── Stage: restart ──────────────────────────────────────────────────────

do_restart() {
  require_dir
  state_write "stage" "restart"

  MODE="${1:-detect}"

  case "$MODE" in
    full)
      log "Full stack restart"
      docker compose up -d
      ;;
    functions)
      log "Restarting edge functions"
      docker compose restart functions
      ;;
    rest)
      log "Restarting PostgREST (schema cache refresh)"
      docker compose restart rest
      ;;
    detect)
      CHANGED=$(state_read "changed_files" "")
      if [ -z "$CHANGED" ]; then
        log "No changes — skipping restart"
        return 0
      fi
      if echo "$CHANGED" | grep -qE '(docker-compose\.yml|\.env\.example|volumes/)'; then
        log "Infrastructure changed — full restart"
        docker compose up -d
      elif echo "$CHANGED" | grep -qE 'supabase/functions/'; then
        log "Functions changed — restarting functions"
        docker compose restart functions
      elif echo "$CHANGED" | grep -qE 'supabase/migrations/'; then
        log "Migrations only — restarting PostgREST"
        docker compose restart rest
      else
        log "Config/docs only — no restart needed"
      fi
      ;;
    *)
      err "Unknown restart mode: $MODE (use: full, functions, rest, detect)"
      exit 1
      ;;
  esac

  log "Restart complete"
}

# ── Smoke test helper ──────────────────────────────────────────────────

check_endpoint() {
  local name="$1" url="$2" headers="$3" retries="${4:-1}" delay="${5:-0}"
  local code
  for i in $(seq 1 "$retries"); do
    [ "$delay" -gt 0 ] && sleep "$delay"
    code=$(eval "curl -s -o /dev/null -w '%{http_code}' '$url' $headers" 2>/dev/null || echo "000")
    log "  $name attempt $i: HTTP $code"
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      log "PASS: $name (HTTP $code)"
      return 0
    fi
  done
  err "FAIL: $name (HTTP $code)"
  return 1
}

# ── Stage: smoke ────────────────────────────────────────────────────────

do_smoke() {
  require_dir
  state_write "stage" "smoke"

  ANON_KEY=$(get_anon_key)
  SERVICE_KEY=$(get_service_key)
  
  if [ -z "$ANON_KEY" ] || [ -z "$SERVICE_KEY" ]; then
    log "WARNING: Missing API keys, skipping smoke tests"
    state_write "smoke" "skipped"
    return 0
  fi
  
  SMOKE_PASS=true

  check_endpoint "Kong REST API" \
    "http://localhost:54321/rest/v1/" \
    "-H 'apikey: $ANON_KEY'" 5 5 || SMOKE_PASS=false

  check_endpoint "Auth service" \
    "http://localhost:54321/auth/v1/health" \
    "-H 'apikey: $ANON_KEY'" 1 3 || SMOKE_PASS=false

  check_endpoint "Edge functions" \
    "http://localhost:54321/functions/v1/api-v1-health" \
    "-H 'apikey: $ANON_KEY'" 3 3 || SMOKE_PASS=false

  check_endpoint "DB connectivity" \
    "http://localhost:54321/rest/v1/" \
    "-H 'apikey: $SERVICE_KEY' -H 'Authorization: Bearer $SERVICE_KEY'" 1 0 || SMOKE_PASS=false

  state_write "smoke" "$SMOKE_PASS"

  if [ "$SMOKE_PASS" != "true" ]; then
    err "Smoke tests FAILED — triggering rollback"
    do_rollback
    exit 1
  fi

  log "All smoke tests passed"

  rm -f /tmp/pre-deploy-db.sql.gz
  log "Cleaned up pre-deploy backup"
}

# ── Stage: rollback ─────────────────────────────────────────────────────

do_rollback() {
  require_dir
  state_write "stage" "rollback"

  log "=== ROLLING BACK ==="
  set +e

  PREV_HEAD=$(state_read "prev_head" "")
  MIGRATIONS_APPLIED=$(state_read "migrations_applied" "0")

  if [ -n "$PREV_HEAD" ]; then
    git reset --hard "$PREV_HEAD"
    log "Rolled back code to $PREV_HEAD"
  fi

  if [ "$MIGRATIONS_APPLIED" -gt 0 ] 2>/dev/null && [ -s /tmp/pre-deploy-db.sql.gz ]; then
    log "Restoring pre-deploy database..."
    gunzip -c /tmp/pre-deploy-db.sql.gz \
      | docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=0
    if [ $? -eq 0 ]; then
      log "Database restored"
    else
      err "Database restore had errors — manual check needed"
    fi
  fi

  docker compose up -d
  log "Services restarted with rolled-back code"

  # Verify rollback health (inline, no recursive rollback)
  ANON_KEY=$(get_anon_key)
  check_endpoint "Rollback: Kong" \
    "http://localhost:54321/rest/v1/" \
    "-H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Kong"
  check_endpoint "Rollback: Auth" \
    "http://localhost:54321/auth/v1/health" \
    "-H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Auth"
  check_endpoint "Rollback: Functions" \
    "http://localhost:54321/functions/v1/api-v1-health" \
    "-H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Functions"

  state_write "rollback" "done"
  log "=== ROLLBACK COMPLETE ==="
  set -e
}

# ── Stage: status ───────────────────────────────────────────────────────

do_status() {
  require_dir

  log "Service status:"
  docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || docker compose ps

  log ""
  log "Disk usage:"
  df -h / | tail -1

  log ""
  log "Memory:"
  free -h 2>/dev/null || vm_stat 2>/dev/null || true

  log ""
  log "Git state:"
  echo "  Branch: $(git branch --show-current)"
  echo "  HEAD:   $(git rev-parse --short HEAD)"
  echo "  Dirty:  $(git status --porcelain | wc -l | tr -d ' ') files"

  if [ -f "$STATE_FILE" ]; then
    log ""
    log "Last deploy state:"
    cat "$STATE_FILE"
  fi
}

# ── Main ────────────────────────────────────────────────────────────────

STAGE="${1:-}"
shift 2>/dev/null || true

case "$STAGE" in
  backup)   do_backup "$@" ;;
  pull)     do_pull "$@" ;;
  detect)   require_dir; state_init "detect" ;;
  migrate)  do_migrate "$@" ;;
  restart)  do_restart "$@" ;;
  smoke)    do_smoke "$@" ;;
  rollback) do_rollback "$@" ;;
  status)   do_status "$@" ;;
  *)
    echo "Usage: $0 <stage> [options]"
    echo ""
    echo "Stages:"
    echo "  backup    Pre-deploy backup (DB + secrets + git state)"
    echo "  pull      Pull latest code (git pull --ff-only)"
    echo "  migrate   Apply pending database migrations"
    echo "  restart   Restart services (full|functions|rest|detect)"
    echo "  smoke     Run smoke tests"
    echo "  rollback  Rollback to previous state"
    echo "  status    Show service status and deploy state"
    exit 1
    ;;
esac
