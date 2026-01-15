# BFF Translation Enhancement Investigation

**Date:** January 14, 2026  
**Status:** Investigation Phase  
**Goal:** Add on-the-fly translation of user-generated content (posts, challenges, forum posts)

## Current State

### What We Have
1. **Static UI Translation** ✅
   - BFF endpoint: `GET /bff/translations`
   - ETag caching with 1-hour TTL
   - Missing key reporting: `POST /bff/translations`
   - Coverage analytics: `GET /bff/translations-stats`
   - iOS client with automatic missing key detection

2. **Content Endpoints** ✅
   - `GET /bff/feed` - Food listings
   - `GET /bff/listing` - Single listing details
   - Forum posts (via direct Supabase queries)
   - Challenges (via direct Supabase queries)

### What's Missing
- **No translation of user-generated content**
- Posts, challenges, forum content only shown in original language
- Users must understand the content creator's language

## Translation Options

### 1. Google Cloud Translation API
**Pros:**
- 130+ languages supported
- Neural machine translation (high quality)
- $20 per 1M characters
- Fast response times (< 100ms)
- Batch translation support

**Cons:**
- Requires Google Cloud account
- Cost scales with usage
- Need to manage API keys securely

**Pricing:**
- Basic: $20/1M characters
- Advanced (custom models): $80/1M characters
- Free tier: 500K characters/month

### 2. DeepL API
**Pros:**
- Highest translation quality (especially EU languages)
- 31 languages supported
- Context-aware translations
- Formality control (formal/informal)

**Cons:**
- Fewer languages than Google
- More expensive: €20/1M characters (~$22)
- 128 KiB request size limit

**Pricing:**
- Free: 500K characters/month
- Pro: €5.49/month + €20/1M characters

### 3. OpenAI GPT-4 Translation
**Pros:**
- Context-aware, natural translations
- Can handle slang, idioms, cultural nuances
- Can preserve formatting, emojis
- Multi-language in single request

**Cons:**
- Most expensive option
- Slower (200-500ms)
- Token-based pricing
- Overkill for simple translations

**Pricing:**
- GPT-4: $0.03/1K input tokens, $0.06/1K output tokens
- ~$60-120 per 1M characters (estimated)

### 4. LibreTranslate (Self-Hosted)
**Pros:**
- Open source, self-hosted
- No per-character costs
- Privacy-friendly (data stays on your servers)
- 17 languages

**Cons:**
- Lower quality than commercial options
- Requires infrastructure management
- Slower performance
- Limited language support

## Recommended Approach

### Phase 1: Google Cloud Translation API (Recommended)

**Why Google:**
1. Best balance of cost, quality, and language coverage
2. Fast enough for real-time translation
3. Proven reliability and scale
4. Easy integration with Supabase Edge Functions

**Architecture:**

```typescript
// New BFF endpoint: GET /bff/content/translate
interface TranslateRequest {
  content_type: 'post' | 'challenge' | 'forum_post';
  content_id: string;
  target_locale: string;
  fields?: string[]; // ['title', 'description']
}

interface TranslateResponse {
  original: {
    locale: string;
    title: string;
    description: string;
  };
  translated: {
    locale: string;
    title: string;
    description: string;
  };
  cached: boolean;
  translation_quality: 'high' | 'medium' | 'low';
}
```

### Caching Strategy (Critical for Cost Control)

**Three-Layer Cache:**

1. **Database Cache** (PostgreSQL)
   ```sql
   CREATE TABLE content_translations (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     content_type TEXT NOT NULL,
     content_id TEXT NOT NULL,
     source_locale TEXT NOT NULL,
     target_locale TEXT NOT NULL,
     source_text TEXT NOT NULL,
     translated_text TEXT NOT NULL,
     translation_service TEXT DEFAULT 'google',
     quality_score FLOAT,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
     hit_count INT DEFAULT 0,
     UNIQUE(content_type, content_id, source_locale, target_locale, source_text)
   );
   
   CREATE INDEX idx_translations_lookup 
     ON content_translations(content_type, content_id, target_locale);
   CREATE INDEX idx_translations_expiry 
     ON content_translations(expires_at) WHERE expires_at < NOW();
   ```

2. **Edge Function Memory Cache** (Deno)
   - LRU cache for hot translations
   - 100MB limit (~10K translations)
   - 1-hour TTL

3. **CDN Cache** (Cloudflare/Vercel)
   - Cache-Control headers
   - 1-hour browser cache
   - 24-hour CDN cache

**Cache Hit Rates (Expected):**
- Memory: 60-70% (hot content)
- Database: 25-30% (warm content)
- API call: 5-10% (cold content)

**Cost Projection:**
- 1M posts viewed/month
- 50% need translation
- 70% cache hit rate
- = 150K API calls
- = ~30M characters
- = **$0.60/month** 🎉

### Implementation Plan

