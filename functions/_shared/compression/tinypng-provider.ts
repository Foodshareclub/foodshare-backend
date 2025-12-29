/**
 * TinyPNG Compression Provider
 *
 * High-quality image compression using TinyPNG/TinyJPG API.
 * Best for: PNG and JPEG compression with excellent quality retention.
 *
 * API Docs: https://tinypng.com/developers/reference
 *
 * Features:
 * - Smart lossy compression
 * - Resize with fit/scale/cover methods
 * - Preserves transparency
 * - 500 free compressions/month
 */

import {
  CompressionProvider,
  CompressionProviderName,
  CompressParams,
  CompressResult,
  ProviderHealth,
  ProviderQuota,
  TinyPNGConfig,
  PROVIDER_LIMITS,
} from "./types.ts";

const TINYPNG_API_BASE = "https://api.tinify.com";
const REQUEST_TIMEOUT_MS = 30000;

interface TinyPNGShrinkResponse {
  input: { size: number; type: string };
  output: { size: number; type: string; width: number; height: number; ratio: number; url: string };
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * TinyPNG Compression Provider Implementation
 */
export class TinyPNGProvider implements CompressionProvider {
  readonly name: CompressionProviderName = "tinypng";
  private config: TinyPNGConfig;
  private quota: ProviderQuota;

  constructor(config?: Partial<TinyPNGConfig>) {
    this.config = {
      apiKey: config?.apiKey || Deno.env.get("TINIFY_API_KEY") || "",
    };

    const limits = PROVIDER_LIMITS.tinypng;
    this.quota = {
      provider: this.name,
      used: 0,
      limit: limits.monthly,
      remaining: limits.monthly,
      percentUsed: 0,
      lastChecked: 0,
      exhausted: false,
    };
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  /**
   * Get authorization header
   */
  private getAuthHeader(): string {
    return "Basic " + btoa(`api:${this.config.apiKey}`);
  }

  /**
   * Compress image via TinyPNG API
   */
  async compress(params: CompressParams): Promise<CompressResult> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      throw new Error("TinyPNG API key not configured");
    }

    if (this.quota.exhausted) {
      throw new Error("TinyPNG quota exhausted");
    }

    const auth = this.getAuthHeader();

    // Step 1: Compress the image
    const compressResponse = await fetchWithTimeout(
      `${TINYPNG_API_BASE}/shrink`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: params.imageData,
      },
      REQUEST_TIMEOUT_MS
    );

    // Update quota from response headers
    const compressionCount = compressResponse.headers.get("Compression-Count");
    if (compressionCount) {
      this.updateQuota(parseInt(compressionCount, 10));
    }

    if (!compressResponse.ok) {
      if (compressResponse.status === 429) {
        this.quota.exhausted = true;
        throw new Error("TinyPNG rate limited - quota exhausted");
      }
      const errorText = await compressResponse.text();
      throw new Error(
        `TinyPNG compression failed (${compressResponse.status}): ${errorText.slice(0, 100)}`
      );
    }

    const shrinkResult: TinyPNGShrinkResponse = await compressResponse.json();

    // Step 2: Resize the compressed image
    let finalBuffer: Uint8Array;
    let method = "tinypng";

    try {
      const resizeResponse = await fetchWithTimeout(
        shrinkResult.output.url,
        {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            resize: {
              method: "fit",
              width: params.targetWidth,
              height: params.targetWidth,
            },
          }),
        },
        REQUEST_TIMEOUT_MS
      );

      if (resizeResponse.ok) {
        finalBuffer = new Uint8Array(await resizeResponse.arrayBuffer());
        method = `tinypng@${params.targetWidth}px`;
      } else {
        // Fallback: download compressed without resize
        const downloadResponse = await fetch(shrinkResult.output.url, {
          headers: { Authorization: auth },
        });
        finalBuffer = new Uint8Array(await downloadResponse.arrayBuffer());
      }
    } catch {
      // Fallback: download compressed without resize
      const downloadResponse = await fetch(shrinkResult.output.url, {
        headers: { Authorization: auth },
      });
      finalBuffer = new Uint8Array(await downloadResponse.arrayBuffer());
    }

    const latencyMs = Math.round(performance.now() - startTime);

    return {
      buffer: finalBuffer,
      method,
      provider: this.name,
      quality: params.quality,
      latencyMs,
    };
  }

  /**
   * Check provider health by making a minimal API call
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "TINIFY_API_KEY not configured",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      // Make a minimal request to check API connectivity
      // Using an empty body will fail but return quota info
      const response = await fetchWithTimeout(
        `${TINYPNG_API_BASE}/shrink`,
        {
          method: "POST",
          headers: { Authorization: this.getAuthHeader() },
          body: new Uint8Array(0),
        },
        10000
      );

      const latencyMs = Math.round(performance.now() - startTime);

      // Update quota from response
      const compressionCount = response.headers.get("Compression-Count");
      if (compressionCount) {
        this.updateQuota(parseInt(compressionCount, 10));
      }

      // 400 is expected for empty body, but confirms API is reachable
      if (response.status === 400 || response.status === 415) {
        let healthScore = 100;
        if (latencyMs > 2000) healthScore -= 30;
        else if (latencyMs > 1000) healthScore -= 15;
        else if (latencyMs > 500) healthScore -= 5;

        if (this.quota.percentUsed > 90) healthScore -= 20;
        else if (this.quota.percentUsed > 75) healthScore -= 10;

        return {
          provider: this.name,
          status: healthScore >= 70 ? "ok" : "degraded",
          healthScore,
          latencyMs,
          message: `Connected. Used: ${this.quota.used}/${this.quota.limit} (${this.quota.percentUsed.toFixed(0)}%)`,
          configured: true,
          lastChecked: Date.now(),
        };
      }

      if (response.status === 429) {
        this.quota.exhausted = true;
        return {
          provider: this.name,
          status: "error",
          healthScore: 0,
          latencyMs,
          message: "Quota exhausted",
          configured: true,
          lastChecked: Date.now(),
        };
      }

      return {
        provider: this.name,
        status: "error",
        healthScore: 0,
        latencyMs,
        message: `Unexpected status: ${response.status}`,
        configured: true,
        lastChecked: Date.now(),
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startTime);
      const message =
        error instanceof Error
          ? error.name === "AbortError"
            ? "Request timeout (10s)"
            : error.message
          : "Unknown error";

      return {
        provider: this.name,
        status: "error",
        healthScore: 0,
        latencyMs,
        message,
        configured: true,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Get current quota
   */
  getQuota(): ProviderQuota {
    return { ...this.quota };
  }

  /**
   * Update quota from API response
   */
  updateQuota(used: number): void {
    const limits = PROVIDER_LIMITS.tinypng;
    this.quota = {
      provider: this.name,
      used,
      limit: limits.monthly,
      remaining: limits.monthly - used,
      percentUsed: (used / limits.monthly) * 100,
      lastChecked: Date.now(),
      exhausted: used >= limits.monthly,
    };
  }

  /**
   * Get debug info (masked credentials)
   */
  getDebugInfo(): Record<string, unknown> {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.slice(0, 8) + "..." : "not set",
      quota: this.quota,
      apiBase: TINYPNG_API_BASE,
    };
  }
}

/**
 * Create TinyPNG provider from environment
 */
export function createTinyPNGProvider(config?: Partial<TinyPNGConfig>): TinyPNGProvider {
  return new TinyPNGProvider(config);
}
