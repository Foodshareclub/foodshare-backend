/**
 * Unified AI API v1
 *
 * Consolidates ai-api (Groq/z.ai) + hf-inference (Hugging Face) into a single endpoint.
 *
 * Routes:
 * - POST /chat              - LLM chat completion (Groq)
 * - POST /embeddings        - Text embeddings (z.ai)
 * - POST /inference/:task   - HF inference (translation, textToSpeech, textToImage, etc.)
 * - GET  /models            - List available models
 * - GET  /health            - Provider health check
 *
 * @module api-v1-ai
 */

import { HfInference } from "https://esm.sh/@huggingface/inference@2.6.4";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { createHealthHandler } from "../_shared/health-handler.ts";
import { logger } from "../_shared/logger.ts";
import { ServerError, ValidationError } from "../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

const VERSION = "1.0.0";

const GROQ_KEY = Deno.env.get("GROQ_API_KEY") || "";
const ZAI_KEY = Deno.env.get("ZAI_API_KEY") || "";

const healthCheck = createHealthHandler("api-v1-ai", VERSION, {
  extra: () => ({
    providers: {
      groq: GROQ_KEY ? "configured" : "missing",
      zai: ZAI_KEY ? "configured" : "missing",
      huggingface: Deno.env.get("HUGGINGFACE_ACCESS_TOKEN") ? "configured" : "missing",
    },
  }),
});

const HF_CACHE_TTL = 3600000; // 1 hour

// =============================================================================
// Schemas
// =============================================================================

const postBodySchema = z
  .object({
    // Chat fields
    messages: z.array(z.record(z.unknown())).optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    // Embeddings fields
    input: z.union([z.string(), z.array(z.string())]).optional(),
    // HF inference fields
    inputs: z.union([z.string(), z.array(z.string())]).optional(),
    parameters: z.record(z.unknown()).optional(),
    imageUrl: z.string().optional(),
    imageData: z.unknown().optional(),
    question: z.string().optional(),
    context: z.string().optional(),
  })
  .optional();

type PostBody = z.infer<typeof postBodySchema>;

// =============================================================================
// Path Helper
// =============================================================================

function getSubPath(url: URL): string {
  const marker = "/api-v1-ai";
  const idx = url.pathname.indexOf(marker);
  if (idx === -1) return "";
  const sub = url.pathname.slice(idx + marker.length);
  return sub.startsWith("/") ? sub.slice(1) : sub;
}

// =============================================================================
// HF Inference Cache (memory + database)
// =============================================================================

const inferenceCache = new Map<string, { result: unknown; timestamp: number; hits: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of inferenceCache.entries()) {
    if (now - value.timestamp > HF_CACHE_TTL) {
      inferenceCache.delete(key);
    }
  }
}, 300000);

function generateCacheKey(model: string, inputs: unknown, params?: unknown): string {
  return btoa(JSON.stringify({ model, inputs, params })).slice(0, 64);
}

async function getCachedResult(
  cacheKey: string,
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ result: unknown; source: string } | null> {
  const cached = inferenceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HF_CACHE_TTL) {
    cached.hits++;
    return { result: cached.result, source: "memory" };
  }

  const { data } = await supabase
    .from("inference_cache")
    .select("result, created_at")
    .eq("cache_key", cacheKey)
    .gte("created_at", new Date(Date.now() - HF_CACHE_TTL).toISOString())
    .single();

  if (data) {
    inferenceCache.set(cacheKey, { result: data.result, timestamp: Date.now(), hits: 1 });
    return { result: data.result, source: "database" };
  }

  return null;
}

// deno-lint-ignore no-explicit-any
async function setCachedResult(cacheKey: string, result: unknown, supabase: any): Promise<void> {
  inferenceCache.set(cacheKey, { result, timestamp: Date.now(), hits: 1 });
  supabase
    .from("inference_cache")
    .upsert({ cache_key: cacheKey, result, created_at: new Date().toISOString() })
    .then(() => {})
    .catch((err: Error) => logger.warn("Cache write failed", { error: err.message }));
}