#### Step 1: Database Setup
```sql
-- Migration: 20260115_content_translations.sql
CREATE TABLE content_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'challenge', 'forum_post')),
  content_id TEXT NOT NULL,
  field_name TEXT NOT NULL, -- 'title', 'description', 'content'
  source_locale TEXT NOT NULL,
  target_locale TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  translation_service TEXT DEFAULT 'google',
  quality_score FLOAT,
  character_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
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
  -- Try to get from cache
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
    -- Update hit count
    UPDATE content_translations
    SET hit_count = hit_count + 1,
        last_hit_at = NOW()
    WHERE id = v_translation.id;
    
    RETURN QUERY SELECT 
      v_translation.translated_text,
      TRUE as cached,
      v_translation.quality_score;
  ELSE
    -- Return null to signal need for API call
    RETURN QUERY SELECT 
      NULL::TEXT as translated_text,
      FALSE as cached,
      NULL::FLOAT as quality_score;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Cleanup old translations
CREATE OR REPLACE FUNCTION cleanup_expired_translations()
RETURNS void AS $$
BEGIN
  DELETE FROM content_translations
  WHERE expires_at < NOW()
    AND hit_count < 5; -- Keep popular translations longer
END;
$$ LANGUAGE plpgsql;
```

#### Step 2: Edge Function Enhancement

```typescript
// supabase/functions/bff/translation-service.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

interface TranslationConfig {
  apiKey: string;
  projectId: string;
  endpoint: string;
}

class TranslationService {
  private config: TranslationConfig;
  private memoryCache: Map<string, { text: string; timestamp: number }>;
  private readonly CACHE_TTL = 3600000; // 1 hour
  private readonly MAX_CACHE_SIZE = 10000;

  constructor(config: TranslationConfig) {
    this.config = config;
    this.memoryCache = new Map();
  }

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<{ text: string; cached: boolean; quality: number }> {
    // Check memory cache
    const cacheKey = `${sourceLang}:${targetLang}:${text}`;
    const cached = this.memoryCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return { text: cached.text, cached: true, quality: 1.0 };
    }

    // Call Google Cloud Translation API
    const response = await fetch(
      `${this.config.endpoint}/v3/projects/${this.config.projectId}/locations/global:translateText`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [text],
          sourceLanguageCode: sourceLang,
          targetLanguageCode: targetLang,
          mimeType: "text/plain",
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Translation API error: ${response.statusText}`);
    }

    const data = await response.json();
    const translatedText = data.translations[0].translatedText;

    // Update memory cache (with LRU eviction)
    if (this.memoryCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(cacheKey, {
      text: translatedText,
      timestamp: Date.now(),
    });

    return { text: translatedText, cached: false, quality: 0.95 };
  }

  async batchTranslate(
    texts: string[],
    sourceLang: string,
    targetLang: string
  ): Promise<string[]> {
    // Batch API call for efficiency
    const response = await fetch(
      `${this.config.endpoint}/v3/projects/${this.config.projectId}/locations/global:translateText`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: texts,
          sourceLanguageCode: sourceLang,
          targetLanguageCode: targetLang,
          mimeType: "text/plain",
        }),
      }
    );

    const data = await response.json();
    return data.translations.map((t: any) => t.translatedText);
  }
}

// Export singleton
export const translationService = new TranslationService({
  apiKey: Deno.env.get("GOOGLE_TRANSLATE_API_KEY") || "",
  projectId: Deno.env.get("GOOGLE_CLOUD_PROJECT_ID") || "",
  endpoint: "https://translation.googleapis.com",
});
```

#### Step 3: BFF Endpoint Integration

```typescript
// Add to bff/index.ts

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
  if (content_type === "post") {
    const { data } = await supabaseClient
      .from("posts")
      .select("title, description, user_id, profiles!posts_user_id_fkey(locale)")
      .eq("id", content_id)
      .single();
    content = data;
  } else if (content_type === "challenge") {
    const { data } = await supabaseClient
      .from("challenges")
      .select("title, description, user_id, profiles!challenges_user_id_fkey(locale)")
      .eq("id", content_id)
      .single();
    content = data;
  } else if (content_type === "forum_post") {
    const { data } = await supabaseClient
      .from("forum_posts")
      .select("title, content, user_id, profiles!forum_posts_user_id_fkey(locale)")
      .eq("id", content_id)
      .single();
    content = data;
  }

  if (!content) {
    return createErrorResponse("NOT_FOUND", "Content not found", 404);
  }

  const sourceLang = content.profiles?.locale || "en";
  const fieldsToTranslate = fields || ["title", "description"];
  
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

    if (cached && cached.translated_text) {
      translations[field] = {
        text: cached.translated_text,
        cached: true,
        quality: cached.quality_score,
      };
    } else {
      // Call translation API
      const result = await translationService.translate(
        sourceText,
        sourceLang,
        target_locale
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
  });
}

