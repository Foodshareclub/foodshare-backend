#!/bin/bash
# Test LLM Translation Endpoint
# Usage: ./scripts/test-llm-endpoint.sh

set -e

echo "🧪 Testing LLM Translation via Ollama Chat API..."
echo ""
echo "Endpoint: https://ollama.foodshare.club/api/chat"
echo "Model: qwen2.5-coder:7b"
echo ""

curl -X POST https://ollama.foodshare.club/api/chat \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: 546b88a3efd36b53f35cd8508ba25560.access" \
  -H "CF-Access-Client-Secret: e483bb03a4d8916403693ed072a73b22343b901f11e79f383996fbe2dbe0192e" \
  -d '{
    "model": "qwen2.5-coder:7b",
    "messages": [
      {
        "role": "system",
        "content": "You are a professional translator. Translate the following text from English to Spanish. Return ONLY the translation, no explanations."
      },
      {
        "role": "user",
        "content": "Fresh apples from my garden, ready to share!"
      }
    ],
    "stream": false,
    "options": {
      "temperature": 0.3,
      "num_predict": 100
    }
  }' | jq '.message.content'

echo ""
echo ""
echo "✅ If you see a Spanish translation above, the Ollama endpoint is working!"
echo ""
echo "📝 Note: Currently using Ollama chat API directly."
echo "   To use dedicated translation service, activate Cloudflare Tunnel route #5:"
echo "   - Subdomain: ollama"
echo "   - Path: /api/translate"
echo "   - Service: http://translate-service:8080"
echo ""
echo "Next: Deploy the BFF with ./scripts/deploy-llm-translation.sh"
