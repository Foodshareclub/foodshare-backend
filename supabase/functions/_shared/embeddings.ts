/**
 * Multi-Provider Embedding Generator
 *
 * Production-grade embedding generation with graceful degradation:
 * - Primary: Zep.ai (1536 dimensions, optimized for RAG)
 * - Fallback: HuggingFace Inference API
 *
 * Features:
 * - Circuit breakers per provider
 * - Automatic fallback chain
 * - Request batching for efficiency
 * - Timeout handling with AbortController
 * - Structured logging and metrics
 *
 * @version 1.0.0
 */

import { logger } from "./logger.ts";
import { getCircuitStatus, withCircuitBreaker } from "./circuit-breaker.ts";
import { RETRY_PRESETS, withRetry } from "./retry.ts";

// =============================================================================
// Configuration
// =============================================================================

export interface EmbeddingConfig {
  /** Target embedding dimensions (default: 1536 for Upstash Vector) */
  dimensions: number;
  /** Request timeout in ms (default: 30000) */
  timeoutMs: number;
  /** Enable provider fallback chain (default: true) */
  enableFallback: boolean;
  /** Circuit breaker failure threshold (default: 3) */
  circuitBreakerThreshold: number;
  /** Circuit breaker reset timeout in ms (default: 30000) */
  circuitBreakerResetMs: number;
}

const DEFAULT_CONFIG: EmbeddingConfig = {
  dimensions: 1536,
  timeoutMs: 30000,
  enableFallback: true,
  circuitBreakerThreshold: 3,
  circuitBreakerResetMs: 30000,
};

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingResult {
  embedding: number[];
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  latencyMs: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  latencyMs: number;
}

export type EmbeddingProvider = "zep" | "huggingface";

interface ProviderConfig {
  name: EmbeddingProvider;
  envKey: string;
  model: string;
  dimensions: number;
  maxBatchSize: number;
  endpoint: string;
}

// Provider configurations - ordered by preference
// Zep.ai (primary, if configured) → HuggingFace (free fallback)
const PROVIDERS: ProviderConfig[] = [
  {
    name: "zep",
    envKey: "ZAI_API_KEY",
    model: "zep-1",
    dimensions: 1536,
    maxBatchSize: 100,
    endpoint: "https://api.z.ai/api/v2/embeddings",
  },
  {
    name: "huggingface",
    envKey: "HUGGINGFACE_ACCESS_TOKEN",
    model: "BAAI/bge-small-en-v1.5",
    dimensions: 384, // Will be padded to 1536
    maxBatchSize: 32,
    endpoint: "https://router.huggingface.co/hf-inference/models",
  },
];

// =============================================================================
// Embedding Error
// =============================================================================

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly provider: EmbeddingProvider | "all",
    public readonly code: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

// =============================================================================
// Provider-Specific Implementations
// =============================================================================

async function generateZepEmbedding(
  texts: string[],
  apiKey: string,
  timeoutMs: number,
): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.z.ai/api/v2/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        texts,
        model: "zep-1",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new EmbeddingError(
        `Zep API error: ${response.status} - ${errorText}`,
        "zep",
        `HTTP_${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }

    const data = await response.json();
    return data.embeddings || data.data?.map((d: { embedding: number[] }) => d.embedding);
  } catch (error) {
    clearTimeout(timeout);

    if (error instanceof EmbeddingError) throw error;

    if (error instanceof Error && error.name === "AbortError") {
      throw new EmbeddingError("Zep request timeout", "zep", "TIMEOUT", true);
    }

    throw new EmbeddingError(
      `Zep request failed: ${error instanceof Error ? error.message : String(error)}`,
      "zep",
      "NETWORK_ERROR",
      true,
    );
  }
}

async function generateHuggingFaceEmbedding(
  texts: string[],
  apiKey: string,
  timeoutMs: number,
): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Use BAAI/bge-small-en-v1.5 - a dedicated embedding model (384 dimensions)
    const modelId = "BAAI/bge-small-en-v1.5";
    // Use the new HuggingFace Router endpoint for Inference API
    const response = await fetch(
      `https://router.huggingface.co/hf-inference/models/${modelId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          inputs: texts,
        }),
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new EmbeddingError(
        `HuggingFace API error: ${response.status} - ${errorText}`,
        "huggingface",
        `HTTP_${response.status}`,
        response.status >= 500 || response.status === 429 || response.status === 503,
      );
    }

    const data = await response.json();

    // HuggingFace returns raw embeddings - may need mean pooling for sentence-transformers
    // The output shape can vary: either [[...embeddings...]] or [[[token_embeddings]]]
    const embeddings: number[][] = Array.isArray(data[0][0])
      ? data.map((item: number[][]) => meanPool(item))
      : data;

    return embeddings;
  } catch (error) {
    clearTimeout(timeout);

    if (error instanceof EmbeddingError) throw error;

    if (error instanceof Error && error.name === "AbortError") {
      throw new EmbeddingError("HuggingFace request timeout", "huggingface", "TIMEOUT", true);
    }

    throw new EmbeddingError(
      `HuggingFace request failed: ${error instanceof Error ? error.message : String(error)}`,
      "huggingface",
      "NETWORK_ERROR",
      true,
    );
  }
}

/**
 * Mean pooling for token embeddings
 */
function meanPool(tokenEmbeddings: number[][]): number[] {
  if (tokenEmbeddings.length === 0) return [];

  const dim = tokenEmbeddings[0].length;
  const result = new Array(dim).fill(0);

  for (const embedding of tokenEmbeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += embedding[i];
    }
  }

  const count = tokenEmbeddings.length;
  for (let i = 0; i < dim; i++) {
    result[i] /= count;
  }

  return result;
}

