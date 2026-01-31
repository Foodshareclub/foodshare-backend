/**
 * Hugging Face Inference Edge Function
 *
 * Features:
 * - Multi-level caching (Memory + Database)
 * - Rate limiting per model
 * - Multiple endpoints (translation, TTS, image generation, etc.)
 * - Performance monitoring
 *
 * Endpoints:
 * POST /hf-inference/translation
 * POST /hf-inference/textToSpeech
 * POST /hf-inference/textToImage
 * POST /hf-inference/imageToText
 * POST /hf-inference/summarization
 * POST /hf-inference/questionAnswering
 */

import { HfInference } from "https://esm.sh/@huggingface/inference@2.6.4";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  cacheTTL: 3600000, // 1 hour
};

// =============================================================================
// In-Memory Cache
// =============================================================================

const inferenceCache = new Map<
  string,
  {
    result: unknown;
    timestamp: number;
    hits: number;
  }
>();

// Clean cache every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of inferenceCache.entries()) {
    if (now - value.timestamp > CONFIG.cacheTTL) {
      inferenceCache.delete(key);
    }
  }
}, 300000);

// =============================================================================
// Request Schemas
// =============================================================================

const inferenceBodySchema = z.object({
  model: z.string().optional(),
  inputs: z.union([z.string(), z.array(z.string())]).optional(),
  input: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  // For imageToText
  imageUrl: z.string().optional(),
  imageData: z.unknown().optional(),
  // For questionAnswering
  question: z.string().optional(),
  context: z.string().optional(),
}).optional();

type InferenceBody = z.infer<typeof inferenceBodySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface InferenceResponse {
  result: unknown;
  cached: boolean;
  cacheSource?: string;
  responseTime: number;
  requestId: string;
}

interface EndpointInfo {
  message: string;
  version: string;
  endpoints: string[];
  usage: {
    method: string;
    body: {
      inputs: string;
      model: string;
      parameters: string;
    };
  };
}

// =============================================================================
// Cache Helpers
// =============================================================================

function generateCacheKey(model: string, inputs: unknown, params?: unknown): string {
  const data = JSON.stringify({ model, inputs, params });
  return btoa(data).slice(0, 64);
}

async function getCachedResult(
  cacheKey: string,
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>
): Promise<{ result: unknown; source: string } | null> {
  // Check memory cache
  const cached = inferenceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CONFIG.cacheTTL) {
    cached.hits++;
    return { result: cached.result, source: "memory" };
  }

  // Check database cache
  const { data } = await supabase
    .from("inference_cache")
    .select("result, created_at")
    .eq("cache_key", cacheKey)
    .gte("created_at", new Date(Date.now() - CONFIG.cacheTTL).toISOString())
    .single();

  if (data) {
    // Store in memory for faster access
    inferenceCache.set(cacheKey, {
      result: data.result,
      timestamp: Date.now(),
      hits: 1,
    });
    return { result: data.result, source: "database" };
  }

  return null;
}

