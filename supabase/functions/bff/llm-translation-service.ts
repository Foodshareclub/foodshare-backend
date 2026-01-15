/**
 * Self-Hosted LLM Translation Service
 * Uses Ollama (qwen2.5-coder:7b) for on-the-fly content translation
 */

interface LLMConfig {
  endpoint: string;
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
   * Translate text using self-hosted LLM (Ollama)
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
    
    try {
      // Call Ollama API (OpenAI-compatible)
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
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
          stream: false,
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
    } catch (error) {
      console.error("LLM translation error:", error);
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

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
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
          stream: false,
        }),
      });

      const data = await response.json();
      const translatedBatch = data.choices[0].message.content.trim();

      // Parse numbered responses
      const translations = translatedBatch
        .split("\n")
        .filter((line: string) => /^\[\d+\]/.test(line))
        .map((line: string) => line.replace(/^\[\d+\]\s*/, "").trim());

      // Fallback: if parsing fails, return original texts
      return translations.length === texts.length ? translations : texts;
    } catch (error) {
      console.error("Batch translation error:", error);
      return texts; // Fallback to original
    }
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

// Export singleton with configuration
export const llmTranslationService = new LLMTranslationService({
  endpoint: Deno.env.get("LLM_TRANSLATION_ENDPOINT") || "https://ollama.foodshare.club/v1/chat/completions",
  model: Deno.env.get("LLM_TRANSLATION_MODEL") || "qwen2.5-coder:7b",
  maxTokens: 500,
  temperature: 0.3, // Low temperature for consistent translations
});
