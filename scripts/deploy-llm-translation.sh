#!/bin/bash
# Deploy LLM Translation System
# Usage: ./scripts/deploy-llm-translation.sh

set -e

echo "🚀 Deploying LLM Translation System..."

# Check if we're in the right directory
if [ ! -f "supabase/functions/bff/index.ts" ]; then
  echo "❌ Error: Must run from foodshare-backend directory"
  exit 1
fi

# Step 1: Apply database migration
echo ""
echo "📊 Step 1: Applying database migration..."
npx supabase db push

echo "✅ Database migration applied"

# Step 2: Add secrets to Vault (manual step)
echo ""
echo "🔐 Step 2: Adding secrets to Vault..."
echo "Run this SQL in Supabase SQL Editor:"
echo ""
cat supabase/migrations/20260115_add_llm_secrets.sql
echo ""
read -p "Press Enter after adding secrets to Vault..."

# Step 3: Deploy BFF function
echo ""
echo "🌐 Step 3: Deploying BFF function..."
npx supabase functions deploy bff --no-verify-jwt

echo ""
echo "✅ LLM Translation System deployed successfully!"
echo ""
echo "📝 Next steps:"
echo "1. Test translation endpoint:"
echo "   curl -X POST https://***REMOVED***/functions/v1/bff/translate \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -d '{\"content_type\":\"post\",\"content_id\":\"123\",\"target_locale\":\"es\",\"fields\":[\"post_name\"]}'"
echo ""
echo "2. Test feed with translation:"
echo "   curl 'https://***REMOVED***/functions/v1/bff/feed?translate=true&locale=fr&limit=5'"
echo ""
echo "3. Monitor translation stats:"
echo "   SELECT * FROM get_translation_stats();"
echo ""
