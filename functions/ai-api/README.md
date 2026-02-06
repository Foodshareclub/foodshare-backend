# AI API v1 - Production-Grade Multi-Provider AI Service

**Status**: ✅ Production Ready  
**Version**: 1.0.0  
**Deployed**: 2026-02-06

---

## Overview

Unified AI API with intelligent multi-provider fallback, circuit breakers, rate limiting, and comprehensive monitoring.

**Providers**:
1. **Groq** (Primary) - Fast inference, free tier
2. **z.ai** (Secondary) - Embeddings + chat
3. **OpenRouter** (Fallback) - Access to all models

---

## Endpoints

### `POST /chat`
Chat completions with streaming support.

**Request**:
```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant" },
    { "role": "user", "content": "Hello!" }
  ],
  "model": "llama-3.3-70b-versatile",
  "temperature": 0.7,
  "maxTokens": 1000,
  "stream": false
}
```

**Response**:
```json
{
  "id": "chatcmpl-123",
  "model": "llama-3.3-70b-versatile",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finishReason": "stop"
    }
  ],
  "usage": {
    "promptTokens": 20,
    "completionTokens": 10,
    "totalTokens": 30
  },
  "provider": "groq",
  "cost": 0
}
```

---

### `POST /embeddings`
Generate text embeddings (1536 dimensions).

**Request**:
```json
{
  "input": "Hello world",
  "model": "text-embedding-3-small"
}
```

**Response**:
```json
{
  "embeddings": [[0.123, -0.456, ...]],
  "model": "text-embedding-3-small",
  "usage": {
    "totalTokens": 2
  },
  "provider": "z.ai"
}
```

---

### `POST /structured`
Generate structured JSON with schema validation.

**Request**:
```json
{
  "messages": [
    { "role": "user", "content": "Extract: John Doe, 30 years old, lives in NYC" }
  ],
  "schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string" },
      "age": { "type": "number" },
      "city": { "type": "string" }
    }
  },
  "model": "llama-3.3-70b-versatile"
}
```

**Response**:
```json
{
  "data": {
    "name": "John Doe",
    "age": 30,
    "city": "NYC"
  }
}
```

---

### `GET /models`
List available models.

**Response**:
```json
{
  "models": [
    { "id": "llama-3.3-70b-versatile", "provider": "groq", "type": "chat" },
    { "id": "mixtral-8x7b-32768", "provider": "groq", "type": "chat" },
    { "id": "text-embedding-3-small", "provider": "z.ai", "type": "embedding" }
  ]
}
```

---

### `GET /health`
Provider health status.

**Response**:
```json
{
  "healthy": true,
  "providers": {
    "groq": "configured",
    "zai": "configured",
    "openrouter": "missing"
  }
}
```

---

## Features

### Multi-Provider Fallback
Automatic failover across providers:
```
Groq → z.ai → OpenRouter
```

### Circuit Breakers
Per-provider circuit breakers prevent cascading failures:
- **Threshold**: 3 failures
- **Timeout**: 30 seconds
- **States**: CLOSED → OPEN → HALF_OPEN

### Rate Limiting
- **Per User**: 100 requests/hour
- **Global**: 10,000 requests/hour
- **Response**: 400 with error message

### Cost Tracking
Automatic cost estimation per request:
- **Groq**: Free tier (currently $0)
- **z.ai**: Pay-as-you-go
- **OpenRouter**: Variable per model

### Monitoring
- Structured logging with user ID, model, tokens
- Provider usage tracking
- Error tracking via Sentry
- Token usage metrics

---

## Configuration

### Environment Variables

```bash
# Required (at least one)
GROQ_API_KEY=gsk_...
ZAI_API_KEY=zai_...
OPENROUTER_API_KEY=sk-or-...

# Optional
SENTRY_DSN=https://...  # Error tracking
```

### Get API Keys

1. **Groq**: https://console.groq.com/keys
   - Free tier: 14,400 requests/day
   - Models: Llama 3.3, Mixtral, Gemma

2. **z.ai**: https://z.ai/api
   - Pay-as-you-go
   - Embeddings + chat

3. **OpenRouter**: https://openrouter.ai/keys
   - Access to GPT-4, Claude, Gemini
   - Pay per model

---

## Usage Examples

### cURL

```bash
# Chat completion
curl -X POST https://***REMOVED***/functions/v1/api-v1-ai/chat \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "model": "llama-3.3-70b-versatile"
  }'

# Embeddings
curl -X POST https://***REMOVED***/functions/v1/api-v1-ai/embeddings \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world"}'

# Structured generation
curl -X POST https://***REMOVED***/functions/v1/api-v1-ai/structured \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Extract: John, 30, NYC"}],
    "schema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "number"},
        "city": {"type": "string"}
      }
    }
  }'
```

