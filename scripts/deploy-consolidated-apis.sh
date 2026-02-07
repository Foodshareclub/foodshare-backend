#!/bin/bash
# Deploy consolidated APIs
# Run from: foodshare-backend/

set -e

echo "🚀 Deploying Consolidated APIs..."
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

cd "$(dirname "$0")"

# 1. Deploy unified search API
echo -e "${BLUE}[1/4]${NC} Deploying api-v1-search..."
supabase functions deploy api-v1-search --no-verify-jwt
echo -e "${GREEN}✓${NC} api-v1-search deployed"
echo ""

# 2. Deploy enhanced profile API
echo -e "${BLUE}[2/4]${NC} Deploying api-v1-profile..."
supabase functions deploy api-v1-profile --no-verify-jwt
echo -e "${GREEN}✓${NC} api-v1-profile deployed"
echo ""

# 3. Deploy enhanced listings API
echo -e "${BLUE}[3/4]${NC} Deploying api-v1-listings..."
supabase functions deploy api-v1-listings --no-verify-jwt
echo -e "${GREEN}✓${NC} api-v1-listings deployed"
echo ""

# 4. Deploy enhanced chat API
echo -e "${BLUE}[4/4]${NC} Deploying api-v1-chat..."
supabase functions deploy api-v1-chat --no-verify-jwt
echo -e "${GREEN}✓${NC} api-v1-chat deployed"
echo ""

echo -e "${GREEN}✅ All APIs deployed successfully!${NC}"
echo ""
echo "📝 Next steps:"
echo "  1. Run ./scripts/test-consolidated-apis.sh to verify"
echo "  2. Update mobile clients to use new endpoints"
echo "  3. Monitor for 1 week before deprecating old endpoints"
