#!/usr/bin/env bash
# Usage: ./scripts/deploy.sh <stage> [options]
#
# Stages: backup, pull, sync-vault, new-migration, migrate, restart, smoke, rollback, status
# State:  /tmp/deploy-state.json (persists between stages)
#
# Examples:
#   ./scripts/deploy.sh status              # Check service health
#   ./scripts/deploy.sh smoke               # Run smoke tests
#   ./scripts/deploy.sh backup              # Pre-deploy backup
#   ./scripts/deploy.sh restart full        # Full stack restart
#   ./scripts/deploy.sh restart functions   # Zero-downtime function restart
#   ./scripts/deploy.sh new-migration desc  # Create migration file

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

# Timer: call stage_start at the beginning, stage_end at the end
stage_start() {
  STAGE_START_TIME=$SECONDS
  log "=== $1 ==="
}

stage_end() {
  local elapsed=$(( SECONDS - STAGE_START_TIME ))
  log "=== $1 completed in ${elapsed}s ==="
}

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
  grep -m1 "^${key}=" .env 2>/dev/null | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || echo ""
}

get_anon_key()    { get_env_value "ANON_KEY"; }
get_service_key() { get_env_value "SERVICE_ROLE_KEY"; }

# ── Stage: backup ───────────────────────────────────────────────────────

do_backup() {
  require_dir
  state_init "backup"
  stage_start "Backup"

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

  # For Git tracking, always place latest snapshot in the repo's backups/ directory
  mkdir -p backups
  DB_TARGET="backups/db.sql.gz"

  if [ "$DAILY" = true ]; then
    log "Daily VPS backup to Git"
    mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/db"
  else
    log "Pre-deploy backup to Git"
  fi

  # Database dump
  log "Database dump..."
  timeout 120 docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --clean --if-exists \
    -N _analytics -N _realtime -N supabase_functions \
    | gzip > "$DB_TARGET"
  DB_SIZE=$(du -h "$DB_TARGET" | cut -f1)
  log "DB dump: $DB_SIZE"

  # Upload to R2 (optional off-site backup)
  if [ -f "scripts/backup-to-r2.ts" ]; then
    log "Uploading backup to R2..."
    export PATH="/home/organic/.deno/bin:$PATH"
    if (set -a && [ -f .env.functions ] && . .env.functions && /home/organic/.deno/bin/deno run --allow-read --allow-net --allow-env --allow-sys scripts/backup-to-r2.ts "$DB_TARGET"); then
      log "Off-site backup SUCCESS"
    else
      log "WARNING: Off-site backup FAILED (continuing with local)"
    fi
  fi

  # Verify dump is non-empty
  if [ ! -s "$DB_TARGET" ]; then
    err "Database dump is empty!"
    exit 1
  fi

  # Secrets snapshot
  log "Secrets snapshot..."
  cp .env backups/.env 2>/dev/null || true
  cp .env.functions backups/.env.functions 2>/dev/null || true
  cp docker-compose.override.yml backups/docker-compose.override.yml 2>/dev/null || true

  if [ "$DAILY" = true ]; then
    # Create the daily rotated tarball in the external directory for longer retention
    SECRETS_FILE="$BACKUP_DIR/daily/secrets-$DATE.tar.gz"
    tar czf "$SECRETS_FILE" \
      .env \
      .env.functions \
      docker-compose.override.yml \
      2>/dev/null || tar czf "$SECRETS_FILE" .env .env.functions 2>/dev/null || true
    log "Secrets: $(du -h "$SECRETS_FILE" | cut -f1)"

    # Also save DB to long-retention directory
    cp "$DB_TARGET" "$BACKUP_DIR/db/foodshare-$DATE.sql.gz" 2>/dev/null || true
  else
    # Save copy for fast rollback inside /tmp where permissions are restricted
    cp "$DB_TARGET" /tmp/pre-deploy-db.sql.gz
    chmod 600 /tmp/pre-deploy-db.sql.gz
  fi

  # Git snapshot — push to a dedicated backup branch (NOT main)
  # Committing to main causes divergence and blocks deployments
  BRANCH_NAME="backup/vps"

  export GIT_INDEX_FILE=.git/backup_index
  # Start with the current tree
  git read-tree HEAD
  git add -A
  # Force add our local unignored backups folder (contains db.sql.gz and .env)
  git add -f backups/ 2>/dev/null || true
  # Force add persistent user data volumes
  git add -f volumes/storage/ 2>/dev/null || true
  git add -f volumes/snippets/ 2>/dev/null || true

  # Ensure raw DB data is explicitly excluded to prevent torn pages and massive bloat
  git reset volumes/db/data/ 2>/dev/null || true

  TREE=$(git write-tree)
  rm -f .git/backup_index
  unset GIT_INDEX_FILE

  PARENT=$(git rev-parse --verify "refs/heads/$BRANCH_NAME" 2>/dev/null || echo "")
  SKIP=false
  if [ -n "$PARENT" ]; then
    [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ] && SKIP=true
  fi
  if [ "$SKIP" = true ]; then
    log "No changes since last backup — skipped git snapshot"
  else
    if [ "$DAILY" = true ]; then
      MSG="backup(daily): $(date -u +%Y-%m-%dT%H%M%SZ) from $(git rev-parse --short HEAD)"
    else
      MSG="backup(pre-deploy): $TIMESTAMP from $(git rev-parse --short HEAD)"
    fi
    if [ -n "$PARENT" ]; then
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT")
    else
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE")
    fi
    git update-ref "refs/heads/$BRANCH_NAME" "$COMMIT"
    # Push via SSH (deploy key) since origin may be HTTPS
    SSH_URL="git@github.com:Foodsharecom.flutterflow.foodshare-backend.git"

    export GIT_SSH_COMMAND="ssh -i /home/organic/.ssh/vps_backup_deploy_key -o StrictHostKeyChecking=no"
    if git push "$SSH_URL" "$BRANCH_NAME" --force --quiet; then
      log "Pushed $BRANCH_NAME: $(git rev-parse --short "$COMMIT")"
    else
      log "WARNING: Could not push $BRANCH_NAME — local ref updated"
      # Print the error for debugging in CI
      git push "$SSH_URL" "$BRANCH_NAME" --force || true
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
  stage_end "Backup"
}

