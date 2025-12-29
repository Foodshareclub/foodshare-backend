# Localization Edge Function

High-performance translation delivery for cross-platform FoodShare apps (Web, iOS, Android, Desktop).

## Features

- ✅ **Multi-level caching**: Edge → Memory → Database
- ✅ **Compression**: Automatic gzip compression
- ✅ **ETag support**: Conditional requests (304 Not Modified)
- ✅ **Platform-specific**: Optimized for web, iOS, Android, desktop
- ✅ **Rate limiting**: 1000 requests/hour per IP
- ✅ **Analytics**: Request tracking and performance monitoring
- ✅ **Fallback**: Automatic fallback to English
- ✅ **Error logging**: Comprehensive error tracking

## Supported Locales

- **Current**: `en`, `cs`, `de`, `es`, `fr`, `pt`, `ru`, `uk`
- **New**: `zh`, `hi`, `ar`, `it`, `pl`, `nl`, `ja`, `ko`, `tr`

## API

### Endpoint

```
GET https://[project-ref].supabase.co/functions/v1/localization
```

### Query Parameters

| Parameter    | Type    | Required | Default | Description                                           |
| ------------ | ------- | -------- | ------- | ----------------------------------------------------- |
| `locale`     | string  | No       | `en`    | Locale code (e.g., `en`, `cs`, `zh`)                  |
| `platform`   | string  | No       | `web`   | Platform: `web`, `ios`, `android`, `desktop`, `other` |
| `version`    | string  | No       | -       | Client version for cache busting                      |
| `compressed` | boolean | No       | `false` | Request compressed response                           |

### Headers

| Header            | Description                   |
| ----------------- | ----------------------------- |
| `If-None-Match`   | ETag for conditional requests |
| `Accept-Encoding` | Supported encodings (gzip)    |

### Response

```typescript
{
  locale: string;           // Actual locale returned
  messages: {               // Translation messages
    [key: string]: string;
  };
  version: string;          // Translation version
  platform: string;         // Platform identifier
  cached: boolean;          // Whether served from cache
  compressed: boolean;      // Whether response is compressed
  etag: string;            // ETag for caching
}
```

### Response Headers

| Header             | Description                             |
| ------------------ | --------------------------------------- |
| `ETag`             | Entity tag for caching                  |
| `Cache-Control`    | Cache directives (public, max-age=3600) |
| `Content-Encoding` | Compression type (gzip)                 |
| `X-Cache`          | Cache status: `HIT` or `MISS`           |
| `X-Fallback`       | Present if fallback locale used         |

### Status Codes

| Code  | Description               |
| ----- | ------------------------- |
| `200` | Success                   |
| `304` | Not Modified (ETag match) |
| `404` | Translation not found     |
| `429` | Rate limit exceeded       |
| `500` | Internal server error     |

## Usage Examples

### Web (JavaScript/TypeScript)

```typescript
async function loadTranslations(locale: string) {
  const response = await fetch(
    `https://[project-ref].supabase.co/functions/v1/localization?locale=${locale}&platform=web`,
    {
      headers: {
        "If-None-Match": localStorage.getItem(`etag-${locale}`) || "",
      },
    }
  );

  if (response.status === 304) {
    // Use cached translations
    return JSON.parse(localStorage.getItem(`translations-${locale}`)!);
  }

  if (response.ok) {
    const data = await response.json();

    // Cache for next time
    localStorage.setItem(`translations-${locale}`, JSON.stringify(data));
    localStorage.setItem(`etag-${locale}`, data.etag);

    return data;
  }

  throw new Error("Failed to load translations");
}
```

### iOS (Swift)

```swift
func loadTranslations(locale: String) async throws -> TranslationResponse {
    let url = URL(string: "https://[project-ref].supabase.co/functions/v1/localization?locale=\(locale)&platform=ios")!

    var request = URLRequest(url: url)

    // Add ETag if cached
    if let etag = UserDefaults.standard.string(forKey: "etag-\(locale)") {
        request.setValue(etag, forHTTPHeaderField: "If-None-Match")
    }

    let (data, response) = try await URLSession.shared.data(for: request)

    guard let httpResponse = response as? HTTPURLResponse else {
        throw TranslationError.invalidResponse
    }

    if httpResponse.statusCode == 304 {
        // Use cached translations
        guard let cached = UserDefaults.standard.data(forKey: "translations-\(locale)") else {
            throw TranslationError.cacheNotFound
        }
        return try JSONDecoder().decode(TranslationResponse.self, from: cached)
    }

    if httpResponse.statusCode == 200 {
        let translations = try JSONDecoder().decode(TranslationResponse.self, from: data)

        // Cache for next time
        UserDefaults.standard.set(data, forKey: "translations-\(locale)")
        UserDefaults.standard.set(translations.etag, forKey: "etag-\(locale)")

        return translations
    }

    throw TranslationError.requestFailed(httpResponse.statusCode)
}
```

### Android (Kotlin)

```kotlin
suspend fun loadTranslations(locale: String): TranslationResponse {
    val url = "https://[project-ref].supabase.co/functions/v1/localization?locale=$locale&platform=android"

    val request = Request.Builder()
        .url(url)
        .apply {
            // Add ETag if cached
            sharedPreferences.getString("etag-$locale", null)?.let {
                addHeader("If-None-Match", it)
            }
        }
        .build()

    val response = client.newCall(request).execute()

    return when (response.code) {
        304 -> {
            // Use cached translations
            val cached = sharedPreferences.getString("translations-$locale", null)
                ?: throw Exception("Cache not found")
            gson.fromJson(cached, TranslationResponse::class.java)
        }
        200 -> {
            val body = response.body?.string() ?: throw Exception("Empty response")
            val translations = gson.fromJson(body, TranslationResponse::class.java)

            // Cache for next time
            sharedPreferences.edit()
                .putString("translations-$locale", body)
                .putString("etag-$locale", translations.etag)
                .apply()

            translations
        }
        else -> throw Exception("Request failed: ${response.code}")
    }
}
```

## Performance

### Caching Strategy

1. **Edge Cache** (Deno Deploy): Automatic CDN caching
2. **Memory Cache**: In-function cache (1 hour TTL, max 100 entries)
3. **Database**: Supabase PostgreSQL with indexed queries
4. **Client Cache**: ETag-based conditional requests

### Benchmarks

- **Cache Hit**: ~5-10ms
- **Cache Miss**: ~50-100ms
- **Compression**: ~60-70% size reduction
- **Rate Limit**: 1000 req/hour per IP

## Database Schema

The function uses these tables:

### `translations`

```sql
CREATE TABLE translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale VARCHAR UNIQUE NOT NULL,
  messages JSONB NOT NULL DEFAULT '{}',
  version VARCHAR NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `translation_analytics`

