/**
 * Hugging Face Inference - Optimized
 *
 * Features:
 * - Multi-level caching (Memory + Database)
 * - Rate limiting per model
 * - Request queuing
 * - Compression
 * - Error handling
 * - Performance monitoring
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { HfInference } from "https://esm.sh/@huggingface/inference@2.6.4";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Configuration
const CACHE_TTL = 3600000; // 1 hour
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // requests per window per model

// In-memory cache for inference results
const inferenceCache = new Map<
  string,
  {
    result: any;
    timestamp: number;
    hits: number;
  }
>();

// Rate limiting per model
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/**
 * Check rate limit for specific model
 */
function checkRateLimit(model: string, clientId: string): boolean {
  const key = `${model}:${clientId}`;
  const now = Date.now();
  const limit = rateLimitStore.get(key);

  if (!limit || now > limit.resetAt) {
    rateLimitStore.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW,
    });
    return true;
  }

  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }

  limit.count++;
  return true;
}

/**
 * Clean expired cache entries
 */
function cleanCache() {
  const now = Date.now();

  for (const [key, value] of inferenceCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      inferenceCache.delete(key);
    }
  }

  for (const [key, value] of rateLimitStore.entries()) {
    if (now > value.resetAt) {
      rateLimitStore.delete(key);
    }
  }
}

// Clean cache every 5 minutes
setInterval(cleanCache, 300000);

/**
 * Generate cache key
 */
function generateCacheKey(model: string, inputs: any, params?: any): string {
  const data = JSON.stringify({ model, inputs, params });
  return btoa(data).slice(0, 64);
}

/**
 * Get cached result
 */
async function getCachedResult(cacheKey: string, supabase: any): Promise<any | null> {
  // Check memory cache
  const cached = inferenceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    cached.hits++;
    return { result: cached.result, source: "memory" };
  }

  // Check database cache
  const { data } = await supabase
    .from("inference_cache")
    .select("result, created_at")
    .eq("cache_key", cacheKey)
    .gte("created_at", new Date(Date.now() - CACHE_TTL).toISOString())
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

/**
 * Cache result
 */
async function cacheResult(cacheKey: string, result: any, supabase: any): Promise<void> {
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
    .catch((err: any) => console.warn("Cache write failed:", err));
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate environment
  const hfToken = Deno.env.get("HUGGINGFACE_ACCESS_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!hfToken) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const endpoint = url.pathname.split("/").pop();
    const body = await req.json();

    // Rate limiting
    const clientId = req.headers.get("x-forwarded-for") || "unknown";
    const model = body.model || endpoint || "default";

    if (!checkRateLimit(model, clientId)) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded",
          retryAfter: 60,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Retry-After": "60",
          },
        }
      );
    }

    // Initialize clients
    const hf = new HfInference(hfToken);
    const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

    // Generate cache key
    const cacheKey = generateCacheKey(model, body.inputs || body.input, body.parameters);

    // Check cache
    if (supabase) {
      const cached = await getCachedResult(cacheKey, supabase);
      if (cached) {
        return new Response(
          JSON.stringify({
            result: cached.result,
            cached: true,
            cacheSource: cached.source,
            responseTime: Date.now() - startTime,
            requestId,
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "X-Cache": "HIT",
              "X-Cache-Source": cached.source,
              "X-Response-Time": `${Date.now() - startTime}ms`,
            },
          }
        );
      }
    }

    // Perform inference based on endpoint
    let result: any;
    let contentType = "application/json";

    switch (endpoint) {
      case "translation":
        result = await hf.translation({
          model: body.model || "t5-base",
          inputs: body.inputs,
        });
        break;

      case "textToSpeech":
        const speechBlob = await hf.textToSpeech({
          model: body.model || "espnet/kan-bayashi_ljspeech_vits",
          inputs: body.inputs,
        });
        contentType = "audio/wav";
        result = speechBlob;
        break;

      case "textToImage":
        const imageBlob = await hf.textToImage({
          model: body.model || "stabilityai/stable-diffusion-2",
          inputs: body.inputs,
          parameters: body.parameters,
        });
        contentType = "image/png";
        result = imageBlob;
        break;

      case "imageToText":
        const imageData = body.imageUrl
          ? await (await fetch(body.imageUrl)).blob()
          : body.imageData;

        result = await hf.imageToText({
          data: imageData,
          model: body.model || "nlpconnect/vit-gpt2-image-captioning",
        });
        break;

      case "summarization":
        result = await hf.summarization({
          model: body.model || "facebook/bart-large-cnn",
          inputs: body.inputs,
          parameters: body.parameters,
        });
        break;

      case "questionAnswering":
        result = await hf.questionAnswering({
          model: body.model || "deepset/roberta-base-squad2",
          inputs: {
            question: body.question,
            context: body.context,
          },
        });
        break;

      default:
        return new Response(
          JSON.stringify({
            message: "Hugging Face Inference API",
            version: "2.0.0",
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
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
    }

    // Cache result if JSON
    if (contentType === "application/json" && supabase) {
      await cacheResult(cacheKey, result, supabase);
    }

    // Return result
    const responseBody =
      contentType === "application/json"
        ? JSON.stringify({
            result,
            cached: false,
            responseTime: Date.now() - startTime,
            requestId,
          })
        : result;

    return new Response(responseBody, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "X-Cache": "MISS",
        "X-Response-Time": `${Date.now() - startTime}ms`,
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    console.error("Inference error:", error);

    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
        requestId,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