# ── Vault Operations ──────────────────────────────────────────────────

# Exec SQL in the database container
sql_exec() {
  local query="$1"
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$query"
}

set_vault_secret() {
  local key="$1"
  local val="$2"
  local desc="${3:-Manual update via deploy.sh}"

  if [ -z "$key" ] || [ -z "$val" ]; then
    log "ERROR: Key and value are required for set-secret"
    return 1
  fi

  # Escape single quotes for SQL
  val="${val//\'/\'\'}"
  
  log "Setting secret $key in Vault..."
  sql_exec "
    DO \$\$
    BEGIN
      IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = '$key') THEN
        PERFORM vault.update_secret((SELECT id FROM vault.secrets WHERE name = '$key'), new_secret := '$val');
      ELSE
        PERFORM vault.create_secret('$val', '$key', '$desc');
      END IF;
    END \$\$;
  " >/dev/null
}

get_vault_secrets() {
  sql_exec "SELECT name || '=' || decrypted_secret FROM vault.decrypted_secrets ORDER BY name;"
}

sync_secrets_to_vault() {
  local env_file="$1"
  if [ ! -f "$env_file" ]; then
    log "INFO: No $env_file found to sync"
    return
  fi

  log "Syncing secrets for $env_file..."
  
  # 1. Injection: Push from SSH Environment -> Vault
  # This allows GitHub Actions to still seed the Vault with missing secrets
  # but they are un-set in the Workflow later.
  local secrets_to_sync=(
    "POSTGRES_PASSWORD" "JWT_SECRET" "ANON_KEY" "SERVICE_ROLE_KEY"
    "GOTRUE_EXTERNAL_APPLE_CLIENT_ID" "GOTRUE_EXTERNAL_APPLE_SECRET"
    "GOTRUE_EXTERNAL_APPLE_TEAM_ID" "GOTRUE_EXTERNAL_APPLE_KEY_ID"
    "GOTRUE_EXTERNAL_APPLE_PRIVATE_KEY" "GOTRUE_EXTERNAL_APPLE_REDIRECT_URI"
    "GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID" "GOTRUE_EXTERNAL_GOOGLE_SECRET" "GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI"
    "GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID" "GOTRUE_EXTERNAL_FACEBOOK_SECRET"
    "OPEN_AI_API_KEY" "RESEND_API_KEY"
    "NEXT_PUBLIC_OAUTH_GOOGLE_ENABLED" "NEXT_PUBLIC_OAUTH_FACEBOOK_ENABLED"
    "NEXT_PUBLIC_OAUTH_APPLE_ENABLED" "NEXT_PUBLIC_OAUTH_GITHUB_ENABLED"
    "SITE_DOMAIN" "CADDY_ACME_EMAIL"
    "CLOUDFLARE_API_TOKEN" "CLOUDFLARE_DNS_ZONE_TOKEN_ORGANIC" "CLOUDFLARE_ZONE_ID"
    "VERCEL_FOODSHARE_TOKEN"
  )
  for key in "${secrets_to_sync[@]}"; do
    local val="${!key}"
    if [ -n "$val" ]; then
      set_vault_secret "$key" "$val" "Injected via GitHub Actions environment"
    fi
  done

  # 2. Pull down from Vault -> Env File (Vault is source of truth)
  # We use a temporary file to rebuild the .env cleanly, avoiding duplicates
  local vault_data
  vault_data=$(get_vault_secrets)
  
  local tmp_env="${env_file}.new"
  # Copy existing non-syncable settings if needed, or start fresh
  # For our setup, Vault is the source of truth for ALL synced keys
  cp "$env_file" "$tmp_env"
  
  while IFS= read -r line; do
    local key="${line%%=*}"
    local val="${line#*=}"
    
    # Update or Add using a cleaner awk script to handle the replacement
    if grep -q "^${key}=" "$tmp_env"; then
      perl -i -pe "s|^${key}=.*|${key}=${val}|" "$tmp_env"
    else
      echo "${key}=${val}" >> "$tmp_env"
    fi
  done <<< "$vault_data"

  # Final cleanup: ensure no duplicate keys remain (keep the last one)
  awk -F= '!a[$1]++' "$tmp_env" > "${tmp_env}.final" && mv "${tmp_env}.final" "$env_file"
  rm -f "$tmp_env"
}