```sql
CREATE TABLE translation_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale VARCHAR NOT NULL,
  platform VARCHAR NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  device_id VARCHAR,
  response_time_ms INTEGER,
  status_code INTEGER,
  cached BOOLEAN DEFAULT false,
  fallback BOOLEAN DEFAULT false,
  user_agent TEXT,
  ip_address INET,
  timestamp TIMESTAMPTZ DEFAULT now()
);
```

### `translation_errors`

```sql
CREATE TABLE translation_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale VARCHAR NOT NULL,
  platform VARCHAR NOT NULL,
  error_code VARCHAR,
  error_message TEXT,
  user_id UUID REFERENCES auth.users(id),
  timestamp TIMESTAMPTZ DEFAULT now()
);
```

### `rate_limits`

```sql
CREATE TABLE rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier VARCHAR UNIQUE NOT NULL,
  request_count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT now()
);
```

## Deployment

```bash
# Deploy function
supabase functions deploy localization

# Test locally
supabase functions serve localization

# View logs
supabase functions logs localization
```

## Environment Variables

Required:

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key

## Monitoring

### Analytics Queries

```sql
-- Request volume by locale
SELECT
  locale,
  COUNT(*) as requests,
  AVG(response_time_ms) as avg_response_time,
  SUM(CASE WHEN cached THEN 1 ELSE 0 END)::FLOAT / COUNT(*) * 100 as cache_hit_rate
FROM translation_analytics
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY locale
ORDER BY requests DESC;

-- Error rate by locale
SELECT
  locale,
  COUNT(*) as errors,
  error_code,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM translation_analytics WHERE locale = te.locale) as error_rate
FROM translation_errors te
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY locale, error_code
ORDER BY errors DESC;

-- Platform distribution
SELECT
  platform,
  COUNT(*) as requests,
  AVG(response_time_ms) as avg_response_time
FROM translation_analytics
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY platform;
```

## Best Practices

1. **Always use ETags**: Implement client-side ETag caching
2. **Handle 304 responses**: Use cached data when server returns 304
3. **Implement fallback**: Always have English translations as fallback
4. **Monitor rate limits**: Track 429 responses and implement backoff
5. **Compress responses**: Request compressed data for mobile apps
6. **Cache aggressively**: Cache translations locally for offline support

## Troubleshooting

### High cache miss rate

- Check if ETags are being sent correctly
- Verify cache TTL settings
- Monitor memory cache size

### Rate limit errors

- Implement exponential backoff
- Cache translations locally
- Use batch requests if possible

### Slow response times

- Check database indexes
- Monitor Supabase performance
- Verify network latency

## Future Enhancements

- [ ] Upstash Redis for distributed caching
- [ ] Brotli compression support
- [ ] Delta updates (only changed translations)
- [ ] Streaming responses for large translations
- [ ] WebSocket support for real-time updates
- [ ] CDN integration (Cloudflare, Fastly)
- [ ] A/B testing support
- [ ] Translation versioning
- [ ] Automatic fallback chain (e.g., zh → en)
