#!/bin/bash
# Test consolidated APIs
# Run from: foodshare-backend/

set -e

echo "🧪 Testing Consolidated APIs..."
echo ""

# Load env
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi

# Get project URL
PROJECT_URL="${SUPABASE_URL:-https://your-project.supabase.co}"
ANON_KEY="${SUPABASE_ANON_KEY}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

test_endpoint() {
  local name=$1
  local url=$2
  local expected_status=${3:-200}
  
  echo -n "Testing $name... "
  
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $ANON_KEY" \
    "$PROJECT_URL/functions/v1/$url")
  
  if [ "$status" -eq "$expected_status" ]; then
    echo -e "${GREEN}✓${NC} ($status)"
    return 0
  else
    echo -e "${RED}✗${NC} (got $status, expected $expected_status)"
    return 1
  fi
}

echo -e "${BLUE}[1/4] Testing api-v1-search${NC}"
test_endpoint "Semantic search" "api-v1-search?q=pizza&mode=semantic&limit=5"
test_endpoint "Text search" "api-v1-search?q=pizza&mode=text&limit=5"
test_endpoint "Hybrid search" "api-v1-search?q=pizza&mode=hybrid&limit=5"
test_endpoint "Fuzzy search" "api-v1-search?q=pizza&mode=fuzzy&limit=5"
echo ""

echo -e "${BLUE}[2/4] Testing api-v1-profile${NC}"
test_endpoint "Profile (no auth)" "api-v1-profile" 401
echo ""

echo -e "${BLUE}[3/4] Testing api-v1-listings${NC}"
test_endpoint "Listings feed (no auth)" "api-v1-listings?mode=feed&lat=37.7749&lng=-122.4194" 401
echo ""

echo -e "${BLUE}[4/4] Testing api-v1-chat${NC}"
test_endpoint "Chat (no auth)" "api-v1-chat" 401
echo ""

echo -e "${GREEN}✅ Basic tests passed!${NC}"
echo ""
echo "📝 Note: Auth-required endpoints return 401 as expected"
echo "   Use authenticated requests to test full functionality"