# ── Stage: pull ─────────────────────────────────────────────────────────

do_pull() {
  require_dir
  state_write "stage" "pull"
  stage_start "Pull"

  PREV_HEAD=$(git rev-parse HEAD)
  state_write "prev_head" "$PREV_HEAD"

  log "Pulling latest code..."
  git checkout main --quiet || true
  git pull origin main --ff-only

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

  stage_end "Pull"
}

# ── Stage: migrate ──────────────────────────────────────────────────────

do_migrate() {
  require_dir
  state_write "stage" "migrate"
  stage_start "Migrate"

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

  stage_end "Migrate ($APPLIED applied)"
}

# ── Smoke test helper ──────────────────────────────────────────────────

check_endpoint() {
  local name="$1" url="$2" headers="$3" retries="${4:-1}" delay="${5:-0}"
  local code
  for i in $(seq 1 "$retries"); do
    # Sleep between attempts, not before the first one
    [ "$i" -gt 1 ] && [ "$delay" -gt 0 ] && sleep "$delay"
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

# ── Health check loop for functions ────────────────────────────────────

check_functions_health() {
  local retries="${1:-10}"
  local delay="${2:-5}"
  local url="http://localhost:54321/functions/v1/api-v1-health"
  local anon_key
  anon_key=$(get_anon_key)

  if [ -z "$anon_key" ]; then
    log "WARNING: ANON_KEY not found, skipping function health check"
    return 0
  fi

  log "Waiting for edge functions to initialise..."
  for i in $(seq 1 "$retries"); do
    [ "$i" -gt 1 ] && sleep "$delay"
    local code
    code=$(curl -sf -o /dev/null -w "%{http_code}" \
      -H "apikey: $anon_key" \
      -H "Host: api.foodshare.club" \
      "$url" 2>/dev/null || echo "000")

    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
      log "PASS: Edge functions healthy (attempt $i, HTTP $code)"
      return 0
    fi
    log "  Attempt $i: HTTP $code — retrying in ${delay}s..."
  done

  err "FAIL: Edge functions unhealthy after $retries attempts"
  return 1
}

# ── Stage: restart ──────────────────────────────────────────────────────

do_restart() {
  require_dir
  state_write "stage" "restart"
  stage_start "Restart"

  # Sync secrets to Vault for Studio visibility and Edge Function access
  sync_secrets_to_vault ".env.functions"
  sync_secrets_to_vault ".env"

  MODE="${1:-detect}"

  case "$MODE" in
    full)
      log "Full stack restart"
      docker compose up -d

      # Restart services for environment variables to take effect
      log "Restarting services to pick up new secrets..."
      docker compose restart kong

      # Verify functions came up healthy
      sleep 10
      check_functions_health 5 3 || log "WARNING: Functions health check failed after full restart"
      ;;
    functions)
      log "Restarting edge functions (zero-downtime)"
      docker compose up -d --force-recreate functions
      sleep 10
      check_functions_health || {
        err "Functions failed health check — triggering rollback"
        do_rollback
        exit 1
      }
      ;;
    config)
      log "Configuration changed — recreating auth and functions"
      docker compose up -d --force-recreate auth functions
      sleep 10
      check_functions_health 5 3 || log "WARNING: Functions health check failed after config restart"
      ;;
    rest)
      log "Restarting PostgREST (schema cache refresh)"
      docker compose restart rest
      ;;
    detect)
      CHANGED=$(state_read "changed_files" "")
      if [ -z "$CHANGED" ]; then
        log "No changes — skipping restart"
        stage_end "Restart (skipped)"
        return 0
      fi
      if echo "$CHANGED" | grep -qE '(docker-compose\.yml|\.env\.example|volumes/)'; then
        log "Infrastructure changed — full restart"
        # Rebuild Caddy if its Dockerfile changed (avoids stale base image cache)
        if echo "$CHANGED" | grep -q "Dockerfile.caddy"; then
          log "Caddy Dockerfile changed — rebuilding with --no-cache --pull"
          docker compose build --pull --no-cache caddy
        fi
        docker compose up -d --force-recreate
      elif echo "$CHANGED" | grep -q "Dockerfile.caddy"; then
        log "Caddy Dockerfile changed — rebuilding and restarting caddy"
        docker compose build --pull --no-cache caddy
        docker compose up -d --force-recreate caddy
      elif echo "$CHANGED" | grep -qE 'supabase/functions/'; then
        log "Functions changed — zero-downtime restart"
        docker compose up -d --force-recreate functions
        sleep 10
        check_functions_health || log "WARNING: Functions health check failed"
      elif echo "$CHANGED" | grep -qE 'supabase/migrations/'; then
        log "Migrations only — restarting PostgREST"
        docker compose restart rest
      elif echo "$CHANGED" | grep -qE '\.env'; then
        log "Environment variables changed — restarting auth and functions"
        docker compose up -d --force-recreate auth functions
      else
        log "Config/docs only — no restart needed"
      fi
      ;;
    *)
      err "Unknown restart mode: $MODE (use: full, functions, config, rest, detect)"
      exit 1
      ;;
  esac

  stage_end "Restart ($MODE)"
}

