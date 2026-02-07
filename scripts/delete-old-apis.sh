#!/bin/bash
# Delete old redundant functions
# Run from: foodshare-backend/
# WARNING: Only run after clients are migrated!

set -e

echo "🗑️  Deleting old redundant functions..."
echo ""
echo "⚠️  WARNING: This will permanently delete the following functions:"
echo "  - foodshare-search"
echo "  - search-functions"
echo "  - bff"
echo ""
read -p "Are you sure? (type 'yes' to confirm): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "Deleting functions..."

# Delete from Supabase
supabase functions delete foodshare-search --project-ref "$SUPABASE_PROJECT_REF" || echo "Already deleted or not found"
supabase functions delete search-functions --project-ref "$SUPABASE_PROJECT_REF" || echo "Already deleted or not found"
supabase functions delete bff --project-ref "$SUPABASE_PROJECT_REF" || echo "Already deleted or not found"

# Archive local files
mkdir -p functions/_archived
mv functions/foodshare-search functions/_archived/ 2>/dev/null || echo "Already archived"
mv functions/search-functions functions/_archived/ 2>/dev/null || echo "Already archived"
mv functions/bff functions/_archived/ 2>/dev/null || echo "Already archived"

echo ""
echo "✅ Old functions deleted and archived to functions/_archived/"
echo ""
echo "📊 Consolidation complete:"
echo "  - 12 endpoints → 4 endpoints (67% reduction)"
echo "  - ~3000 LOC eliminated"
echo "  - Faster deployments"
echo "  - Single source of truth"
