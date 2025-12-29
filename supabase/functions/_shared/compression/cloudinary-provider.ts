/**
 * Cloudinary Compression Provider
 *
 * Cloud-based image transformation and optimization.
 * Best for: Adaptive quality, format conversion, advanced transformations.
 *
 * API Docs: https://cloudinary.com/documentation/image_upload_api_reference
 *
 * Features:
 * - Auto format selection (WebP, AVIF)
 * - Adaptive quality (auto:good, auto:eco, auto:low)
 * - On-the-fly transformations
 * - 25 credits/month on free plan
 */

import {
  CompressionProvider,
  CompressionProviderName,
  CompressParams,
  CompressResult,
  ProviderHealth,
  ProviderQuota,
  CloudinaryConfig,
  PROVIDER_LIMITS,
} from "./types.ts";

const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 20000;

interface CloudinaryUploadResponse {
  public_id: string;
  secure_url: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
}

interface CloudinaryAccountResponse {
  credits?: { usage?: number; used_percent?: number; limit?: number };
  plan?: string;
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
 * Generate SHA-1 signature for Cloudinary API
 */
async function createSignature(params: Record<string, string>, secret: string): Promise<string> {
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

  const data = new TextEncoder().encode(sortedParams + secret);
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a short UUID for temporary public IDs
 */
function generateShortId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cloudinary Compression Provider Implementation
 */
export class CloudinaryProvider implements CompressionProvider {
  readonly name: CompressionProviderName = "cloudinary";
  private config: CloudinaryConfig;
  private quota: ProviderQuota;

  constructor(config?: Partial<CloudinaryConfig>) {
    this.config = {
      cloudName: config?.cloudName || Deno.env.get("CLOUDINARY_CLOUD_NAME") || "",
      apiKey: config?.apiKey || Deno.env.get("CLOUDINARY_API_KEY") || "",
      apiSecret: config?.apiSecret || Deno.env.get("CLOUDINARY_API_SECRET") || "",
    };

    const limits = PROVIDER_LIMITS.cloudinary;
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
    return !!(this.config.cloudName && this.config.apiKey && this.config.apiSecret);
  }

  /**
   * Get API base URL
   */
  private getApiUrl(endpoint: string): string {
    return `https://api.cloudinary.com/v1_1/${this.config.cloudName}/${endpoint}`;
  }

  /**
   * Compress image via Cloudinary
   */
  async compress(params: CompressParams): Promise<CompressResult> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      throw new Error("Cloudinary credentials not configured");
    }

    if (this.quota.exhausted) {
      throw new Error("Cloudinary quota exhausted");
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const publicId = `temp_${generateShortId()}`;
    const transformation = `q_auto:${params.quality},f_auto,w_${params.targetWidth},c_limit`;

    // Generate signature
    const signature = await createSignature(
      {
        public_id: publicId,
        timestamp,
        transformation,
      },
      this.config.apiSecret
    );

    // Build form data for upload
    const formData = new FormData();
    formData.append("file", new Blob([params.imageData], { type: "image/jpeg" }));
    formData.append("api_key", this.config.apiKey);
    formData.append("timestamp", timestamp);
    formData.append("signature", signature);
    formData.append("public_id", publicId);
    formData.append("transformation", transformation);

    // Upload and transform
    const uploadResponse = await fetchWithTimeout(
      this.getApiUrl("image/upload"),
      { method: "POST", body: formData },
      REQUEST_TIMEOUT_MS
    );

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(
        `Cloudinary upload failed (${uploadResponse.status}): ${errorText.slice(0, 100)}`
      );
    }

    const uploadResult: CloudinaryUploadResponse = await uploadResponse.json();

    // Download the transformed image
    const downloadResponse = await fetchWithTimeout(
      uploadResult.secure_url,
      { method: "GET" },
      DOWNLOAD_TIMEOUT_MS
    );

    if (!downloadResponse.ok) {
      throw new Error(`Cloudinary download failed: ${downloadResponse.status}`);
    }

    const buffer = new Uint8Array(await downloadResponse.arrayBuffer());
    const latencyMs = Math.round(performance.now() - startTime);

    // Cleanup uploaded image (fire and forget)
    this.cleanupImage(publicId);

    return {
      buffer,
      method: `cloudinary@${params.targetWidth}px`,
      provider: this.name,
      quality: params.quality,
      latencyMs,
    };
  }