### JavaScript/TypeScript

```typescript
const response = await fetch(
  'https://***REMOVED***/functions/v1/api-v1-ai/chat',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Hello!' }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
    }),
  }
);

const data = await response.json();
console.log(data.choices[0].message.content);
```

### Swift (iOS)

```swift
struct ChatRequest: Codable {
    let messages: [Message]
    let model: String
    let temperature: Double
}

struct Message: Codable {
    let role: String
    let content: String
}

let request = ChatRequest(
    messages: [
        Message(role: "user", content: "Hello!")
    ],
    model: "llama-3.3-70b-versatile",
    temperature: 0.7
)

let url = URL(string: "https://***REMOVED***/functions/v1/api-v1-ai/chat")!
var urlRequest = URLRequest(url: url)
urlRequest.httpMethod = "POST"
urlRequest.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
urlRequest.httpBody = try JSONEncoder().encode(request)

let (data, _) = try await URLSession.shared.data(for: urlRequest)
let response = try JSONDecoder().decode(ChatResponse.self, from: data)
```

---

## Available Models

### Groq (Primary)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| llama-3.3-70b-versatile | 128K | ~500 tok/s | General purpose |
| mixtral-8x7b-32768 | 32K | ~600 tok/s | Fast inference |
| gemma2-9b-it | 8K | ~800 tok/s | Simple tasks |

### z.ai (Secondary)

| Model | Context | Best For |
|-------|---------|----------|
| text-embedding-3-small | - | Embeddings (1536d) |
| gpt-4o-mini | 128K | Chat fallback |

### OpenRouter (Fallback)

| Model | Context | Cost |
|-------|---------|------|
| openai/gpt-4-turbo | 128K | $10/$30 per 1M tokens |
| anthropic/claude-3.5-sonnet | 200K | $3/$15 per 1M tokens |
| google/gemini-pro-1.5 | 2M | $1.25/$5 per 1M tokens |

---

## Error Handling

### Error Codes

| Code | Description | Retryable |
|------|-------------|-----------|
| `RATE_LIMITED` | Rate limit exceeded | Yes (after 1 hour) |
| `SERVICE_UNAVAILABLE` | All providers down | Yes |
| `TIMEOUT` | Request timeout | Yes |
| `INVALID_INPUT` | Invalid request | No |
| `QUOTA_EXHAUSTED` | API quota exceeded | No |

### Example Error Response

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Limit: 100 requests/hour",
    "retryable": true,
    "retryAfter": 3600
  }
}
```

---

## Monitoring

### Metrics Tracked

- Total requests per user
- Tokens used per request
- Provider usage distribution
- Error rates per provider
- Average response time
- Cost per request

### Logs

All requests logged with:
```json
{
  "userId": "uuid",
  "model": "llama-3.3-70b-versatile",
  "tokens": 30,
  "provider": "groq",
  "duration_ms": 1234
}
```

---

## Best Practices

### 1. Use Appropriate Models
- **Simple tasks**: gemma2-9b-it (fastest)
- **General purpose**: llama-3.3-70b-versatile
- **Complex reasoning**: gpt-4-turbo (via OpenRouter)

### 2. Optimize Token Usage
- Keep system prompts concise
- Use lower temperature for deterministic output
- Set maxTokens to prevent runaway generation

### 3. Handle Errors Gracefully
- Implement exponential backoff for retryable errors
- Show user-friendly messages
- Log errors for debugging

### 4. Cache Responses
- Cache embeddings for repeated text
- Cache chat responses for common queries
- Use request deduplication

---

## Roadmap

### Phase 1 (Current)
- ✅ Multi-provider fallback
- ✅ Circuit breakers
- ✅ Rate limiting
- ✅ Basic monitoring

### Phase 2 (Next)
- [ ] Streaming support for chat
- [ ] Response caching
- [ ] Request deduplication
- [ ] Token usage dashboard

### Phase 3 (Future)
- [ ] Fine-tuned models
- [ ] Custom embeddings
- [ ] A/B testing framework
- [ ] Cost optimization

---

## Support

**Issues**: https://github.com/Foodshareclub/foodshare-backend/issues  
**Docs**: `/docs/ai/`  
**Status**: https://status.foodshare.club

---

**Last Updated**: 2026-02-06  
**Maintainer**: FoodShare Engineering