# ── Stage: smoke ────────────────────────────────────────────────────────

do_smoke() {
  require_dir
  state_write "stage" "smoke"
  stage_start "Smoke tests"

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
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 5 5 || SMOKE_PASS=false

  check_endpoint "Auth service" \
    "http://localhost:54321/auth/v1/health" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 1 3 || SMOKE_PASS=false

  check_endpoint "Edge functions" \
    "http://localhost:54321/functions/v1/api-v1-health" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 8 5 || SMOKE_PASS=false

  check_endpoint "DB connectivity" \
    "http://localhost:54321/rest/v1/" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $SERVICE_KEY' -H 'Authorization: Bearer $SERVICE_KEY'" 1 0 || SMOKE_PASS=false

  state_write "smoke" "$SMOKE_PASS"

  if [ "$SMOKE_PASS" != "true" ]; then
    err "Smoke tests FAILED — triggering rollback"
    do_rollback
    exit 1
  fi

  log "All smoke tests passed"

  rm -f /tmp/pre-deploy-db.sql.gz
  log "Cleaned up pre-deploy backup"

  stage_end "Smoke tests"
}

# ── Stage: rollback ─────────────────────────────────────────────────────

do_rollback() {
  require_dir
  state_write "stage" "rollback"
  stage_start "Rollback"

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

  # Use --no-build --pull never to ensure rollback uses exactly what's cached locally
  docker compose up -d --no-build --pull never
  log "Services restarted with rolled-back code"

  # Verify rollback health (inline, no recursive rollback)
  ANON_KEY=$(get_anon_key)
  check_endpoint "Rollback: Kong" \
    "http://localhost:54321/rest/v1/" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Kong"
  check_endpoint "Rollback: Auth" \
    "http://localhost:54321/auth/v1/health" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Auth"
  check_endpoint "Rollback: Functions" \
    "http://localhost:54321/functions/v1/api-v1-health" \
    "-H 'Host: api.foodshare.club' -H 'apikey: $ANON_KEY'" 3 5 || err "Rollback health check failed for Functions"

  state_write "rollback" "done"
  stage_end "Rollback"
  set -e
}

