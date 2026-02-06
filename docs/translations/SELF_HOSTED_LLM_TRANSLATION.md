# Self-Hosted LLM Translation Implementation

**Date:** January 14, 2026  
**Status:** Ready to Implement  
**Goal:** Use self-hosted LLM on VPS for on-the-fly content translation

## Why Self-Hosted LLM is Better

### Advantages Over Cloud APIs

1. **Zero Per-Request Cost** 💰
   - No per-character fees
   - Unlimited translations
   - Predictable infrastructure costs only

2. **Complete Control** 🎛️
   - Custom prompts for better quality
   - Fine-tune for food-sharing terminology
   - Adjust temperature/parameters per use case

3. **Privacy** 🔒
   - User content never leaves your infrastructure
   - GDPR-compliant by default
   - No third-party data sharing

4. **Context-Aware** 🧠
   - Can understand food-sharing context
   - Preserve emojis, slang, cultural nuances
   - Better than generic translation APIs

5. **Customization** ⚙️
   - Add food-specific vocabulary
   - Handle measurements (kg/lbs, L/gal)
   - Preserve formatting, links, hashtags

### Cost Comparison

| Solution | Setup Cost | Monthly Cost (100K users) | Quality |
|----------|-----------|---------------------------|---------|
| Google Translate | $0 | $27/month | Good |
| DeepL | $0 | $30/month | Excellent |
| OpenAI GPT-4 | $0 | $60-120/month | Excellent |
| **Self-Hosted LLM** | **VPS already running** | **$0** | **Excellent** |

## Architecture

### VPS LLM Setup (Assumed)

**Likely Stack:**
- Ollama / LM Studio / vLLM
- Model: Llama 3.1 8B / Mistral 7B / Qwen 2.5
- API: OpenAI-compatible endpoint
- Hardware: GPU-accelerated (NVIDIA)

**Typical Endpoint:**
```
POST https://your-vps.example.com/v1/chat/completions
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json

{
  "model": "llama3.1:8b",
  "messages": [
    {"role": "system", "content": "You are a translator..."},
    {"role": "user", "content": "Translate to Spanish: Fresh apples"}
  ],
  "temperature": 0.3,
  "max_tokens": 500
}
```

### Integration Flow

```
┌─────────────┐
│   iOS App   │
└──────┬──────┘
       │ GET /bff/feed?translate=true&locale=es
       ▼
┌─────────────────────────────────────────┐
│         Supabase Edge Function          │
│              (BFF Layer)                │
├─────────────────────────────────────────┤
│  1. Fetch posts from database           │
│  2. Check translation cache              │
│  3. If miss → Call VPS LLM               │
│  4. Store in cache                       │
│  5. Return translated content            │
└──────┬──────────────────────────────────┘
       │
       ├─→ PostgreSQL (cache lookup)
       │
       └─→ VPS LLM API (translation)
           https://your-vps.example.com/v1/chat/completions
```

## Implementation

### Step 1: Database Schema (Same as Before)

```sql
-- Migration: 20260115_content_translations.sql
CREATE TABLE content_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'challenge', 'forum_post')),
  content_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  translation_service TEXT DEFAULT 'self-hosted-llm',
  quality_score FLOAT DEFAULT 0.95,
  character_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days', -- Longer cache for free service
  hit_count INT DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  UNIQUE(content_type, content_id, field_name, source_locale, target_locale, source_text)
);

CREATE INDEX idx_translations_lookup 
  ON content_translations(content_type, content_id, field_name, target_locale);
CREATE INDEX idx_translations_expiry 
  ON content_translations(expires_at) WHERE expires_at < NOW();
CREATE INDEX idx_translations_popular
  ON content_translations(hit_count DESC) WHERE hit_count > 10;

-- Function to get or create translation
CREATE OR REPLACE FUNCTION get_or_translate(
  p_content_type TEXT,
  p_content_id TEXT,
  p_field_name TEXT,
  p_source_locale TEXT,
  p_target_locale TEXT,
  p_source_text TEXT
) RETURNS TABLE (
  translated_text TEXT,
  cached BOOLEAN,
  quality_score FLOAT
) AS $$
DECLARE
  v_translation RECORD;
BEGIN
  SELECT * INTO v_translation
  FROM content_translations
  WHERE content_type = p_content_type
    AND content_id = p_content_id
    AND field_name = p_field_name
    AND source_locale = p_source_locale
    AND target_locale = p_target_locale
    AND source_text = p_source_text
    AND expires_at > NOW();
  
  IF FOUND THEN
    UPDATE content_translations
    SET hit_count = hit_count + 1,
        last_hit_at = NOW()
    WHERE id = v_translation.id;
    
    RETURN QUERY SELECT 
      v_translation.translated_text,
      TRUE as cached,
      v_translation.quality_score;
  ELSE
    RETURN QUERY SELECT 
      NULL::TEXT as translated_text,
      FALSE as cached,
      NULL::FLOAT as quality_score;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

### Step 2: LLM Translation Service

```typescript
// supabase/functions/bff/llm-translation-service.ts

interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

interface TranslationResult {
  text: string;
  cached: boolean;
  quality: number;
  tokensUsed?: number;
}

class LLMTranslationService {
  private config: LLMConfig;
  private memoryCache: Map<string, { text: string; timestamp: number }>;
  private readonly CACHE_TTL = 3600000; // 1 hour
  private readonly MAX_CACHE_SIZE = 10000;

  constructor(config: LLMConfig) {
    this.config = config;
    this.memoryCache = new Map();
  }

  /**
   * Translate text using self-hosted LLM
   */
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    context?: string
  ): Promise<TranslationResult> {
    // Check memory cache first
    const cacheKey = `${sourceLang}:${targetLang}:${text}`;
    const cached = this.memoryCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return { text: cached.text, cached: true, quality: 1.0 };
    }

    // Build system prompt for translation
    const systemPrompt = this.buildSystemPrompt(sourceLang, targetLang, context);
    
    // Call self-hosted LLM
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const translatedText = data.choices[0].message.content.trim();
    const tokensUsed = data.usage?.total_tokens || 0;

    // Update memory cache (with LRU eviction)
    if (this.memoryCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(cacheKey, {
      text: translatedText,
      timestamp: Date.now(),
    });

    return {
      text: translatedText,
      cached: false,
      quality: 0.95,
      tokensUsed,
    };
  }

  /**
   * Build context-aware system prompt
   */
  private buildSystemPrompt(
    sourceLang: string,
    targetLang: string,
    context?: string
  ): string {
    const basePrompt = `You are a professional translator specializing in food-sharing and community platforms.

TASK: Translate the following text from ${this.getLanguageName(sourceLang)} to ${this.getLanguageName(targetLang)}.

RULES:
1. Preserve the original meaning and tone
2. Keep emojis, hashtags, and formatting exactly as they are
3. Preserve measurements (kg, lbs, L, etc.) - convert if culturally appropriate
4. Keep proper nouns (names, places) unchanged
5. Maintain casual/friendly tone typical of food-sharing communities
6. If text contains food items, use culturally appropriate terms
7. Return ONLY the translated text, no explanations or notes

${context ? `CONTEXT: This is a ${context}` : ""}

Translate naturally and idiomatically. Output only the translation.`;

    return basePrompt;
  }

  /**
   * Batch translate multiple texts
   */
  async batchTranslate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    context?: string
  ): Promise<string[]> {
    // For self-hosted LLM, we can batch in a single prompt
    const systemPrompt = this.buildSystemPrompt(sourceLang, targetLang, context);
    
    const batchPrompt = texts
      .map((text, i) => `[${i + 1}] ${text}`)
      .join("\n");

    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Translate each numbered item:\n\n${batchPrompt}\n\nReturn translations in the same numbered format.`,
          },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens * texts.length,
      }),
    });

    const data = await response.json();
    const translatedBatch = data.choices[0].message.content.trim();

    // Parse numbered responses
    const translations = translatedBatch
      .split("\n")
      .filter((line: string) => /^\[\d+\]/.test(line))
      .map((line: string) => line.replace(/^\[\d+\]\s*/, "").trim());

    return translations;
  }

  /**
   * Get language name from code
   */
  private getLanguageName(code: string): string {
    const languages: Record<string, string> = {
      en: "English",
      es: "Spanish",
      fr: "French",
      de: "German",
      it: "Italian",
      pt: "Portuguese",
      ru: "Russian",
      zh: "Chinese",
      ja: "Japanese",
      ko: "Korean",
      ar: "Arabic",
      hi: "Hindi",
      nl: "Dutch",
      pl: "Polish",
      tr: "Turkish",
      vi: "Vietnamese",
      th: "Thai",
      id: "Indonesian",
      cs: "Czech",
      uk: "Ukrainian",
      sv: "Swedish",
    };
    return languages[code] || code.toUpperCase();
  }

  /**
   * Clear memory cache
   */
  clearCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.memoryCache.size,
      maxSize: this.MAX_CACHE_SIZE,
    };
  }
}

// Export singleton with configuration from Vault
export const llmTranslationService = new LLMTranslationService({
  endpoint: Deno.env.get("LLM_TRANSLATION_ENDPOINT") || "",
  apiKey: Deno.env.get("LLM_TRANSLATION_API_KEY") || "",
  model: Deno.env.get("LLM_TRANSLATION_MODEL") || "llama3.1:8b",
  maxTokens: 500,
  temperature: 0.3, // Low temperature for consistent translations
});
```

### Step 3: BFF Integration

```typescript
// Add to supabase/functions/bff/index.ts

import { llmTranslationService } from "./llm-translation-service.ts";

// =====================================================
// BFF-TRANSLATE: Translate user content on-the-fly
// =====================================================
if (endpoint === "translate" && req.method === "POST") {
  const user = await getUser();
  const body = await req.json();
  const { content_type, content_id, target_locale, fields } = body;

  if (!content_type || !content_id || !target_locale) {
    return createErrorResponse("INVALID_REQUEST", "Missing required fields", 400);
  }

  // Get original content
  let content: any;
  let contentContext: string;
  
  if (content_type === "post") {
    const { data } = await supabaseClient
      .from("posts")
      .select("post_name, post_description, profile_id, profiles!posts_profile_id_fkey(preferred_locale)")
      .eq("id", content_id)
      .single();
    content = data;
    contentContext = "food listing post";
  } else if (content_type === "challenge") {
    const { data } = await supabaseClient
      .from("challenges")
      .select("title, description, profile_id, profiles!challenges_profile_id_fkey(preferred_locale)")
      .eq("id", content_id)
      .single();
    content = data;
    contentContext = "community challenge";
  } else if (content_type === "forum_post") {
    const { data } = await supabaseClient
      .from("forum_posts")
      .select("title, content, profile_id, profiles!forum_posts_profile_id_fkey(preferred_locale)")
      .eq("id", content_id)
      .single();
    content = data;
    contentContext = "forum discussion post";
  }

  if (!content) {
    return createErrorResponse("NOT_FOUND", "Content not found", 404);
  }

  const sourceLang = content.profiles?.preferred_locale || "en";
  const fieldsToTranslate = fields || ["post_name", "post_description"];
  
  const translations: Record<string, any> = {};
  
  for (const field of fieldsToTranslate) {
    const sourceText = content[field];
    if (!sourceText) continue;

    // Check database cache first
    const { data: cached } = await supabaseClient.rpc("get_or_translate", {
      p_content_type: content_type,
      p_content_id: content_id,
      p_field_name: field,
      p_source_locale: sourceLang,
      p_target_locale: target_locale,
      p_source_text: sourceText,
    });

    if (cached && cached[0]?.translated_text) {
      translations[field] = {
        text: cached[0].translated_text,
        cached: true,
        quality: cached[0].quality_score,
      };
    } else {
      // Call LLM translation service
      const result = await llmTranslationService.translate(
        sourceText,
        sourceLang,
        target_locale,
        contentContext
      );

      // Store in database
      await supabaseClient.from("content_translations").insert({
        content_type,
        content_id,
        field_name: field,
        source_locale: sourceLang,
        target_locale: target_locale,
        source_text: sourceText,
        translated_text: result.text,
        translation_service: "self-hosted-llm",
        quality_score: result.quality,
        character_count: sourceText.length,
      });

      translations[field] = result;
    }
  }

  return createResponse({
    content_type,
    content_id,
    source_locale: sourceLang,
    target_locale,
    translations,
    service: "self-hosted-llm",
  });
}

// =====================================================
// BFF-FEED with Auto-Translation
// =====================================================
if (endpoint === "feed" && req.method === "GET") {
  // ... existing feed logic ...
  
  const autoTranslate = url.searchParams.get("translate") === "true";
  const targetLocale = url.searchParams.get("locale") || "en";
  
  if (autoTranslate && feedItems && feedItems.length > 0) {
    // Batch translate all titles that need translation
    const itemsNeedingTranslation = feedItems.filter(
      item => item.profiles?.preferred_locale !== targetLocale
    );
    
    if (itemsNeedingTranslation.length > 0) {
      const titlesToTranslate = itemsNeedingTranslation.map(item => item.post_name);
      
      try {
        const translatedTitles = await llmTranslationService.batchTranslate(
          titlesToTranslate,
          "auto",
          targetLocale,
          "food listing post"
        );
        
        // Merge translations back
        let translationIndex = 0;
        feedItems = feedItems.map(item => {
          if (item.profiles?.preferred_locale !== targetLocale) {
            return {
              ...item,
              post_name_translated: translatedTitles[translationIndex++],
              translation_available: true,
            };
          }
          return item;
        });
      } catch (error) {
        console.error("Translation error:", error);
        // Continue without translations on error
      }
    }
  }
  
  return createResponse({
    listings: feedItems,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    translations_enabled: autoTranslate,
  });
}
```

### Step 4: Supabase Vault Configuration

```sql
-- Store LLM endpoint and API key in Vault
SELECT vault.create_secret(
  'https://your-vps.example.com/v1/chat/completions',
  'LLM_TRANSLATION_ENDPOINT',
  'Self-hosted LLM translation endpoint'
);

SELECT vault.create_secret(
  'your-llm-api-key-here',
  'LLM_TRANSLATION_API_KEY',
  'Self-hosted LLM API key'
);

SELECT vault.create_secret(
  'llama3.1:8b',
  'LLM_TRANSLATION_MODEL',
  'LLM model name for translation'
);
```

### Step 5: iOS Client Integration

```swift
// FoodShare/Core/Services/BFFService.swift

extension BFFService {
    /// Translate user-generated content using self-hosted LLM
    func translateContent(
        contentType: String,
        contentId: String,
        targetLocale: String,
        fields: [String] = ["post_name", "post_description"]
    ) async throws -> ContentTranslation {
        let endpoint = "\(baseURL)/translate"
        
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(targetLocale, forHTTPHeaderField: "Accept-Language")
        request.setValue("ios", forHTTPHeaderField: "x-platform")
        
        let body: [String: Any] = [
            "content_type": contentType,
            "content_id": contentId,
            "target_locale": targetLocale,
            "fields": fields
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(BFFResponse<ContentTranslation>.self, from: data)
        
        guard response.success, let translation = response.data else {
            throw BFFError.translationFailed
        }
        
        return translation
    }
    
    /// Fetch feed with auto-translation
    func fetchFeedWithTranslation(
        locale: String,
        category: String? = nil,
        lat: Double? = nil,
        lng: Double? = nil,
        radius: Double = 25.0,
        limit: Int = 20,
        cursor: String? = nil
    ) async throws -> FeedResponse {
        var components = URLComponents(string: "\(baseURL)/feed")!
        components.queryItems = [
            URLQueryItem(name: "translate", value: "true"),
            URLQueryItem(name: "locale", value: locale),
            URLQueryItem(name: "limit", value: String(limit))
        ]
        
        if let category { components.queryItems?.append(URLQueryItem(name: "category", value: category)) }
        if let lat { components.queryItems?.append(URLQueryItem(name: "lat", value: String(lat))) }
        if let lng { components.queryItems?.append(URLQueryItem(name: "lng", value: String(lng))) }
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        
        var request = URLRequest(url: components.url!)
        request.setValue("ios", forHTTPHeaderField: "x-platform")
        
        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(BFFResponse<FeedResponse>.self, from: data)
        
        guard response.success, let feed = response.data else {
            throw BFFError.fetchFailed
        }
        
        return feed
    }
}

struct ContentTranslation: Codable {
    let contentType: String
    let contentId: String
    let sourceLocale: String
    let targetLocale: String
    let translations: [String: TranslatedField]
    let service: String
    
    struct TranslatedField: Codable {
        let text: String
        let cached: Bool
        let quality: Double
        let tokensUsed: Int?
    }
}

struct FeedResponse: Codable {
    let listings: [FeedListing]
    let nextCursor: String?
    let hasMore: Bool
    let translationsEnabled: Bool
}

struct FeedListing: Codable {
    let id: String
    let postName: String
    let postNameTranslated: String?
    let postDescription: String?
    let translationAvailable: Bool
    // ... other fields
}
```

## Configuration Checklist

### VPS LLM Requirements

Please provide the following information:

- [ ] **Endpoint URL**: `https://your-vps.example.com/v1/chat/completions`
- [ ] **API Key**: For authentication
- [ ] **Model Name**: e.g., `llama3.1:8b`, `mistral:7b`, `qwen2.5:7b`
- [ ] **Max Tokens**: Recommended 500-1000 for translations
- [ ] **Rate Limits**: Requests per minute/hour
- [ ] **Timeout**: Expected response time (should be < 5 seconds)

### Recommended Models for Translation

| Model | Size | Quality | Speed | Best For |
|-------|------|---------|-------|----------|
| Llama 3.1 8B | 8B | Excellent | Fast | General translation |
| Mistral 7B | 7B | Very Good | Very Fast | Quick translations |
| Qwen 2.5 7B | 7B | Excellent | Fast | Multilingual (esp. Asian) |
| Llama 3.1 70B | 70B | Outstanding | Slower | Complex/nuanced text |

**Recommendation:** Start with **Llama 3.1 8B** - best balance of quality and speed.

## Testing Plan

### Phase 1: Basic Translation
```bash
# Test single translation
curl -X POST https://***REMOVED***/functions/v1/bff/translate \
  -H "Content-Type: application/json" \
  -d '{
    "content_type": "post",
    "content_id": "123",
    "target_locale": "es",
    "fields": ["post_name"]
  }'
```

### Phase 2: Feed Translation
```bash
# Test feed with auto-translation
curl "https://***REMOVED***/functions/v1/bff/feed?translate=true&locale=fr&limit=5"
```

### Phase 3: Cache Performance
- Monitor cache hit rates
- Measure response times
- Track LLM token usage

## Monitoring & Optimization

### Metrics to Track

1. **Cache Hit Rate**
   - Target: >80% after warm-up
   - Monitor: Database queries vs LLM calls

2. **Response Time**
   - Target: <2 seconds for cached
   - Target: <5 seconds for LLM call

3. **Translation Quality**
   - User feedback mechanism
   - A/B test with sample translations

4. **LLM Usage**
   - Tokens per translation
   - Requests per hour
   - Error rate

### Optimization Strategies

1. **Aggressive Caching**
   - 90-day cache expiry (vs 30 days for paid APIs)
   - Never expire popular translations
   - Pre-translate trending content

2. **Smart Batching**
   - Batch feed translations in single LLM call
   - Reduces latency and token usage

3. **Fallback Strategy**
   - Show original text if LLM times out
   - Retry failed translations in background
   - Queue translations for offline processing

## Next Steps

1. **Provide VPS Details** ⏳
   - Endpoint URL
   - API key
   - Model name

2. **Deploy Database Migration** ⏳
   - Create `content_translations` table
   - Add RPC functions

3. **Deploy BFF Updates** ⏳
   - Add LLM translation service
   - Update feed endpoint
   - Add translate endpoint

4. **Test & Iterate** ⏳
   - Test with sample content
   - Measure performance
   - Optimize prompts

5. **iOS Integration** ⏳
   - Update BFF service
   - Add translation UI
   - Test user experience

## Estimated Timeline

- **Week 1**: Setup + Basic Translation (2-3 days)
- **Week 2**: Feed Integration + Testing (3-4 days)
- **Week 3**: iOS Client + Polish (2-3 days)

**Total: 2-3 weeks to production**

## Questions?

Ready to proceed! Just need:
1. VPS LLM endpoint URL
2. API key
3. Model name
4. Any rate limits or constraints

Then we can start implementation! 🚀
