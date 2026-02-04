#!/bin/bash
# Test the app-release email template
#
# Usage:
#   ./scripts/test-app-release-email.sh your-email@example.com
#
# Get your service role key from:
#   https://supabase.com/dashboard/project/***REMOVED***/settings/api

set -e

EMAIL="${1:-tarlan@foodshare.club}"
SUPABASE_URL="https://***REMOVED***"

# Check if SERVICE_ROLE_KEY is set
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "❌ Please set SUPABASE_SERVICE_ROLE_KEY environment variable"
  echo ""
  echo "Get it from: https://supabase.com/dashboard/project/***REMOVED***/settings/api"
  echo ""
  echo "Then run:"
  echo "  export SUPABASE_SERVICE_ROLE_KEY='your-key-here'"
  echo "  ./scripts/test-app-release-email.sh $EMAIL"
  exit 1
fi

echo "🧪 Testing app-release email template..."
echo "📧 Sending to: $EMAIL"
echo ""

curl -s -X POST "${SUPABASE_URL}/functions/v1/api-v1-email-template/send" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"slug\": \"app-release\",
    \"to\": \"${EMAIL}\",
    \"variables\": {
      \"platform\": \"iOS\"
    }
  }" | jq .

echo ""
echo "✅ Check your inbox!"
