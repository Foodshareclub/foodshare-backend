/**
 * Image Compression Provider Types & Interfaces
 *
 * Shared type definitions for the compression provider system.
 * Follows the same pattern as email providers for consistency.
 */

// ============================================================================
// Core Types
// ============================================================================

export type CompressionProviderName = "tinypng" | "cloudinary";

export type CircuitState = "closed" | "open" | "half-open";

export type ErrorType =
  | "timeout"
  | "quota"
  | "validation"
  | "network"
  | "service"
  | "orphan"
  | "unknown";

// ============================================================================
// Compression Params & Results
// ============================================================================

export interface CompressParams {
  /** Image data to compress */
  imageData: Uint8Array;
  /** Target width for resizing */
  targetWidth: number;
  /** Quality setting (provider-specific) */
  quality: string;
  /** Optional deduplication key */
  dedupeKey?: string;
}

export interface CompressResult {
  /** Compressed image buffer */
  buffer: Uint8Array;
  /** Compression method used (e.g., "tinypng@800px") */
  method: string;
  /** Provider that performed compression */
  provider: CompressionProviderName;
  /** Quality setting used */
  quality?: string;
  /** Processing time in ms */
  latencyMs: number;
}

export interface CompressionResult {
  success: boolean;
  originalPath: string;
  compressedPath?: string;
  originalSize: number;
  compressedSize?: number;
  compressedFormat?: string;
  compressionMethod?: string;
  processingTimeMs: number;
  error?: string;
  errorType?: ErrorType;
}

// ============================================================================
// Provider Health & Quota
// ============================================================================

export interface ProviderHealth {
  provider: CompressionProviderName;
  status: "ok" | "degraded" | "error" | "unconfigured";
  healthScore: number; // 0-100
  latencyMs: number;
  message: string;
  configured: boolean;
  lastChecked: number;
}

export interface ProviderQuota {
  provider: CompressionProviderName;
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  lastChecked: number;
  exhausted: boolean;
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface CompressionProvider {
  /** Provider identifier */
  readonly name: CompressionProviderName;

  /** Check if provider is configured with required credentials */
  isConfigured(): boolean;

  /** Compress an image */
  compress(params: CompressParams): Promise<CompressResult>;

  /** Check provider health/connectivity */
  checkHealth(): Promise<ProviderHealth>;

  /** Get current quota usage */
  getQuota(): ProviderQuota;

  /** Update quota from response headers or API */
  updateQuota(used: number): void;

  /** Get debug info (masked credentials) */
  getDebugInfo(): Record<string, unknown>;
}

// ============================================================================
// Provider Configurations
// ============================================================================

export interface TinyPNGConfig {
  apiKey: string;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface ProviderConfigs {
  tinypng?: TinyPNGConfig;
  cloudinary?: CloudinaryConfig;
}

// ============================================================================
// Circuit Breaker
// ============================================================================

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
  consecutiveSuccesses: number;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
  successesToClose: number;
}

// ============================================================================
// Service Configuration
// ============================================================================

export interface CompressionServiceConfig {
  /** Provider priority order */
  providerPriority: CompressionProviderName[];
  /** Request timeout in ms */
  timeoutMs: number;
  /** Download timeout in ms */
  downloadTimeoutMs: number;
  /** Max retry attempts */
  maxRetries: number;
  /** Base retry delay in ms */
  retryDelayMs: number;
  /** Max retry delay in ms */
  maxRetryDelayMs: number;
  /** Circuit breaker config */
  circuitBreaker: CircuitBreakerConfig;
  /** Quality tiers based on file size */
  qualityTiers: QualityTier[];
  /** Skip threshold - files smaller than this are skipped */
  skipThreshold: number;
}

export interface QualityTier {
  maxSize: number;
  quality: string;
  width: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_COMPRESSION_CONFIG: CompressionServiceConfig = {
  providerPriority: ["tinypng", "cloudinary"],
  timeoutMs: 30000,
  downloadTimeoutMs: 20000,
  maxRetries: 2,
  retryDelayMs: 1000,
  maxRetryDelayMs: 5000,
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    halfOpenMaxAttempts: 1,
    successesToClose: 2,
  },
  qualityTiers: [
    { maxSize: 500 * 1024, quality: "good", width: 1000 },
    { maxSize: 1024 * 1024, quality: "eco", width: 900 },
    { maxSize: 3 * 1024 * 1024, quality: "eco", width: 800 },
    { maxSize: 5 * 1024 * 1024, quality: "low", width: 700 },
    { maxSize: Infinity, quality: "low", width: 600 },
  ],
  skipThreshold: 100 * 1024, // 100KB
};

// ============================================================================
// Provider Limits
// ============================================================================

export const PROVIDER_LIMITS: Record<
  CompressionProviderName,
  { monthly: number; warningThreshold: number }
> = {
  tinypng: { monthly: 500, warningThreshold: 450 },
  cloudinary: { monthly: 25, warningThreshold: 22 }, // Credits
};

// ============================================================================
// Utility Types
// ============================================================================

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface BatchItem {
  bucket: string;
  path: string;
  size: number;
}

export interface BatchResult {
  processed: number;
  failed: number;
  skipped: number;
  orphaned: number;
  results: CompressionResult[];
  totalSavedBytes: number;
  avgTimeMs: number;
}
