#!/usr/bin/env bash
# Manual VPS backup — same logic as the backup-vps.yml workflow.
# Run from VPS: ./scripts/backup-vps-state.sh
set -euo pipefail

cd /home/organic/dev/foodshare-backend

BACKUP_DIR="/home/organic/backups"
DATE=$(date -u +%Y-%m-%d)
TIMESTAMP=$(date -u +%Y-%m-%dT%H%M%SZ)

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/db"

echo "=== VPS Backup: $TIMESTAMP ==="

# Database dump
echo "--- Database dump ---"
DB_FILE="$BACKUP_DIR/db/foodshare-$DATE.sql.gz"
docker exec supabase-db pg_dump -U supabase_admin -d postgres \
  --no-owner --no-privileges --clean --if-exists \
  -N _analytics -N _realtime -N supabase_functions \
  | gzip > "$DB_FILE"
echo "DB dump: $(du -h "$DB_FILE" | cut -f1)"

# Secrets snapshot
echo "--- Secrets snapshot ---"
SECRETS_FILE="$BACKUP_DIR/daily/secrets-$DATE.tar.gz"
tar czf "$SECRETS_FILE" \
  .env \
  .env.functions \
  docker-compose.override.yml \
  2>/dev/null || tar czf "$SECRETS_FILE" .env .env.functions 2>/dev/null || true
echo "Secrets: $(du -h "$SECRETS_FILE" | cut -f1)"

# Git state (backup/vps branch, no branch switching)
echo "--- Git state snapshot ---"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "Working tree clean — skipped"
else
  git add -A
  TREE=$(git write-tree)
  git reset HEAD --quiet

  PARENT=$(git rev-parse --verify refs/heads/backup/vps 2>/dev/null || echo "")
  SKIP=false
  if [ -n "$PARENT" ]; then
    [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ] && SKIP=true
  fi

  if [ "$SKIP" = false ]; then
    MSG="backup: $DATE ($TIMESTAMP)
main: $(git rev-parse --short HEAD)
dirty: $(git status --porcelain | wc -l | tr -d ' ') files"

    if [ -n "$PARENT" ]; then
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE" -p "$PARENT")
    else
      COMMIT=$(echo "$MSG" | git commit-tree "$TREE")
    fi

    git update-ref refs/heads/backup/vps "$COMMIT"
    git push origin backup/vps --force --quiet
    echo "Pushed: $(git rev-parse --short "$COMMIT")"
  else
    echo "No changes since last backup"
  fi
fi

# Rotate (keep 14 days)
find "$BACKUP_DIR/db" -name "*.sql.gz" -mtime +14 -delete 2>/dev/null || true
find "$BACKUP_DIR/daily" -name "*.tar.gz" -mtime +14 -delete 2>/dev/null || true

echo "=== Backup complete ==="
