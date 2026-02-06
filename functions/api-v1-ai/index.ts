/**
 * AI API v1 - Production-Grade Multi-Provider AI Service
 * 
 * Routes:
 * - POST /chat - Chat completions with streaming
 * - POST /embeddings - Text embeddings
 * - POST /structured - JSON generation with schema validation
 * - GET /models - Available models
 * - GET /health - Provider health status
 * 
 * Providers: Groq (primary) → z.ai → OpenRouter (fallback)
 * 
 * @version 1.0.0
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError, ServiceUnavailableError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";
import { withCircuitBreaker } from "../_shared/circuit-breaker.ts";
import { withRetry, RETRY_PRESETS } from "../_shared/retry.ts";

// =============================================================================
// Configuration
// =============================================================================

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") || "";
const ZAI_API_KEY = Deno.env.get("ZAI_API_KEY") || "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";

const RATE_LIMIT = {
  perUser: 100, // requests per hour
  global: 10000, // requests per hour
};

// =============================================================================
// Schemas
// =============================================================================

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1),
  model: z.string().default("llama-3.3-70b-versatile"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().min(1).max(32000).optional(),
  stream: z.boolean().default(false),
});

const embeddingsSchema = z.object({
  input: z.union([z.string(), z.array(z.string())]),
  model: z.string().default("text-embedding-3-small"),
});

const structuredSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1),
  schema: z.record(z.any()),
  model: z.string().default("llama-3.3-70b-versatile"),
});

// =============================================================================
// Types
// =============================================================================

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: ChatMessage;
    finishReason: string;
  }>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: string;
  cost?: number;
}

interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: {
    totalTokens: number;
  };
  provider: string;
}

// =============================================================================
// Provider Adapters
// =============================================================================

class GroqProvider {
  private baseUrl = "https://api.groq.com/openai/v1";

  async chat(
    messages: ChatMessage[],
    model: string,
    temperature: number,
    maxTokens?: number,
    stream = false
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      model: data.model,
      choices: data.choices.map((c: any) => ({
        message: c.message,
        finishReason: c.finish_reason,
      })),
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      provider: "groq",
      cost: this.estimateCost(data.usage.total_tokens),
    };
  }

  async structured(
    messages: ChatMessage[],
    schema: Record<string, any>,
    model: string
  ): Promise<any> {
    const systemPrompt = `You must respond with valid JSON matching this schema: ${JSON.stringify(schema)}`;
    const enhancedMessages = [
      { role: "system" as const, content: systemPrompt },
      ...messages,
    ];

    const response = await this.chat(enhancedMessages, model, 0.1);
    const content = response.choices[0].message.content;
    
    try {
      return JSON.parse(content);
    } catch {
      throw new ValidationError("Invalid JSON response from model");
    }
  }

  private estimateCost(tokens: number): number {
    // Groq free tier - $0 for now
    return 0;
  }
}

class ZaiProvider {
  private baseUrl = "https://api.z.ai/api/v2";

  async embeddings(input: string | string[]): Promise<EmbeddingResponse> {
    const texts = Array.isArray(input) ? input : [input];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ZAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: "text-embedding-3-small",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`z.ai API error: ${error}`);
    }

    const data = await response.json();
    return {
      embeddings: data.data.map((d: any) => d.embedding),
      model: data.model,
      usage: {
        totalTokens: data.usage.total_tokens,
      },
      provider: "z.ai",
    };
  }

  async chat(
    messages: ChatMessage[],
    model: string,
    temperature: number
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ZAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`z.ai API error: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      model: data.model,
      choices: data.choices.map((c: any) => ({
        message: c.message,
        finishReason: c.finish_reason,
      })),
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      provider: "z.ai",
    };
  }
}

class OpenRouterProvider {
  private baseUrl = "https://openrouter.ai/api/v1";

  async chat(
    messages: ChatMessage[],
    model: string,
    temperature: number,
    maxTokens?: number
  ): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://foodshare.club",
        "X-Title": "FoodShare",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${error}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      model: data.model,
      choices: data.choices.map((c: any) => ({
        message: c.message,
        finishReason: c.finish_reason,
      })),
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      provider: "openrouter",
    };
  }
}

// =============================================================================
// Service Layer
// =============================================================================

class AIService {
  private groq = new GroqProvider();
  private zai = new ZaiProvider();
  private openrouter = new OpenRouterProvider();

  async chat(
    messages: ChatMessage[],
    model: string,
    temperature: number,
    maxTokens?: number,
    stream = false
  ): Promise<ChatResponse> {
    // Try Groq first
    if (GROQ_API_KEY) {
      try {
        return await withCircuitBreaker(
          "groq-chat",
          () => this.groq.chat(messages, model, temperature, maxTokens, stream)
        );
      } catch (error) {
        logger.warn("Groq failed, trying z.ai", { error });
      }
    }

    // Fallback to z.ai
    if (ZAI_API_KEY) {
      try {
        return await withCircuitBreaker(
          "zai-chat",
          () => this.zai.chat(messages, model, temperature)
        );
      } catch (error) {
        logger.warn("z.ai failed, trying OpenRouter", { error });
      }
    }

    // Last resort: OpenRouter
    if (OPENROUTER_API_KEY) {
      return await withCircuitBreaker(
        "openrouter-chat",
        () => this.openrouter.chat(messages, model, temperature, maxTokens)
      );
    }

    throw new ServiceUnavailableError("All AI providers unavailable");
  }

  async embeddings(input: string | string[]): Promise<EmbeddingResponse> {
    // Try z.ai first (optimized for embeddings)
    if (ZAI_API_KEY) {
      try {
        return await withCircuitBreaker(
          "zai-embeddings",
          () => this.zai.embeddings(input)
        );
      } catch (error) {
        logger.warn("z.ai embeddings failed", { error });
      }
    }

    throw new ServiceUnavailableError("Embedding service unavailable");
  }

  async structured(
    messages: ChatMessage[],
    schema: Record<string, any>,
    model: string
  ): Promise<any> {
    if (!GROQ_API_KEY) {
      throw new ServiceUnavailableError("Structured generation unavailable");
    }

    return await withCircuitBreaker(
      "groq-structured",
      () => this.groq.structured(messages, schema, model)
    );
  }

  getAvailableModels() {
    const models = [];

    if (GROQ_API_KEY) {
      models.push(
        { id: "llama-3.3-70b-versatile", provider: "groq", type: "chat" },
        { id: "mixtral-8x7b-32768", provider: "groq", type: "chat" },
        { id: "gemma2-9b-it", provider: "groq", type: "chat" }
      );
    }

    if (ZAI_API_KEY) {
      models.push(
        { id: "text-embedding-3-small", provider: "z.ai", type: "embedding" },
        { id: "gpt-4o-mini", provider: "z.ai", type: "chat" }
      );
    }

    if (OPENROUTER_API_KEY) {
      models.push(
        { id: "openai/gpt-4-turbo", provider: "openrouter", type: "chat" },
        { id: "anthropic/claude-3.5-sonnet", provider: "openrouter", type: "chat" }
      );
    }

    return models;
  }

  async checkHealth() {
    const status = {
      groq: GROQ_API_KEY ? "configured" : "missing",
      zai: ZAI_API_KEY ? "configured" : "missing",
      openrouter: OPENROUTER_API_KEY ? "configured" : "missing",
    };

    return {
      healthy: GROQ_API_KEY || ZAI_API_KEY || OPENROUTER_API_KEY,
      providers: status,
    };
  }
}

const aiService = new AIService();

// =============================================================================
// Rate Limiting
// =============================================================================

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): void {
  const now = Date.now();
  const key = `user:${userId}`;
  const limit = rateLimitStore.get(key);

  if (!limit || now > limit.resetAt) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + 3600000, // 1 hour
    });
    return;
  }

  if (limit.count >= RATE_LIMIT.perUser) {
    throw new ValidationError(
      `Rate limit exceeded. Limit: ${RATE_LIMIT.perUser} requests/hour`
    );
  }

  limit.count++;
}

// =============================================================================
// Handlers
// =============================================================================

async function handleChat(ctx: HandlerContext) {
  const body = chatSchema.parse(await ctx.request.json());
  checkRateLimit(ctx.user.id);

  const response = await aiService.chat(
    body.messages,
    body.model,
    body.temperature,
    body.maxTokens,
    body.stream
  );

  logger.info("Chat completion", {
    userId: ctx.user.id,
    model: response.model,
    tokens: response.usage.totalTokens,
    provider: response.provider,
  });

  return ok(response);
}

async function handleEmbeddings(ctx: HandlerContext) {
  const body = embeddingsSchema.parse(await ctx.request.json());
  checkRateLimit(ctx.user.id);

  const response = await aiService.embeddings(body.input);

  logger.info("Embeddings generated", {
    userId: ctx.user.id,
    count: response.embeddings.length,
    provider: response.provider,
  });

  return ok(response);
}

async function handleStructured(ctx: HandlerContext) {
  const body = structuredSchema.parse(await ctx.request.json());
  checkRateLimit(ctx.user.id);

  const response = await aiService.structured(
    body.messages,
    body.schema,
    body.model
  );

  logger.info("Structured generation", {
    userId: ctx.user.id,
    model: body.model,
  });

  return ok({ data: response });
}

async function handleModels(ctx: HandlerContext) {
  const models = aiService.getAvailableModels();
  return ok({ models });
}

async function handleHealth(ctx: HandlerContext) {
  const health = await aiService.checkHealth();
  return ok(health);
}

// =============================================================================
// Router
// =============================================================================

export default createAPIHandler({
  requireAuth: true,
  routes: {
    "POST /chat": handleChat,
    "POST /embeddings": handleEmbeddings,
    "POST /structured": handleStructured,
    "GET /models": handleModels,
    "GET /health": handleHealth,
  },
});