  /**
   * Delete temporary image from Cloudinary (fire and forget)
   */
  private cleanupImage(publicId: string): void {
    (async () => {
      try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = await createSignature(
          { public_id: publicId, timestamp },
          this.config.apiSecret
        );

        const formData = new FormData();
        formData.append("public_id", publicId);
        formData.append("api_key", this.config.apiKey);
        formData.append("timestamp", timestamp);
        formData.append("signature", signature);

        await fetch(this.getApiUrl("image/destroy"), {
          method: "POST",
          body: formData,
        });
      } catch {
        // Ignore cleanup errors
      }
    })();
  }

  /**
   * Check provider health by fetching account usage
   */
  async checkHealth(): Promise<ProviderHealth> {
    const startTime = performance.now();

    if (!this.isConfigured()) {
      return {
        provider: this.name,
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "Cloudinary credentials not configured",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    try {
      const auth = btoa(`${this.config.apiKey}:${this.config.apiSecret}`);

      const response = await fetchWithTimeout(
        this.getApiUrl("usage"),
        {
          method: "GET",
          headers: { Authorization: `Basic ${auth}` },
        },
        10000
      );

      const latencyMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        return {
          provider: this.name,
          status: "error",
          healthScore: 0,
          latencyMs,
          message: `API error: HTTP ${response.status}`,
          configured: true,
          lastChecked: Date.now(),
        };
      }

      const data: CloudinaryAccountResponse = await response.json();
      const usedPercent = data.credits?.used_percent || 0;

      // Update quota
      if (data.credits) {
        this.quota.percentUsed = usedPercent;
        this.quota.exhausted = usedPercent >= 100;
        this.quota.lastChecked = Date.now();
      }

      // Calculate health score
      let healthScore = 100;
      if (latencyMs > 2000) healthScore -= 30;
      else if (latencyMs > 1000) healthScore -= 15;
      else if (latencyMs > 500) healthScore -= 5;

      if (usedPercent >= 90) healthScore -= 30;
      else if (usedPercent >= 75) healthScore -= 15;

      return {
        provider: this.name,
        status: healthScore >= 70 ? "ok" : usedPercent >= 100 ? "error" : "degraded",
        healthScore,
        latencyMs,
        message: `Connected. Credits used: ${usedPercent.toFixed(1)}%. Plan: ${data.plan || "unknown"}`,
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
   * Update quota (from usage API)
   */
  updateQuota(usedPercent: number): void {
    const limits = PROVIDER_LIMITS.cloudinary;
    const used = Math.round((usedPercent / 100) * limits.monthly);

    this.quota = {
      provider: this.name,
      used,
      limit: limits.monthly,
      remaining: limits.monthly - used,
      percentUsed: usedPercent,
      lastChecked: Date.now(),
      exhausted: usedPercent >= 100,
    };
  }

  /**
   * Get debug info (masked credentials)
   */
  getDebugInfo(): Record<string, unknown> {
    return {
      provider: this.name,
      configured: this.isConfigured(),
      cloudName: this.config.cloudName || "not set",
      apiKeyPrefix: this.config.apiKey ? this.config.apiKey.slice(0, 6) + "..." : "not set",
      quota: this.quota,
    };
  }
}

/**
 * Create Cloudinary provider from environment
 */
export function createCloudinaryProvider(config?: Partial<CloudinaryConfig>): CloudinaryProvider {
  return new CloudinaryProvider(config);
}
