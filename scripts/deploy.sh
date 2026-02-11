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

DEPLOY_DIR="/home/organic/dev/foodshare-backend"
STATE_FILE="/tmp/deploy-state.json"
BACKUP_DIR="/home/organic/backups"

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
    jq ".$1 = \"$2\"" "$STATE_FILE" > "$TEMP" && mv "$TEMP" "$STATE_FILE"
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

get_anon_key() {
  grep '^ANON_KEY=' .env | cut -d= -f2
}

get_service_key() {
  grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2
}

# ── Stage: backup ───────────────────────────────────────────────────────

do_backup() {
  require_dir
  state_init "backup"

  # Disk space check (<1GB = abort)
  AVAIL_KB=$(df /home | tail -1 | awk '{print $4}')
  if [ "$AVAIL_KB" -lt 1048576 ]; then
    err "Low disk space: $(( AVAIL_KB / 1024 ))MB available"
    exit 1
  fi

  log "Pre-deploy backup"

  TIMESTAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
  mkdir -p backups

  # Database dump
  log "Database dump..."
  timeout 120 docker exec supabase-db pg_dump -U supabase_admin -d postgres \
    --no-owner --no-privileges --clean --if-exists \
    -N _analytics -N _realtime -N supabase_functions \
    | gzip > backups/db.sql.gz
  DB_SIZE=$(du -h backups/db.sql.gz | cut -f1)
  log "DB dump: $DB_SIZE"

  # Verify dump is non-empty
  if [ ! -s backups/db.sql.gz ]; then
    err "Database dump is empty!"
    exit 1
  fi

  # Save copy for fast rollback
  cp backups/db.sql.gz /tmp/pre-deploy-db.sql.gz

  # Secrets snapshot
  log "Secrets snapshot..."
  cp .env backups/.env 2>/dev/null || true
  cp .env.functions backups/.env.functions 2>/dev/null || true
  cp docker-compose.override.yml backups/docker-compose.override.yml 2>/dev/null || true

  # Git snapshot to backup/pre-deploy branch
  git add -A
  git add -f backups/
  TREE=$(git write-tree)
  git reset HEAD --quiet
  PARENT=$(git rev-parse --verify refs/heads/backup/pre-deploy 2>/dev/null || echo "")
  SKIP=false
  if [ -n "$PARENT" ]; then
    [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ] && SKIP=true
  fi
  if [ "$SKIP" = true ]; then
    log "No changes since last backup — skipped git snapshot"
  else
    MSG="pre-deploy: $TIMESTAMP ($(git rev-parse --short HEAD))"
    if [ -n "$PARENT" ]; then
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT")
    else
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE")
    fi
    git update-ref refs/heads/backup/pre-deploy "$COMMIT"
    git push origin backup/pre-deploy --force --quiet
    log "Pushed backup/pre-deploy: $(git rev-parse --short "$COMMIT")"
  fi

  rm -rf backups/

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

  LATEST_APPLIED=$(timeout 30 docker exec supabase-db psql -U supabase_admin -d postgres -t -c \
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
        if ! timeout 60 docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$f"; then
          err "Migration FAILED: $(basename "$f")"
          FAILED=1
          break
        fi
      else
        if ! (echo "BEGIN;" && cat "$f" && echo "COMMIT;") | timeout 60 docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1; then
          err "Migration FAILED (rolled back): $(basename "$f")"
          FAILED=1
          break
        fi
      fi

      timeout 30 docker exec supabase-db psql -U supabase_admin -d postgres -c \
        "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('$VERSION');"
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

# ── Stage: smoke ────────────────────────────────────────────────────────

do_smoke() {
  require_dir
  state_write "stage" "smoke"

  ANON_KEY=$(get_anon_key)
  SERVICE_KEY=$(get_service_key)
  SMOKE_PASS=true

  # 1. Kong REST API (retry loop)
  log "Smoke: Kong REST API"
  HEALTHY=false
  for i in 1 2 3 4 5; do
    sleep 5
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:54321/rest/v1/ -H "apikey: $ANON_KEY" || echo "000")
    log "  attempt $i: HTTP $HTTP_CODE"
    if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 500 ]; then
      HEALTHY=true
      break
    fi
  done
  if [ "$HEALTHY" != "true" ]; then
    err "FAIL: Kong not responding"
    SMOKE_PASS=false
  else
    log "PASS: Kong REST API (HTTP $HTTP_CODE)"
  fi

  # 2. Auth service
  log "Smoke: Auth service"
  AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:54321/auth/v1/health -H "apikey: $ANON_KEY" || echo "000")
  if [ "$AUTH_CODE" -ge 200 ] && [ "$AUTH_CODE" -lt 400 ]; then
    log "PASS: Auth service (HTTP $AUTH_CODE)"
  else
    err "FAIL: Auth service (HTTP $AUTH_CODE)"
    SMOKE_PASS=false
  fi

  # 3. Edge functions
  log "Smoke: Edge functions"
  sleep 3
  FN_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    http://localhost:54321/functions/v1/api-v1-health \
    -H "apikey: $ANON_KEY" || echo "000")
  if [ "$FN_CODE" -ge 200 ] && [ "$FN_CODE" -lt 400 ]; then
    log "PASS: Edge functions (HTTP $FN_CODE)"
  else
    err "FAIL: Edge functions (HTTP $FN_CODE)"
    SMOKE_PASS=false
  fi

  # 4. DB connectivity via PostgREST
  log "Smoke: DB connectivity"
  DB_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:54321/rest/v1/" \
    -H "apikey: $SERVICE_KEY" \
    -H "Authorization: Bearer $SERVICE_KEY" || echo "000")
  if [ "$DB_CODE" -ge 200 ] && [ "$DB_CODE" -lt 400 ]; then
    log "PASS: DB connectivity (HTTP $DB_CODE)"
  else
    err "FAIL: DB connectivity (HTTP $DB_CODE)"
    SMOKE_PASS=false
  fi

  state_write "smoke" "$SMOKE_PASS"

  if [ "$SMOKE_PASS" != "true" ]; then
    err "Smoke tests FAILED — triggering rollback"
    do_rollback
    exit 1
  fi

  log "All smoke tests passed"
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
    git checkout "$PREV_HEAD" --force
    log "Rolled back code to $PREV_HEAD"
  fi

  if [ "$MIGRATIONS_APPLIED" -gt 0 ] 2>/dev/null && [ -s /tmp/pre-deploy-db.sql.gz ]; then
    log "Restoring pre-deploy database..."
    gunzip -c /tmp/pre-deploy-db.sql.gz \
      | docker exec -i supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0
    if [ $? -eq 0 ]; then
      log "Database restored"
    else
      err "Database restore had errors — manual check needed"
    fi
  fi

  docker compose up -d
  log "Services restarted with rolled-back code"

  # Verify rollback health (inline, no recursive rollback)
  sleep 10
  ANON_KEY=$(get_anon_key)
  for endpoint in \
    "http://localhost:54321/rest/v1/" \
    "http://localhost:54321/auth/v1/health" \
    "http://localhost:54321/functions/v1/api-v1-health"; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "$endpoint" -H "apikey: $ANON_KEY" || echo "000")
    if [ "$CODE" -ge 200 ] && [ "$CODE" -lt 500 ]; then
      log "  Rollback check OK: $endpoint (HTTP $CODE)"
    else
      err "  Rollback check FAIL: $endpoint (HTTP $CODE)"
    fi
  done

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