// =====================================================
// BFF-FEED with Auto-Translation
// =====================================================
if (endpoint === "feed" && req.method === "GET") {
  // ... existing feed logic ...
  
  const autoTranslate = url.searchParams.get("translate") === "true";
  const targetLocale = url.searchParams.get("locale") || "en";
  
  if (autoTranslate && feedItems) {
    // Batch translate all titles
    const titlesToTranslate = feedItems
      .filter(item => item.profiles?.locale !== targetLocale)
      .map(item => item.title);
    
    if (titlesToTranslate.length > 0) {
      const translatedTitles = await translationService.batchTranslate(
        titlesToTranslate,
        "auto", // Auto-detect source language
        targetLocale
      );
      
      // Merge translations back
      let translationIndex = 0;
      feedItems = feedItems.map(item => {
        if (item.profiles?.locale !== targetLocale) {
          return {
            ...item,
            title_translated: translatedTitles[translationIndex++],
            translation_available: true,
          };
        }
        return item;
      });
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

#### Step 4: iOS Client Integration

```swift
// FoodShare/Core/Services/TranslationService.swift

extension BFFService {
    /// Translate user-generated content
    func translateContent(
        contentType: String,
        contentId: String,
        targetLocale: String,
        fields: [String] = ["title", "description"]
    ) async throws -> ContentTranslation {
        let endpoint = "\(baseURL)/translate"
        
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(targetLocale, forHTTPHeaderField: "Accept-Language")
        
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
}

struct ContentTranslation: Codable {
    let contentType: String
    let contentId: String
    let sourceLocale: String
    let targetLocale: String
    let translations: [String: TranslatedField]
    
    struct TranslatedField: Codable {
        let text: String
        let cached: Bool
        let quality: Double
    }
}
```

## Cost Analysis

### Scenario: 10K Active Users

**Assumptions:**
- 10K users
- 50 posts viewed per user per day
- 30% of posts need translation
- 70% cache hit rate (database + memory)
- Average post: 100 characters (title + description)

**Calculations:**
```
Daily views: 10K users × 50 posts = 500K views
Need translation: 500K × 30% = 150K views
API calls (30% cache miss): 150K × 30% = 45K calls
Characters: 45K × 100 = 4.5M characters/day
Monthly: 4.5M × 30 = 135M characters

Cost: 135M / 1M × $20 = $2.70/month
```

**With Growth (100K users):**
```
Monthly characters: 1.35B
Cost: 1.35B / 1M × $20 = $27/month
```

### Cost Optimization Strategies

1. **Aggressive Caching**
   - 30-day cache expiry
   - Keep popular translations indefinitely
   - Pre-translate trending content

2. **Smart Translation**
   - Only translate title in feed view
   - Translate full content on detail view
   - Skip translation if < 80% confidence

3. **User Preferences**
   - Let users opt-in to auto-translation
   - Remember language pairs per user
   - Batch translate on scroll

4. **Fallback Strategy**
   - Show original if translation fails
   - Indicate translation quality
   - Allow users to report bad translations

## Security Considerations

1. **API Key Management**
   - Store in Supabase Vault
   - Rotate keys quarterly
   - Monitor usage for anomalies

2. **Rate Limiting**
   - 100 translations/minute per user
   - 10K translations/hour globally
   - Exponential backoff on errors

3. **Content Validation**
   - Sanitize HTML before translation
   - Check for malicious content
   - Limit text length (5K characters)

4. **Privacy**
   - Don't log translated content
   - Anonymize analytics
   - GDPR-compliant caching

## Alternative: Hybrid Approach

**Combine Multiple Services:**

1. **Google Translate** - Primary (fast, cheap)
2. **DeepL** - Fallback for EU languages (quality)
3. **GPT-4** - Special cases (slang, context)

```typescript
async function smartTranslate(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<string> {
  // Use DeepL for EU language pairs
  if (isEULanguagePair(sourceLang, targetLang)) {
    return await deeplTranslate(text, sourceLang, targetLang);
  }
  
  // Use GPT-4 for complex content (detected by keywords)
  if (hasSlangOrIdioms(text)) {
    return await gptTranslate(text, sourceLang, targetLang);
  }
  
  // Default to Google Translate
  return await googleTranslate(text, sourceLang, targetLang);
}
```

## Next Steps

### Immediate (Week 1)
1. ✅ Complete investigation
2. ⏳ Set up Google Cloud Translation API account
3. ⏳ Create database migration for `content_translations`
4. ⏳ Implement basic translation endpoint in BFF

### Short-term (Week 2-3)
1. ⏳ Add memory caching layer
2. ⏳ Integrate with feed endpoint
3. ⏳ Add iOS client support
4. ⏳ Test with sample content

### Medium-term (Month 2)
1. ⏳ Add batch translation for feed
2. ⏳ Implement quality scoring
3. ⏳ Add user preferences
4. ⏳ Monitor costs and optimize

### Long-term (Month 3+)
1. ⏳ Add DeepL for EU languages
2. ⏳ Implement pre-translation for trending content
3. ⏳ Add translation quality feedback
4. ⏳ Explore GPT-4 for complex cases

## Conclusion

**Recommendation: Proceed with Google Cloud Translation API**

**Pros:**
- Low cost ($3-30/month for 10K-100K users)
- High quality translations
- Fast response times
- Easy integration
- Proven scalability

**Risks:**
- API dependency (mitigated by caching)
- Cost scaling (mitigated by aggressive caching)
- Translation quality (mitigated by quality scoring)

**ROI:**
- Dramatically improves UX for international users
- Increases engagement across language barriers
- Enables true global community
- Cost is negligible compared to value

**Decision: ✅ Implement in Phase 1**
