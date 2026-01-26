#!/bin/bash
# Setup Embedding API Keys for FoodShare Search
#
# This script sets the API keys for embedding providers.
# The fallback chain is: Zep.ai -> OpenAI -> Groq -> HuggingFace
#
# Usage:
#   ./scripts/setup-embedding-secrets.sh
#
# Required environment variables (set before running):
#   ZAI_API_KEY       - Zep.ai API key (optional, get from https://z.ai)
#   GROQ_API_KEY      - Groq API key (optional, get from https://console.groq.com)
#
# Already configured:
#   OPENAI_API_KEY       - Set from vault
#   HUGGINGFACE_ACCESS_TOKEN - Already set

set -e

echo "=== FoodShare Embedding Secrets Setup ==="
echo ""

# Check current status
echo "Current embedding provider status:"
curl -s "https://***REMOVED***/functions/v1/foodshare-search/health" | \
  jq -r '.embeddings | to_entries[] | "\(.key): \(if .value.healthy then "✅ Healthy" else "❌ Not configured" end)"'

echo ""

# Set Zep.ai key if provided
if [ -n "$ZAI_API_KEY" ]; then
  echo "Setting ZAI_API_KEY..."
  npx supabase secrets set ZAI_API_KEY="$ZAI_API_KEY"
  echo "✅ Zep.ai API key set"
else
  echo "⚠️  ZAI_API_KEY not set - Zep.ai will be skipped"
  echo "   Get your key from: https://z.ai"
fi

# Set Groq key if provided
if [ -n "$GROQ_API_KEY" ]; then
  echo "Setting GROQ_API_KEY..."
  npx supabase secrets set GROQ_API_KEY="$GROQ_API_KEY"
  echo "✅ Groq API key set"
else
  echo "⚠️  GROQ_API_KEY not set - Groq will be skipped"
  echo "   Get your key from: https://console.groq.com"
fi

echo ""
echo "=== Done ==="
echo "Redeploy the function to pick up new secrets:"
echo "  npx supabase functions deploy foodshare-search --no-verify-jwt"