# ── Stage: new-migration ───────────────────────────────────────────────

do_new_migration() {
  local desc="${1:-}"
  if [ -z "$desc" ]; then
    err "Description required (e.g. ./scripts/deploy.sh new-migration add_user_preferences)"
    exit 1
  fi

  if ! echo "$desc" | grep -qE '^[a-z][a-z0-9_]+$'; then
    err "Description must be lowercase snake_case: [a-z][a-z0-9_]+"
    exit 1
  fi

  require_dir
  local timestamp=$(date -u +%Y%m%d%H%M%S)
  local filename="${timestamp}_${desc}.sql"
  local filepath="supabase/migrations/${filename}"

  cat > "$filepath" << SQL
-- Migration: $desc
--
-- Reminders:
--   - Use CREATE INDEX CONCURRENTLY to avoid blocking queries
--   - Enable RLS on new tables: ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   - Test with: psql -v ON_ERROR_STOP=1 -f <this file>

BEGIN;

-- TODO: Add migration logic here

COMMIT;
SQL

  log "Created migration: $filepath"
}

# ── Stage: new-secret-migration ───────────────────────────────────────

do_new_secret_migration() {
  local secret_key="${1:-}"
  if [ -z "$secret_key" ]; then
    err "Secret key required (e.g. ./scripts/deploy.sh new-secret-migration STRIPE_KEY)"
    exit 1
  fi

  if ! echo "$secret_key" | grep -qE '^[A-Z][A-Z0-9_]+$'; then
    err "Secret key must be UPPERCASE snake_case: [A-Z][A-Z0-9_]+"
    exit 1
  fi

  require_dir
  local timestamp=$(date -u +%Y%m%d%H%M%S)
  local desc="add_secret_$(echo "$secret_key" | tr '[:upper:]' '[:lower:]')"
  local filename="${timestamp}_${desc}.sql"
  local filepath="supabase/migrations/${filename}"

  cat > "$filepath" << SQL
-- Migration: Add secret $secret_key to Vault
--
-- This migration ensures that the secret key exists in the Supabase Vault.
-- The value is set to a placeholder if it doesn't already exist.
-- Update the actual value via: ./scripts/deploy.sh set-secret $secret_key <value>

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = '$secret_key') THEN
    PERFORM vault.create_secret('PLACEHOLDER_CHANGE_ME', '$secret_key', 'Created via migration');
  END IF;
END \$\$;
SQL

  log "Created secret migration: $filepath"
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

# ── Stage: sync-vault ──────────────────────────────────────────────────

do_sync_vault() {
  require_dir
  stage_start "Vault sync"
  sync_secrets_to_vault ".env"
  sync_secrets_to_vault ".env.functions"
  stage_end "Vault sync"
}

# ── Main ────────────────────────────────────────────────────────────────

STAGE="${1:-}"
shift 2>/dev/null || true

case "$STAGE" in
  backup)        do_backup "$@" ;;
  pull)          do_pull "$@" ;;
  sync-vault)    do_sync_vault "$@" ;;
  set-secret)    set_vault_secret "$1" "$2" "$3" ;;
  get-secrets)   get_vault_secrets ;;
  new-migration) do_new_migration "$@" ;;
  new-secret-migration) do_new_secret_migration "$@" ;;
  detect)        require_dir; state_init "detect" ;;
  migrate)       do_migrate "$@" ;;
  restart)       do_restart "$@" ;;
  smoke)         do_smoke "$@" ;;
  rollback)      do_rollback "$@" ;;
  status)        do_status "$@" ;;
  *)
    echo "Usage: $0 <stage> [options]"
    echo ""
    echo "Stages:"
    echo "  backup               Pre-deploy backup (DB + secrets + git snapshot)"
    echo "  pull                 Pull latest code (git pull --ff-only)"
    echo "  sync-vault           Sync Vault secrets down to .env files"
    echo "  set-secret           [key] [value] [desc] Set a secret in the Vault"
    echo "  get-secrets          List all secrets in the Vault (KEY=VAL)"
    echo "  new-migration        [desc] Create a new timestamped migration file"
    echo "  new-secret-migration [KEY] Create a migration to seed a secret key"
    echo "  migrate              Apply pending database migrations"
    echo "  restart              Restart services (full|functions|config|rest|detect)"
    echo "  smoke                Run smoke tests"
    echo "  rollback             Rollback to previous state"
    echo "  status               Show service status and deploy state"
    exit 1
    ;;
esac
