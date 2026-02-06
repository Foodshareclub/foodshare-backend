#!/bin/bash
# Test script for api-v1-ai

set -e

BASE_URL="https://***REMOVED***/functions/v1/api-v1-ai"
JWT="${SUPABASE_JWT:-}"

if [ -z "$JWT" ]; then
  echo "❌ Error: SUPABASE_JWT environment variable not set"
  echo "Usage: SUPABASE_JWT=your_jwt ./test.sh"
  exit 1
fi

echo "🧪 Testing AI API v1..."
echo ""

# Test 1: Health Check
echo "1️⃣ Testing health endpoint..."
curl -s -X GET "$BASE_URL/health" \
  -H "Authorization: Bearer $JWT" | jq '.'
echo ""

# Test 2: List Models
echo "2️⃣ Testing models endpoint..."
curl -s -X GET "$BASE_URL/models" \
  -H "Authorization: Bearer $JWT" | jq '.'
echo ""

# Test 3: Chat Completion
echo "3️⃣ Testing chat endpoint..."
curl -s -X POST "$BASE_URL/chat" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "You are a helpful assistant. Be concise."},
      {"role": "user", "content": "Say hello in one sentence."}
    ],
    "model": "llama-3.3-70b-versatile",
    "temperature": 0.7,
    "maxTokens": 50
  }' | jq '.'
echo ""

# Test 4: Embeddings
echo "4️⃣ Testing embeddings endpoint..."
curl -s -X POST "$BASE_URL/embeddings" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello world",
    "model": "text-embedding-3-small"
  }' | jq '.embeddings[0] | length'
echo ""

# Test 5: Structured Generation
echo "5️⃣ Testing structured endpoint..."
curl -s -X POST "$BASE_URL/structured" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Extract: John Doe, 30 years old, lives in New York City"}
    ],
    "schema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "number"},
        "city": {"type": "string"}
      }
    },
    "model": "llama-3.3-70b-versatile"
  }' | jq '.'
echo ""

# Test 6: Rate Limiting (make 5 rapid requests)
echo "6️⃣ Testing rate limiting..."
for i in {1..5}; do
  echo "Request $i..."
  curl -s -X POST "$BASE_URL/chat" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d '{
      "messages": [{"role": "user", "content": "Hi"}],
      "model": "llama-3.3-70b-versatile",
      "maxTokens": 10
    }' | jq -r '.choices[0].message.content // .error.message'
  sleep 1
done
echo ""

echo "✅ All tests completed!"
