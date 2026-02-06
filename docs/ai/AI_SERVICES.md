# AI Services Documentation

## Overview

FoodShare's AI infrastructure provides production-grade AI capabilities through a unified API with intelligent multi-provider fallback.

---

## API v1 - Unified AI Service

**Endpoint**: `/api-v1-ai`  
**Status**: ✅ Production Ready  
**Version**: 1.0.0

### Features

- **Multi-Provider Fallback**: Groq → z.ai → OpenRouter
- **Circuit Breakers**: Automatic failover on provider failures
- **Rate Limiting**: 100 requests/hour per user
- **Cost Tracking**: Automatic cost estimation
- **Monitoring**: Comprehensive logging and metrics

### Capabilities

1. **Chat Completions** - Conversational AI with streaming
2. **Embeddings** - Text embeddings (1536 dimensions)
3. **Structured Generation** - JSON output with schema validation

### Quick Start

```bash
# Chat completion
curl -X POST https://***REMOVED***/functions/v1/api-v1-ai/chat \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "model": "llama-3.3-70b-versatile"
  }'
```

**Full Documentation**: [api-v1-ai/README.md](../../functions/api-v1-ai/README.md)

---

## Providers

### Groq (Primary)

**Speed**: ~500 tokens/second  
**Cost**: Free tier (14,400 requests/day)  
**Models**:
- llama-3.3-70b-versatile (128K context)
- mixtral-8x7b-32768 (32K context)
- gemma2-9b-it (8K context)

**Best For**: Fast inference, general-purpose tasks

### z.ai (Secondary)

**Speed**: ~200 tokens/second  
**Cost**: Pay-as-you-go  
**Models**:
- text-embedding-3-small (embeddings)
- gpt-4o-mini (chat)

**Best For**: Embeddings, fallback chat

### OpenRouter (Fallback)

**Speed**: Variable  
**Cost**: Variable per model  
**Models**: GPT-4, Claude, Gemini, and 100+ more

**Best For**: Access to latest models, complex reasoning

---

## Architecture

```
Client Request
    ↓
Rate Limiter (100/hour per user)
    ↓
Circuit Breaker
    ↓
Provider Selection (Groq → z.ai → OpenRouter)
    ↓
Response + Metrics Logging
    ↓
Client Response
```

### Circuit Breaker States

- **CLOSED**: Normal operation
- **OPEN**: Provider failed (30s timeout)
- **HALF_OPEN**: Testing recovery

---

## Use Cases

### 1. Food Chat Assistant
```typescript
const response = await fetch('/api-v1-ai/chat', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}` },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a food sharing assistant' },
      { role: 'user', content: 'What can I make with tomatoes and pasta?' }
    ],
    model: 'llama-3.3-70b-versatile'
  })
});
```

### 2. Semantic Search
```typescript
// Generate embeddings for search
const response = await fetch('/api-v1-ai/embeddings', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}` },
  body: JSON.stringify({
    input: 'organic vegetables near me'
  })
});

const embedding = response.embeddings[0];
// Use embedding for vector search in database
```

### 3. Content Moderation
```typescript
const response = await fetch('/api-v1-ai/structured', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${jwt}` },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: `Analyze this listing: "${listingText}"` }
    ],
    schema: {
      type: 'object',
      properties: {
        isSafe: { type: 'boolean' },
        category: { type: 'string' },
        confidence: { type: 'number' }
      }
    }
  })
});
```

---

## Configuration

### Environment Variables

```bash
# At least one provider required
GROQ_API_KEY=gsk_...
ZAI_API_KEY=zai_...
OPENROUTER_API_KEY=sk-or-...

# Optional
SENTRY_DSN=https://...
```

### Get API Keys

- **Groq**: https://console.groq.com/keys
- **z.ai**: https://z.ai/api
- **OpenRouter**: https://openrouter.ai/keys

---

## Monitoring

### Metrics Tracked

- Requests per user
- Tokens used per request
- Provider usage distribution
- Error rates
- Response times
- Estimated costs

### Logs

All requests logged with structured data:
```json
{
  "userId": "uuid",
  "model": "llama-3.3-70b-versatile",
  "tokens": 30,
  "provider": "groq",
  "duration_ms": 1234,
  "cost": 0
}
```

---

## Rate Limits

| Limit | Value |
|-------|-------|
| Per User | 100 requests/hour |
| Global | 10,000 requests/hour |
| Max Tokens | 32,000 per request |

**Exceeded**: Returns 400 with retry-after header

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `RATE_LIMITED` | Too many requests | Wait 1 hour or upgrade |
| `SERVICE_UNAVAILABLE` | All providers down | Retry with backoff |
| `INVALID_INPUT` | Bad request format | Check schema |
| `TIMEOUT` | Request too slow | Reduce maxTokens |

### Retry Strategy

```typescript
async function chatWithRetry(messages: Message[], maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch('/api-v1-ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages })
      });
    } catch (error) {
      if (error.code === 'RATE_LIMITED') throw error;
      if (i === maxRetries - 1) throw error;
      await sleep(Math.pow(2, i) * 1000); // Exponential backoff
    }
  }
}
```

---

## Best Practices

### 1. Choose the Right Model

- **Fast responses**: gemma2-9b-it
- **General purpose**: llama-3.3-70b-versatile
- **Complex reasoning**: gpt-4-turbo (via OpenRouter)

### 2. Optimize Prompts

```typescript
// ❌ Bad: Verbose system prompt
{ role: 'system', content: 'You are a very helpful assistant...' }

// ✅ Good: Concise and specific
{ role: 'system', content: 'Food sharing assistant. Be brief.' }
```

### 3. Set Token Limits

```typescript
// ✅ Always set maxTokens to prevent runaway generation
{
  messages: [...],
  maxTokens: 500  // Reasonable limit
}
```

### 4. Cache Responses

```typescript
// Cache embeddings for repeated text
const cache = new Map<string, number[]>();

async function getEmbedding(text: string) {
  if (cache.has(text)) return cache.get(text);
  
  const response = await fetch('/api-v1-ai/embeddings', {
    body: JSON.stringify({ input: text })
  });
  
  cache.set(text, response.embeddings[0]);
  return response.embeddings[0];
}
```

---

## Roadmap

### Current (v1.0)
- ✅ Multi-provider fallback
- ✅ Circuit breakers
- ✅ Rate limiting
- ✅ Cost tracking

### Next (v1.1)
- [ ] Streaming support
- [ ] Response caching
- [ ] Request deduplication
- [ ] Usage dashboard

### Future (v2.0)
- [ ] Fine-tuned models
- [ ] Custom embeddings
- [ ] A/B testing
- [ ] Cost optimization

---

## Related Documentation

- [API Reference](../../functions/api-v1-ai/README.md)
- [Test Script](../../functions/api-v1-ai/test.sh)
- [Image System](./IMAGE_SYSTEM_REFACTORING.md)

---

**Last Updated**: 2026-02-06  
**Status**: Production Ready ✅
