#!/usr/bin/env bash
# ============================================================================
# Migrate Vault Secrets from .env.functions
#
# Reads secret values from .env.functions and inserts them into Supabase vault.
# Must be run on VPS as it needs access to both .env.functions and the DB.
#
# Usage:
#   cd /home/organic/dev/foodshare-backend
#   bash scripts/migrate-vault-secrets.sh
#
# Idempotent: skips secrets that already exist in vault.
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.functions}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
DB_USER="${DB_USER:-supabase_admin}"
DB_NAME="${DB_NAME:-postgres}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Read a value from .env.functions
read_env_value() {
  local key="$1"
  local value
  value=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2-)
  echo "$value"
}

# Run SQL via docker exec
run_sql() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1"
}

# Check if a vault secret exists (parameterized to prevent SQL injection)
secret_exists() {
  local name="$1"
  local result
  result=$(docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
    -v "secret_name=$name" \
    "SELECT COUNT(*) FROM vault.secrets WHERE name = :'secret_name';")
  [ "$result" -gt 0 ]
}

# Create a vault secret (parameterized to prevent SQL injection)
create_secret() {
  local value="$1"
  local name="$2"
  local description="$3"

  if secret_exists "$name"; then
    log_warn "Secret '$name' already exists, skipping"
    return 0
  fi

  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" \
    -v "secret_value=$value" -v "secret_name=$name" -v "secret_desc=$description" <<'SQL' >/dev/null
    SELECT vault.create_secret(:'secret_value', :'secret_name', :'secret_desc');
SQL
  log_info "Created vault secret: $name"
}

# ============================================================================
# Main
# ============================================================================

if [ ! -f "$ENV_FILE" ]; then
  log_error "File not found: $ENV_FILE"
  log_error "Run this script from the foodshare-backend directory on VPS"
  exit 1
fi

# Verify DB container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
  log_error "Docker container '$DB_CONTAINER' is not running"
  exit 1
fi

log_info "Reading secrets from: $ENV_FILE"
log_info "Target: vault in $DB_CONTAINER"
echo ""

# Show existing vault secrets
log_info "Existing vault secrets:"
run_sql "SELECT name FROM vault.decrypted_secrets ORDER BY name;" | while read -r name; do
  echo "  - $name"
done
echo ""

# Secrets to migrate: [env_var_name, vault_secret_name, description]
# Most use the same name in .env.functions and vault
declare -a SECRETS=(
  "OPENAI_API_KEY|OPENAI_API_KEY|OpenAI API key for AI features"
  "RESEND_API_KEY|RESEND_API_KEY|Resend email API key"
  "UPSTASH_REDIS_TOKEN|UPSTASH_REDIS_TOKEN|Upstash Redis authentication token"
  "UPSTASH_REDIS_URL|UPSTASH_REDIS_URL|Upstash Redis REST endpoint"
  "UPSTASH_REDIS_REST_TOKEN|UPSTASH_REDIS_REST_TOKEN|Upstash Redis REST authentication token"
  "UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_URL|Upstash Redis REST endpoint"
  "AIRTABLE_API_TOKEN|AIRTABLE_API_TOKEN|Airtable API token"
  "AIRTABLE_API_TOKEN|AIRTABLE_API_KEY|Airtable API key (alias of AIRTABLE_API_TOKEN)"
  "REVENUECAT_SECRET_API_KEY|REVENUECAT_SECRET_API_KEY|RevenueCat Secret API Key"
  "REVENUECAT_IOS_PUBLIC_KEY|REVENUECAT_IOS_PUBLIC_KEY|RevenueCat iOS Public API Key"
  "REVENUECAT_ANDROID_PUBLIC_KEY|REVENUECAT_ANDROID_PUBLIC_KEY|RevenueCat Android Public API Key"
  "MOTHERDUCK_TOKEN|MOTHERDUCK_TOKEN|MotherDuck token for analytics (used by api-v1-analytics)"
)

created=0
skipped=0
missing=0

for entry in "${SECRETS[@]}"; do
  IFS='|' read -r env_key vault_name description <<< "$entry"

  value=$(read_env_value "$env_key")
  if [ -z "$value" ]; then
    log_warn "No value found for $env_key in $ENV_FILE — skipping $vault_name"
    missing=$((missing + 1))
    continue
  fi

  if secret_exists "$vault_name"; then
    log_warn "Secret '$vault_name' already exists, skipping"
    skipped=$((skipped + 1))
  else
    create_secret "$value" "$vault_name" "$description"
    created=$((created + 1))
  fi
done

echo ""
log_info "Done! Created: $created, Skipped: $skipped, Missing from env: $missing"
echo ""

# Verification
log_info "All vault secrets after migration:"
run_sql "SELECT name FROM vault.decrypted_secrets ORDER BY name;" | while read -r name; do
  echo "  - $name"
done

echo ""
log_info "Verification queries:"
echo "  SELECT public.get_openai_api_key() IS NOT NULL AS has_openai_key;"
echo "  SELECT public.get_resend_api_key() IS NOT NULL AS has_resend_key;"
echo "  SELECT public.get_vault_secret('MOTHERDUCK_TOKEN') IS NOT NULL AS has_motherduck;"
echo "  SELECT * FROM public.list_required_secrets();"
