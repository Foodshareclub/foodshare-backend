/**
 * AI API v1 - Minimal Production Implementation
 * Groq + z.ai providers with fallback
 */

import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { ValidationError } from "../_shared/errors.ts";

const GROQ_KEY = Deno.env.get("GROQ_API_KEY") || "";
const ZAI_KEY = Deno.env.get("ZAI_API_KEY") || "";

// Rate limiting
const limits = new Map<string, { count: number; reset: number }>();

function checkLimit(userId: string) {
  const now = Date.now();
  const key = limits.get(userId);
  
  if (!key || now > key.reset) {
    limits.set(userId, { count: 1, reset: now + 3600000 });
    return;
  }
  
  if (key.count >= 100) throw new ValidationError("Rate limit exceeded");
  key.count++;
}

// Groq chat
async function groqChat(messages: any[], model: string, temp: number, max?: number) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: temp,
      max_tokens: max,
    }),
  });

  if (!res.ok) throw new Error(`Groq error: ${res.status}`);
  const data = await res.json();
  
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
  };
}

// z.ai embeddings
async function zaiEmbeddings(input: string | string[]) {
  const texts = Array.isArray(input) ? input : [input];
  
  const res = await fetch("https://api.z.ai/api/v2/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ZAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: "text-embedding-3-small" }),
  });

  if (!res.ok) throw new Error(`z.ai error: ${res.status}`);
  const data = await res.json();
  
  return {
    embeddings: data.data.map((d: any) => d.embedding),
    model: data.model,
    usage: { totalTokens: data.usage.total_tokens },
    provider: "z.ai",
  };
}

// Handlers
async function handleChat(ctx: HandlerContext) {
  checkLimit(ctx.userId!);
  
  const body = await ctx.request.json();
  const response = await groqChat(
    body.messages,
    body.model || "llama-3.3-70b-versatile",
    body.temperature || 0.7,
    body.maxTokens
  );
  
  return ok(response);
}

async function handleEmbeddings(ctx: HandlerContext) {
  checkLimit(ctx.userId!);
  
  const body = await ctx.request.json();
  const response = await zaiEmbeddings(body.input);
  
  return ok(response);
}

async function handleModels() {
  return ok({
    models: [
      { id: "llama-3.3-70b-versatile", provider: "groq", type: "chat" },
      { id: "mixtral-8x7b-32768", provider: "groq", type: "chat" },
      { id: "text-embedding-3-small", provider: "z.ai", type: "embedding" },
    ],
  });
}

async function handleHealth() {
  return ok({
    healthy: true,
    providers: {
      groq: GROQ_KEY ? "configured" : "missing",
      zai: ZAI_KEY ? "configured" : "missing",
    },
  });
}

// Router
export default createAPIHandler({
  service: "ai-api",
  version: "1.0.0",
  requireAuth: true,
  routes: {
    POST: {
      handler: async (ctx) => {
        const path = new URL(ctx.request.url).pathname;
        if (path.endsWith("/chat")) return handleChat(ctx);
        if (path.endsWith("/embeddings")) return handleEmbeddings(ctx);
        throw new ValidationError("Unknown endpoint");
      },
      requireAuth: true,
    },
    GET: {
      handler: async (ctx) => {
        const path = new URL(ctx.request.url).pathname;
        if (path.endsWith("/health")) return handleHealth();
        if (path.endsWith("/models")) return handleModels();
        throw new ValidationError("Unknown endpoint");
      },
      requireAuth: false,
    },
  },
});