/**
 * Pad or truncate embedding to target dimensions
 */
function normalizeEmbeddingDimensions(embedding: number[], targetDim: number): number[] {
  if (embedding.length === targetDim) {
    return embedding;
  }

  if (embedding.length > targetDim) {
    // Truncate to target dimensions
    return embedding.slice(0, targetDim);
  }

  // Pad with zeros to reach target dimensions
  const padded = [...embedding];
  while (padded.length < targetDim) {
    padded.push(0);
  }
  return padded;
}

// =============================================================================
// Main Embedding Service
// =============================================================================

let config: EmbeddingConfig = { ...DEFAULT_CONFIG };

/**
 * Configure the embedding service
 */
export function configureEmbeddings(options: Partial<EmbeddingConfig>): void {
  config = { ...config, ...options };
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(
  text: string,
  options?: Partial<EmbeddingConfig>,
): Promise<EmbeddingResult> {
  const result = await generateEmbeddings([text], options);
  return {
    embedding: result.embeddings[0],
    provider: result.provider,
    model: result.model,
    dimensions: result.dimensions,
    latencyMs: result.latencyMs,
  };
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function generateEmbeddings(
  texts: string[],
  options?: Partial<EmbeddingConfig>,
): Promise<BatchEmbeddingResult> {
  const effectiveConfig = { ...config, ...options };
  const startTime = performance.now();

  // Sanitize input texts
  const sanitizedTexts = texts.map((t) => sanitizeText(t));

  // Try each provider in the fallback chain
  const errors: Error[] = [];

  for (const provider of PROVIDERS) {
    const apiKey = Deno.env.get(provider.envKey);

    if (!apiKey) {
      logger.debug(`Skipping ${provider.name}: API key not configured`);
      continue;
    }

    try {
      const embeddings = await withCircuitBreaker(
        `embedding-${provider.name}`,
        async () => {
          return await withRetry(
            async () => {
              switch (provider.name) {
                case "zep":
                  return await generateZepEmbedding(
                    sanitizedTexts,
                    apiKey,
                    effectiveConfig.timeoutMs,
                  );
                case "huggingface":
                  return await generateHuggingFaceEmbedding(
                    sanitizedTexts,
                    apiKey,
                    effectiveConfig.timeoutMs,
                  );
                default:
                  throw new Error(`Unknown provider: ${provider.name}`);
              }
            },
            {
              ...RETRY_PRESETS.quick,
              maxRetries: 2,
              shouldRetry: (error) => {
                return error instanceof EmbeddingError && error.retryable;
              },
            },
          );
        },
        {
          failureThreshold: effectiveConfig.circuitBreakerThreshold,
          resetTimeoutMs: effectiveConfig.circuitBreakerResetMs,
        },
      );

      // Normalize dimensions if needed
      const normalizedEmbeddings = embeddings.map((e) =>
        normalizeEmbeddingDimensions(e, effectiveConfig.dimensions)
      );

      const latencyMs = Math.round(performance.now() - startTime);

      logger.info(`Embeddings generated via ${provider.name}`, {
        provider: provider.name,
        count: texts.length,
        latencyMs,
        dimensions: effectiveConfig.dimensions,
      });

      return {
        embeddings: normalizedEmbeddings,
        provider: provider.name,
        model: provider.model,
        dimensions: effectiveConfig.dimensions,
        latencyMs,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      logger.warn(`Embedding provider ${provider.name} failed`, {
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!effectiveConfig.enableFallback) {
        throw error;
      }
    }
  }

  // All providers failed
  const latencyMs = Math.round(performance.now() - startTime);
  logger.error("All embedding providers failed", new Error("Embedding generation failed"), {
    latencyMs,
    textCount: texts.length,
    errors: errors.map((e) => e.message),
  });

  throw new EmbeddingError(
    `All embedding providers failed: ${errors.map((e) => e.message).join("; ")}`,
    "all",
    "ALL_PROVIDERS_FAILED",
    false,
  );
}

/**
 * Sanitize text for embedding
 * - Remove excessive whitespace
 * - Truncate to reasonable length
 * - Remove null bytes
 */
function sanitizeText(text: string): string {
  return text
    .replace(/\0/g, "") // Remove null bytes
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim()
    .slice(0, 8192); // Max 8K characters
}

/**
 * Get health status of embedding providers
 */
export function getEmbeddingHealth(): Record<
  EmbeddingProvider,
  {
    configured: boolean;
    circuitState: string;
    healthy: boolean;
  }
> {
  const result: Record<
    EmbeddingProvider,
    { configured: boolean; circuitState: string; healthy: boolean }
  > = {} as Record<
    EmbeddingProvider,
    { configured: boolean; circuitState: string; healthy: boolean }
  >;

  for (const provider of PROVIDERS) {
    const apiKey = Deno.env.get(provider.envKey);
    const circuitStatus = getCircuitStatus(`embedding-${provider.name}`);

    result[provider.name] = {
      configured: !!apiKey,
      circuitState: circuitStatus?.state || "closed",
      healthy: !!apiKey && (circuitStatus?.state || "closed") !== "open",
    };
  }

  return result;
}

/**
 * Get the first available (healthy) provider
 */
export function getActiveProvider(): EmbeddingProvider | null {
  for (const provider of PROVIDERS) {
    const apiKey = Deno.env.get(provider.envKey);
    const circuitStatus = getCircuitStatus(`embedding-${provider.name}`);

    if (apiKey && circuitStatus?.state !== "open") {
      return provider.name;
    }
  }

  return null;
}