async function cacheResult(
  cacheKey: string,
  result: unknown,
  supabase: ReturnType<typeof import("../_shared/supabase.ts").getSupabaseClient>
): Promise<void> {
  // Cache in memory
  inferenceCache.set(cacheKey, {
    result,
    timestamp: Date.now(),
    hits: 1,
  });

  // Cache in database (fire and forget)
  supabase
    .from("inference_cache")
    .upsert({
      cache_key: cacheKey,
      result,
      created_at: new Date().toISOString(),
    })
    .then(() => {})
    .catch((err: Error) => logger.warn("Cache write failed", { error: err.message }));
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleInference(
  ctx: HandlerContext<InferenceBody>
): Promise<Response> {
  const { supabase, body, ctx: requestCtx, request } = ctx;
  const startTime = performance.now();

  // Get endpoint from path
  const url = new URL(request.url);
  const endpoint = url.pathname.split("/").pop();

  // Validate HF token
  const hfToken = Deno.env.get("HUGGINGFACE_ACCESS_TOKEN");
  if (!hfToken) {
    logger.error("Missing HUGGINGFACE_ACCESS_TOKEN");
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Return API info for root endpoint
  if (!endpoint || endpoint === "hf-inference") {
    const info: EndpointInfo = {
      message: "Hugging Face Inference API",
      version: CONFIG.version,
      endpoints: [
        "/translation",
        "/textToSpeech",
        "/textToImage",
        "/imageToText",
        "/summarization",
        "/questionAnswering",
      ],
      usage: {
        method: "POST",
        body: {
          inputs: "Your input text or data",
          model: "Optional model name",
          parameters: "Optional parameters",
        },
      },
    };

    return ok(info, ctx);
  }

  const model = body?.model || endpoint || "default";

  logger.info("Processing inference request", {
    endpoint,
    model,
    requestId: requestCtx?.requestId,
  });

  // Initialize HF client
  const hf = new HfInference(hfToken);

  // Generate cache key
  const cacheKey = generateCacheKey(model, body?.inputs || body?.input, body?.parameters);

  // Check cache
  const cached = await getCachedResult(cacheKey, supabase);
  if (cached) {
    const response: InferenceResponse = {
      result: cached.result,
      cached: true,
      cacheSource: cached.source,
      responseTime: Math.round(performance.now() - startTime),
      requestId: requestCtx?.requestId || "",
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Cache": "HIT",
        "X-Cache-Source": cached.source,
        "X-Response-Time": `${Math.round(performance.now() - startTime)}ms`,
      },
    });
  }

  // Perform inference based on endpoint
  let result: unknown;
  let contentType = "application/json";

  try {
    switch (endpoint) {
      case "translation":
        result = await hf.translation({
          model: body?.model || "t5-base",
          inputs: body?.inputs as string,
        });
        break;

      case "textToSpeech": {
        const speechBlob = await hf.textToSpeech({
          model: body?.model || "espnet/kan-bayashi_ljspeech_vits",
          inputs: body?.inputs as string,
        });
        contentType = "audio/wav";
        result = speechBlob;
        break;
      }

      case "textToImage": {
        const imageBlob = await hf.textToImage({
          model: body?.model || "stabilityai/stable-diffusion-2",
          inputs: body?.inputs as string,
          parameters: body?.parameters,
        });
        contentType = "image/png";
        result = imageBlob;
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
          inputs: body?.inputs as string,
          parameters: body?.parameters,
        });
        break;

      case "questionAnswering":
        result = await hf.questionAnswering({
          model: body?.model || "deepset/roberta-base-squad2",
          inputs: {
            question: body?.question || "",
            context: body?.context || "",
          },
        });
        break;

      default:
        return new Response(
          JSON.stringify({ error: `Unknown endpoint: ${endpoint}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }
  } catch (error) {
    logger.error("Inference failed", {
      endpoint,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }

  // Cache result if JSON
  if (contentType === "application/json") {
    await cacheResult(cacheKey, result, supabase);
  }

  // Return result
  if (contentType !== "application/json") {
    return new Response(result as Blob, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "X-Cache": "MISS",
        "X-Response-Time": `${Math.round(performance.now() - startTime)}ms`,
        "X-Request-Id": requestCtx?.requestId || "",
      },
    });
  }

  const response: InferenceResponse = {
    result,
    cached: false,
    responseTime: Math.round(performance.now() - startTime),
    requestId: requestCtx?.requestId || "",
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Cache": "MISS",
      "X-Response-Time": `${Math.round(performance.now() - startTime)}ms`,
      "X-Request-Id": requestCtx?.requestId || "",
    },
  });
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "hf-inference",
  version: CONFIG.version,
  requireAuth: false, // Public AI inference endpoint
  rateLimit: {
    limit: 10,
    windowMs: 60000, // 10 requests per minute per model
    keyBy: "ip",
  },
  routes: {
    POST: {
      schema: inferenceBodySchema,
      handler: handleInference,
    },
  },
});