// =============================================================================
// Groq Chat
// =============================================================================

async function groqChat(
  messages: unknown[],
  model: string,
  temp: number,
  maxTokens?: number,
) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature: temp, max_tokens: maxTokens }),
  });

  if (!res.ok) throw new ServerError(`Groq error: ${res.status}`);
  // deno-lint-ignore no-explicit-any
  const data: any = await res.json();

  return {
    id: data.id,
    model: data.model,
    // deno-lint-ignore no-explicit-any
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

// =============================================================================
// z.ai Embeddings
// =============================================================================

async function zaiEmbeddings(input: string | string[]) {
  const texts = Array.isArray(input) ? input : [input];

  const res = await fetch("https://api.z.ai/api/v2/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: "text-embedding-3-small" }),
  });

  if (!res.ok) throw new ServerError(`z.ai error: ${res.status}`);
  // deno-lint-ignore no-explicit-any
  const data: any = await res.json();

  return {
    // deno-lint-ignore no-explicit-any
    embeddings: data.data.map((d: any) => d.embedding),
    model: data.model,
    usage: { totalTokens: data.usage.total_tokens },
    provider: "z.ai",
  };
}

// =============================================================================
// HF Inference
// =============================================================================

async function runHfInference(
  task: string,
  body: PostBody,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  _requestId: string,
): Promise<{ result: unknown; contentType: string; cached: boolean; cacheSource?: string }> {
  const hfToken = Deno.env.get("HUGGINGFACE_ACCESS_TOKEN");
  if (!hfToken) throw new ServerError("Missing HUGGINGFACE_ACCESS_TOKEN");

  const model = body?.model || task;
  const cacheKey = generateCacheKey(model, body?.inputs || body?.input, body?.parameters);

  const cached = await getCachedResult(cacheKey, supabase);
  if (cached) {
    return {
      result: cached.result,
      contentType: "application/json",
      cached: true,
      cacheSource: cached.source,
    };
  }

  const hf = new HfInference(hfToken);
  let result: unknown;
  let contentType = "application/json";

  switch (task) {
    case "translation":
      result = await hf.translation({
        model: body?.model || "t5-base",
        inputs: (body?.inputs as string) || "",
      });
      break;

    case "textToSpeech": {
      result = await hf.textToSpeech({
        model: body?.model || "espnet/kan-bayashi_ljspeech_vits",
        inputs: (body?.inputs as string) || "",
      });
      contentType = "audio/wav";
      break;
    }

    case "textToImage": {
      result = await hf.textToImage({
        model: body?.model || "stabilityai/stable-diffusion-2",
        inputs: (body?.inputs as string) || "",
        parameters: body?.parameters,
      });
      contentType = "image/png";
      break;
    }

    case "imageToText": {
      const imageData = body?.imageUrl
        ? await (await fetch(body.imageUrl)).blob()
        : body?.imageData;
      result = await hf.imageToText({
        data: imageData as Blob,
        model: body?.model || "nlpconnect/vit-gpt2-image-captioning",
      });
      break;
    }

    case "summarization":
      result = await hf.summarization({
        model: body?.model || "facebook/bart-large-cnn",
        inputs: (body?.inputs as string) || "",
        parameters: body?.parameters,
      });
      break;

    case "questionAnswering":
      result = await hf.questionAnswering({
        model: body?.model || "deepset/roberta-base-squad2",
        inputs: { question: body?.question || "", context: body?.context || "" },
      });
      break;

    default:
      throw new ValidationError(`Unknown inference task: ${task}`);
  }

  if (contentType === "application/json") {
    await setCachedResult(cacheKey, result, supabase);
  }

  return { result, contentType, cached: false };
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handlePost(ctx: HandlerContext<PostBody>): Promise<Response> {
  const url = new URL(ctx.request.url);
  const subPath = getSubPath(url);

  // POST /chat
  if (subPath === "chat" || subPath === "chat/") {
    if (!ctx.userId) throw new ValidationError("Authentication required");

    const body = ctx.body || {};
    const result = await groqChat(
      body.messages || [],
      body.model || "llama-3.3-70b-versatile",
      body.temperature ?? 0.7,
      body.maxTokens,
    );
    return ok(result, ctx);
  }

  // POST /embeddings
  if (subPath === "embeddings" || subPath === "embeddings/") {
    if (!ctx.userId) throw new ValidationError("Authentication required");

    const body = ctx.body || {};
    if (!body.input) throw new ValidationError("input is required");
    const result = await zaiEmbeddings(body.input);
    return ok(result, ctx);
  }

  // POST /inference/:task
  if (subPath.startsWith("inference/")) {
    const task = subPath.split("/")[1];
    if (!task) throw new ValidationError("Inference task is required");

    logger.info("Processing HF inference", {
      task,
      model: ctx.body?.model,
      requestId: ctx.ctx?.requestId,
    });

    const startTime = performance.now();
    const { result, contentType, cached, cacheSource } = await runHfInference(
      task,
      ctx.body,
      ctx.supabase,
      ctx.ctx?.requestId || "",
    );

    const responseTime = Math.round(performance.now() - startTime);

    if (contentType !== "application/json") {
      return new Response(result as Blob, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "X-Cache": cached ? "HIT" : "MISS",
          "X-Response-Time": `${responseTime}ms`,
        },
      });
    }

    return ok(
      {
        result,
        cached,
        ...(cacheSource ? { cacheSource } : {}),
        responseTime,
      },
      ctx,
    );
  }

  throw new ValidationError(
    "Unknown endpoint. Use /chat, /embeddings, or /inference/:task",
  );
}

