/**
 * Self-Hosted LLM Translation Service
 * Uses Ollama API at ollama.foodshare.club/api/chat
 * Protected by Cloudflare Access
 * 
 * TODO: Switch to dedicated translation service once activated:
 * - Endpoint: https://ollama.foodshare.club/api/translate
 * - Requires Cloudflare Tunnel route #5 activation
 */

interface LLMConfig {
  endpoint: string;
  model: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
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
   * Translate text using Ollama chat API
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
      // Build translation prompt
      const systemPrompt = this.buildSystemPrompt(sourceLang, targetLang, context);
      
      // Call Ollama chat API with Cloudflare Access auth
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": this.config.cfAccessClientId,
          "CF-Access-Client-Secret": this.config.cfAccessClientSecret,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          stream: false,
          options: {
            temperature: this.config.temperature,
            num_predict: this.config.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const translatedText = data.message?.content?.trim() || text;

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
        tokensUsed: data.eval_count || 0,
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
   * Build context-aware system prompt
   */
  private buildSystemPrompt(
    sourceLang: string,
    targetLang: string,
    context?: string
  ): string {
    const langNames = this.getLanguageNames();
    const sourceLanguage = langNames[sourceLang] || sourceLang.toUpperCase();
    const targetLanguage = langNames[targetLang] || targetLang.toUpperCase();

    return `You are a professional translator specializing in food-sharing and community platforms.

TASK: Translate the following text from ${sourceLanguage} to ${targetLanguage}.

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
  }

  /**
   * Get language name from code
   */
  private getLanguageNames(): Record<string, string> {
    return {
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
  endpoint: Deno.env.get("LLM_TRANSLATION_ENDPOINT") || "https://ollama.foodshare.club/api/chat",
  model: Deno.env.get("LLM_MODEL") || "qwen2.5-coder:7b",
  cfAccessClientId: Deno.env.get("CF_ACCESS_CLIENT_ID") || "546b88a3efd36b53f35cd8508ba25560.access",
  cfAccessClientSecret: Deno.env.get("CF_ACCESS_CLIENT_SECRET") || "e483bb03a4d8916403693ed072a73b22343b901f11e79f383996fbe2dbe0192e",
  maxTokens: 500,
  temperature: 0.3,
});
