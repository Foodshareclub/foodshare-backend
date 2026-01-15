#!/bin/bash
# Test LLM Translation Endpoint
# Usage: ./scripts/test-llm-endpoint.sh

set -e

echo "🧪 Testing Production Translation Service..."
echo ""
echo "Endpoint: https://translate.foodshare.club/api/translate"
echo "Status: ✅ LIVE"
echo ""
echo "Testing English to Spanish translation..."
echo ""

curl -X POST https://translate.foodshare.club/api/translate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b" \
  -d '{
    "text": "Fresh apples from my garden, ready to share!",
    "targetLanguage": "es",
    "sourceLanguage": "en",
    "context": "food-sharing platform"
  }' | jq '.'

echo ""
echo ""
echo "✅ If you see a Spanish translation above, the service is working!"
echo ""
echo "📊 Supported languages (21):"
echo "   en, es, fr, de, pt, cs, ru, uk, it, pl, nl, sv,"
echo "   zh, hi, ja, ko, vi, id, th, ar, tr"
echo ""
echo "Next: Deploy the BFF with ./scripts/deploy-llm-translation.sh"
