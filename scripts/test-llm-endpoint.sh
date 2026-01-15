#!/bin/bash
# Test LLM Translation Endpoint
# Usage: ./scripts/test-llm-endpoint.sh

set -e

echo "🧪 Testing Dedicated Translation Service..."
echo ""
echo "Endpoint: https://ollama.foodshare.club/api/translate"
echo ""
echo "⚠️  IMPORTANT: This requires Cloudflare Tunnel route #5 to be activated:"
echo "   - Subdomain: ollama"
echo "   - Domain: foodshare.club"
echo "   - Path: /api/translate"
echo "   - Service: http://translate-service:8080"
echo ""
echo "Testing..."
echo ""

curl -X POST https://ollama.foodshare.club/api/translate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b" \
  -H "CF-Access-Client-Id: 546b88a3efd36b53f35cd8508ba25560.access" \
  -H "CF-Access-Client-Secret: e483bb03a4d8916403693ed072a73b22343b901f11e79f383996fbe2dbe0192e" \
  -d '{
    "text": "Fresh apples from my garden, ready to share!",
    "targetLanguage": "es",
    "sourceLanguage": "en",
    "context": "food-sharing platform"
  }' | jq '.'

echo ""
echo ""
echo "✅ If you see a Spanish translation above, the translation service is working!"
echo ""
echo "❌ If you see 404, activate the Cloudflare Tunnel route first."
echo ""
echo "Next: Deploy the BFF with ./scripts/deploy-llm-translation.sh"
