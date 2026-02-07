#!/bin/bash
# BFF Migration Test Script

PROJECT_URL="https://***REMOVED***"
TOKEN="${SUPABASE_ANON_KEY:-your-anon-key}"

echo "🧪 Testing BFF Migration Endpoints"
echo "=================================="

# Test 1: Challenges
echo -e "\n1️⃣  Testing /api-v1-challenges..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$PROJECT_URL/functions/v1/api-v1-challenges?aggregate=true"

# Test 2: Profile Session
echo -e "\n2️⃣  Testing /api-v1-profile?action=session..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$PROJECT_URL/functions/v1/api-v1-profile?action=session"

# Test 3: Products with include
echo -e "\n3️⃣  Testing /api-v1-products?id=<id>&include=owner,related..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$PROJECT_URL/functions/v1/api-v1-products?id=test&include=owner,related"

# Test 4: Notifications aggregate
echo -e "\n4️⃣  Testing /api-v1-notifications?mode=aggregate..."
curl -s -o /dev/null -w "Status: %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "$PROJECT_URL/functions/v1/api-v1-notifications?mode=aggregate"

echo -e "\n✅ Deployment complete!"
echo "📝 Next steps:"
echo "   1. Apply migration manually via Supabase dashboard"
echo "   2. Update mobile/web clients"
echo "   3. Monitor BFF traffic for 2 weeks"
echo "   4. Delete BFF after Feb 27"
