#!/bin/bash
# Test LLM Translation Endpoint
# Usage: ./scripts/test-llm-endpoint.sh

set -e

echo "🧪 Testing LLM Translation Endpoint..."
echo ""

# Test 1: Direct Ollama API test
echo "Test 1: Direct Ollama API"
echo "Endpoint: https://ollama.foodshare.club/v1/chat/completions"
echo ""

curl -X POST https://ollama.foodshare.club/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder:7b",
    "messages": [
      {
        "role": "system",
        "content": "You are a translator. Translate the following text from English to Spanish. Return only the translation."
      },
      {
        "role": "user",
        "content": "Fresh apples from my garden, ready to share!"
      }
    ],
    "temperature": 0.3,
    "max_tokens": 100,
    "stream": false
  }' | jq '.'

echo ""
echo ""
echo "✅ If you see a Spanish translation above, the LLM endpoint is working!"
echo ""
echo "Next: Deploy the BFF with ./scripts/deploy-llm-translation.sh"
