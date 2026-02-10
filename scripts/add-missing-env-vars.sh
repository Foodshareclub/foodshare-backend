#!/usr/bin/env bash
# ============================================================================
# Add Missing Environment Variables to .env.functions
#
# Appends missing variables that are referenced by edge functions but not yet
# present in .env.functions. Only adds vars that don't already exist.
#
# Usage:
#   cd /home/organic/dev/foodshare-backend
#   bash scripts/add-missing-env-vars.sh
#
# After running, restart functions:
#   docker compose restart functions
# ============================================================================

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.functions}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ ! -f "$ENV_FILE" ]; then
  log_error "File not found: $ENV_FILE"
  log_error "Run this script from the foodshare-backend directory on VPS"
  exit 1
fi

added=0
skipped=0

# Add a variable if it doesn't already exist in the file
add_var() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    log_warn "Already exists: $key"
    ((skipped++))
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    log_info "Added: $key"
    ((added++))
  fi
}

# Add a comment/section header
add_section() {
  local header="$1"
  echo "" >> "$ENV_FILE"
  echo "# $header" >> "$ENV_FILE"
}

# ============================================================================
# WhatsApp Bot (critical — causes 500 errors when missing)
# ============================================================================
log_info "Adding WhatsApp variables..."
add_section "WhatsApp Cloud API"
add_var "WHATSAPP_ACCESS_TOKEN" ""
add_var "WHATSAPP_APP_SECRET" ""
add_var "WHATSAPP_PHONE_NUMBER_ID" ""
add_var "WHATSAPP_VERIFY_TOKEN" ""
add_var "WHATSAPP_BUSINESS_ACCOUNT_ID" ""

# ============================================================================
# Analytics / MotherDuck (used by api-v1-analytics, also in vault)
# ============================================================================
log_info "Adding analytics variables..."
add_section "Analytics (MotherDuck)"
add_var "MOTHERDUCK_TOKEN" ""
add_var "DATABASE_URL" ""

# ============================================================================
# Push Notifications (needed for api-v1-notifications to deliver)
# ============================================================================
log_info "Adding push notification variables..."
add_section "Apple Push Notifications (APNs)"
add_var "APNS_KEY_ID" ""
add_var "APNS_PRIVATE_KEY" ""
add_var "APNS_TEAM_ID" ""
add_var "APNS_BUNDLE_ID" "com.flutterflow.foodshare"
add_var "APNS_ENVIRONMENT" "production"

add_section "Firebase Cloud Messaging (FCM)"
add_var "FCM_PROJECT_ID" ""
add_var "FCM_CLIENT_EMAIL" ""
add_var "FCM_PRIVATE_KEY" ""

add_section "Web Push (VAPID)"
add_var "VAPID_PUBLIC_KEY" ""
add_var "VAPID_PRIVATE_KEY" ""
add_var "VAPID_SUBJECT" "mailto:support@foodshare.club"

# ============================================================================
# Translation (LLM translation currently disabled without these)
# ============================================================================
log_info "Adding translation variables..."
add_section "LLM Translation"
add_var "LLM_TRANSLATION_API_KEY" ""
add_var "LLM_TRANSLATION_ENDPOINT" ""
add_var "GOOGLE_TRANSLATE_API_KEY" ""
add_var "MICROSOFT_TRANSLATOR_API_KEY" ""

# ============================================================================
# App Config (optional — with sensible defaults)
# ============================================================================
log_info "Adding app config variables..."
add_section "App Configuration"
add_var "ENVIRONMENT" "production"
add_var "APP_URL" "https://foodshare.club"
add_var "ANDROID_PACKAGE_NAME" "com.flutterflow.foodshare"
add_var "APP_BUNDLE_ID" "com.flutterflow.foodshare"
add_var "APPLE_TEAM_ID" ""
add_var "APNS_WEBHOOK_SECRET" ""

# ============================================================================
# Webhook Secrets (for verifying inbound webhooks)
# ============================================================================
log_info "Adding webhook secret variables..."
add_section "Webhook Secrets"
add_var "RESEND_WEBHOOK_SECRET" ""
add_var "BREVO_WEBHOOK_SECRET" ""
add_var "MAILERSEND_WEBHOOK_SECRET" ""
add_var "AWS_SES_WEBHOOK_SECRET" ""
add_var "STRIPE_WEBHOOK_SECRET" ""

# ============================================================================
# Alert / Monitoring (optional)
# ============================================================================
log_info "Adding alert config variables..."
add_section "Alerts and Monitoring"
add_var "SLACK_ALERT_WEBHOOK_URL" ""
add_var "ERROR_ALERT_WEBHOOK_URL" ""
add_var "PAGERDUTY_ROUTING_KEY" ""

echo ""
log_info "Done! Added: $added, Already existed: $skipped"
echo ""
log_warn "IMPORTANT: Fill in the empty values for critical vars:"
echo "  - WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN"
echo "  - MOTHERDUCK_TOKEN"
echo "  - APNS_KEY_ID, APNS_PRIVATE_KEY, APNS_TEAM_ID (for iOS push)"
echo "  - FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY (for Android push)"
echo ""
log_warn "Then restart edge functions:"
echo "  docker compose restart functions"
