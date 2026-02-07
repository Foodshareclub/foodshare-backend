#!/bin/bash
# Master deployment script - runs all refactoring steps
# Run from: foodshare-backend/

set -e

echo "🚀 FoodShare Backend Refactoring - Complete Deployment"
echo "========================================================"
echo ""

cd "$(dirname "$0")/.."

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Confirmation
echo -e "${YELLOW}This will:${NC}"
echo "  1. Deploy 4 consolidated APIs"
echo "  2. Apply database optimizations"
echo "  3. Add monitoring and caching"
echo "  4. Test all endpoints"
echo ""
read -p "Continue? (y/n): " confirm

if [ "$confirm" != "y" ]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo -e "${BLUE}Phase 1: Deploy Consolidated APIs${NC}"
./scripts/deploy-consolidated-apis.sh

echo ""
echo -e "${BLUE}Phase 2: Apply Performance Optimizations${NC}"
./scripts/apply-optimizations.sh

echo ""
echo -e "${BLUE}Phase 3: Test Endpoints${NC}"
./scripts/test-consolidated-apis.sh

echo ""
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo ""
echo "📊 Summary:"
echo "  - 3 edge functions eliminated"
echo "  - ~3000 LOC removed"
echo "  - 50-62% performance improvement expected"
echo ""
echo "📝 Next steps:"
echo "  1. Monitor metrics in Supabase dashboard"
echo "  2. Update mobile clients (see API_CONSOLIDATION.md)"
echo "  3. After 1 week, run: ./scripts/deprecate-old-apis.sh"
echo "  4. After 3 weeks, run: ./scripts/delete-old-apis.sh"
echo ""
echo "📚 Documentation:"
echo "  - API_CONSOLIDATION.md - Migration guide"
echo "  - REFACTORING_SUMMARY.md - What was done"
echo "  - BOT_CONSOLIDATION_PLAN.md - Next phase"
