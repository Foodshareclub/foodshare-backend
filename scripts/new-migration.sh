#!/usr/bin/env bash
#
# Create a new timestamped migration file.
#
# Usage:
#   ./scripts/new-migration.sh <description>
#   ./scripts/new-migration.sh add_user_preferences
#
# Creates: supabase/migrations/YYYYMMDDHHmmss_<description>.sql

set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

if [ $# -eq 0 ]; then
  echo "Usage: $0 <description>"
  echo "  description: lowercase snake_case (e.g. add_user_preferences)"
  exit 1
fi

DESC="$1"

# Validate description
if ! echo "$DESC" | grep -qE '^[a-z][a-z0-9_]+$'; then
  echo "Error: description must be lowercase snake_case: [a-z][a-z0-9_]+"
  echo "  Good: add_user_preferences, fix_rls_policies"
  echo "  Bad:  Add-Users, 123foo, a"
  exit 1
fi

# Generate UTC timestamp matching existing convention
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
FILENAME="${TIMESTAMP}_${DESC}.sql"
FILEPATH="${MIGRATIONS_DIR}/${FILENAME}"

# Create file with template
cat > "$FILEPATH" << 'SQL'
-- Migration: TODO describe what this migration does
--
-- Reminders:
--   - Use CREATE INDEX CONCURRENTLY to avoid blocking queries
--   - Enable RLS on new tables: ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   - Test with: psql -v ON_ERROR_STOP=1 -f <this file>

SQL

echo "Created: supabase/migrations/${FILENAME}"

# Open in editor if set
if [ -n "${EDITOR:-}" ]; then
  exec "$EDITOR" "$FILEPATH"
fi