async function handleGet(ctx: HandlerContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const subPath = getSubPath(url);

  // GET /health
  if (subPath === "health" || subPath === "health/") {
    return healthCheck(ctx);
  }

  // GET /models
  if (subPath === "models" || subPath === "models/") {
    return ok(
      {
        chat: [
          { id: "llama-3.3-70b-versatile", provider: "groq" },
          { id: "mixtral-8x7b-32768", provider: "groq" },
        ],
        embeddings: [{ id: "text-embedding-3-small", provider: "z.ai" }],
        inference: [
          { task: "translation", defaultModel: "t5-base", provider: "huggingface" },
          {
            task: "textToSpeech",
            defaultModel: "espnet/kan-bayashi_ljspeech_vits",
            provider: "huggingface",
          },
          {
            task: "textToImage",
            defaultModel: "stabilityai/stable-diffusion-2",
            provider: "huggingface",
          },
          {
            task: "imageToText",
            defaultModel: "nlpconnect/vit-gpt2-image-captioning",
            provider: "huggingface",
          },
          {
            task: "summarization",
            defaultModel: "facebook/bart-large-cnn",
            provider: "huggingface",
          },
          {
            task: "questionAnswering",
            defaultModel: "deepset/roberta-base-squad2",
            provider: "huggingface",
          },
        ],
      },
      ctx,
    );
  }

  // GET / — API info
  return ok(
    {
      service: "api-v1-ai",
      version: VERSION,
      endpoints: {
        "POST /chat": "LLM chat completion (Groq)",
        "POST /embeddings": "Text embeddings (z.ai)",
        "POST /inference/:task":
          "HF inference (translation, textToSpeech, textToImage, imageToText, summarization, questionAnswering)",
        "GET /models": "List available models",
        "GET /health": "Provider health check",
      },
    },
    ctx,
  );
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-ai",
  version: VERSION,
  requireAuth: false, // Auth handled per-route: chat/embeddings require JWT, inference/health/models public
  csrf: false, // API clients
  rateLimit: {
    limit: 30,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      handler: handleGet,
    },
    POST: {
      schema: postBodySchema,
      handler: handlePost,
    },
  },
}));
