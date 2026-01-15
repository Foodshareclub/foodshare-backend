#!/bin/bash
# Update missing iOS translations in Supabase
# Usage: ./update_ios_translations.sh [locale]
# Example: ./update_ios_translations.sh en

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_URL="https://***REMOVED***"

# Check for service role key
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "Error: SUPABASE_SERVICE_ROLE_KEY environment variable not set"
    echo "Get it from: Supabase Dashboard > Settings > API > service_role key"
    exit 1
fi

LOCALE=${1:-en}
TRANSLATIONS_FILE="$SCRIPT_DIR/missing_ios_translations_${LOCALE}.json"

if [ ! -f "$TRANSLATIONS_FILE" ]; then
    echo "Error: Translation file not found: $TRANSLATIONS_FILE"
    exit 1
fi

echo "=== Updating iOS Translations for $LOCALE ==="
echo "File: $TRANSLATIONS_FILE"
echo ""

TRANSLATIONS=$(cat "$TRANSLATIONS_FILE")

response=$(curl -s -X POST "$SUPABASE_URL/functions/v1/update-translations" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"locale\": \"$LOCALE\", \"translations\": $TRANSLATIONS}")

if echo "$response" | grep -q '"success":true'; then
    added=$(echo "$response" | grep -o '"added":[0-9]*' | cut -d: -f2)
    total=$(echo "$response" | grep -o '"total":[0-9]*' | cut -d: -f2)
    echo "✅ $LOCALE updated successfully"
    echo "   Added: $added keys"
    echo "   Total: $total keys"
else
    echo "❌ $LOCALE failed:"
    echo "$response"
    exit 1
fi
