/**
 * Self-Hosted LLM Translation Service
 * Uses dedicated translation service at ollama.foodshare.club/api/translate
 * Protected by Cloudflare Access
 */

interface LLMConfig {
  endpoint: string;
  apiKey: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
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
   * Translate text using dedicated translation service
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

    try {
      // Call dedicated translation service
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          "CF-Access-Client-Id": this.config.cfAccessClientId,
          "CF-Access-Client-Secret": this.config.cfAccessClientSecret,
        },
        body: JSON.stringify({
          text: text,
          targetLanguage: targetLang,
          sourceLanguage: sourceLang,
          context: context || "food-sharing platform",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Translation API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const translatedText = data.translatedText || data.text || text;

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
        tokensUsed: data.tokensUsed,
      };
    } catch (error) {
      console.error("Translation service error:", error);
      // Fallback: return original text
      return {
        text: text,
        cached: false,
        quality: 0.0,
      };
    }
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
    // Translate each text individually (translation service doesn't support batch yet)
    const translations: string[] = [];
    
    for (const text of texts) {
      try {
        const result = await this.translate(text, sourceLang, targetLang, context);
        translations.push(result.text);
      } catch (error) {
        console.error("Batch translation error for text:", text, error);
        translations.push(text); // Fallback to original
      }
    }
    
    return translations;
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

// Export singleton with configuration
export const llmTranslationService = new LLMTranslationService({
  endpoint: Deno.env.get("LLM_TRANSLATION_ENDPOINT") || "https://ollama.foodshare.club/api/translate",
  apiKey: Deno.env.get("LLM_TRANSLATION_API_KEY") || "a0561ed547369f3d094f66d1bf5ce5974bf13cae4e6c481feabff1033b521b9b",
  cfAccessClientId: Deno.env.get("CF_ACCESS_CLIENT_ID") || "546b88a3efd36b53f35cd8508ba25560.access",
  cfAccessClientSecret: Deno.env.get("CF_ACCESS_CLIENT_SECRET") || "e483bb03a4d8916403693ed072a73b22343b901f11e79f383996fbe2dbe0192e",
});
