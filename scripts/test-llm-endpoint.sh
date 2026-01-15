#!/bin/bash
# Test LLM Translation Endpoint
# Usage: ./scripts/test-llm-endpoint.sh

set -e

echo "🧪 Testing LLM Translation Endpoint..."
echo ""

# Test: Translation Service API
echo "Test: Translation Service API"
echo "Endpoint: https://ollama.foodshare.club/api/translate"
echo ""

curl -X POST https://ollama.foodshare.club/api/translate \
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
echo "✅ If you see a Spanish translation above, the translation service is working!"
echo ""
echo "Next: Deploy the BFF with ./scripts/deploy-llm-translation.sh"
