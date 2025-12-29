/**
 * Compression Service
 *
 * Orchestrates multiple compression providers with:
 * - Circuit breaker pattern for resilience
 * - Provider racing for best performance
 * - Request deduplication
 * - Automatic failover
 * - Metrics tracking
 */

import {
  CompressionProvider,
  CompressionProviderName,
  CompressParams,
  CompressResult,
  CompressionServiceConfig,
  CircuitBreakerState,
  CircuitState,
  ProviderHealth,
  ProviderQuota,
  DEFAULT_COMPRESSION_CONFIG,
  LogLevel,
} from "./types.ts";
import { TinyPNGProvider, createTinyPNGProvider } from "./tinypng-provider.ts";
import { CloudinaryProvider, createCloudinaryProvider } from "./cloudinary-provider.ts";

// ============================================================================
// Types
// ============================================================================

interface RaceOutcome {
  success: boolean;
  result?: CompressResult;
  error?: string;
  provider: CompressionProviderName;
  timeMs: number;
}

interface ServiceMetrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsFailed: number;
  bytesProcessed: number;
  bytesSaved: number;
  avgLatencyMs: number;
  compressionsByProvider: Record<CompressionProviderName, number>;
  startTime: number;
}

// ============================================================================
// Logging
// ============================================================================

function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else if (level !== "debug") console.log(JSON.stringify(entry));
}

// ============================================================================
// Compression Service
// ============================================================================

export class CompressionService {
  private providers: Map<CompressionProviderName, CompressionProvider> = new Map();
  private circuits: Map<CompressionProviderName, CircuitBreakerState> = new Map();
  private inFlightRequests: Map<string, Promise<CompressResult>> = new Map();
  private config: CompressionServiceConfig;
  private metrics: ServiceMetrics;

  constructor(config: Partial<CompressionServiceConfig> = {}) {
    this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...config };

    this.metrics = {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsFailed: 0,
      bytesProcessed: 0,
      bytesSaved: 0,
      avgLatencyMs: 0,
      compressionsByProvider: { tinypng: 0, cloudinary: 0 },
      startTime: Date.now(),
    };

    // Initialize providers
    this.initializeProviders();
  }

  /**
   * Initialize all providers from environment
   */
  private initializeProviders(): void {
    // TinyPNG
    const tinypng = createTinyPNGProvider();
    if (tinypng.isConfigured()) {
      this.providers.set("tinypng", tinypng);
      this.initCircuit("tinypng");
    }

    // Cloudinary
    const cloudinary = createCloudinaryProvider();
    if (cloudinary.isConfigured()) {
      this.providers.set("cloudinary", cloudinary);
      this.initCircuit("cloudinary");
    }
  }

  /**
   * Initialize circuit breaker for a provider
   */
  private initCircuit(provider: CompressionProviderName): void {
    this.circuits.set(provider, {
      state: "closed",
      failures: 0,
      lastFailureTime: 0,
      halfOpenAttempts: 0,
      consecutiveSuccesses: 0,
    });
  }

  /**
   * Get circuit state, transitioning from open to half-open if timeout elapsed
   */
  private getCircuitState(provider: CompressionProviderName): CircuitState {
    const circuit = this.circuits.get(provider);
    if (!circuit) return "closed";

    if (
      circuit.state === "open" &&
      Date.now() - circuit.lastFailureTime >= this.config.circuitBreaker.resetTimeoutMs
    ) {
      circuit.state = "half-open";
      circuit.halfOpenAttempts = 0;
      circuit.consecutiveSuccesses = 0;
      log("info", "Circuit half-open", { provider });
    }

    return circuit.state;
  }

  /**
   * Record successful operation for circuit breaker
   */
  private recordSuccess(provider: CompressionProviderName): void {
    const circuit = this.circuits.get(provider);
    if (!circuit) return;

    circuit.consecutiveSuccesses++;
    circuit.failures = 0;

    if (
      circuit.state === "half-open" &&
      circuit.consecutiveSuccesses >= this.config.circuitBreaker.successesToClose
    ) {
      circuit.state = "closed";
      log("info", "Circuit recovered", { provider });
    } else if (circuit.state !== "closed") {
      circuit.state = "closed";
    }
  }

  /**
   * Record failure for circuit breaker
   */
  private recordFailure(provider: CompressionProviderName): void {
    const circuit = this.circuits.get(provider);
    if (!circuit) return;

    circuit.failures++;
    circuit.consecutiveSuccesses = 0;
    circuit.lastFailureTime = Date.now();

    if (
      circuit.state === "half-open" ||
      circuit.failures >= this.config.circuitBreaker.failureThreshold
    ) {
      circuit.state = "open";
      log("warn", "Circuit opened", { provider, failures: circuit.failures });
    }
  }

  /**
   * Check if provider can be attempted
   */
  private canAttempt(provider: CompressionProviderName): boolean {
    const state = this.getCircuitState(provider);
    if (state === "closed") return true;
    if (state === "open") return false;

    // Half-open: allow limited attempts
    const circuit = this.circuits.get(provider);
    if (circuit && circuit.halfOpenAttempts < this.config.circuitBreaker.halfOpenMaxAttempts) {
      circuit.halfOpenAttempts++;
      return true;
    }
    return false;
  }

  /**
   * Get quality settings based on file size
   */
  getQualitySettings(size: number): { quality: string; width: number } {
    for (const tier of this.config.qualityTiers) {
      if (size <= tier.maxSize) {
        return { quality: tier.quality, width: tier.width };
      }
    }
    return { quality: "low", width: 600 };
  }

  /**
   * Retry wrapper with exponential backoff
   */
  private async withRetry<T>(fn: () => Promise<T>, provider: CompressionProviderName): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));

        if (attempt < this.config.maxRetries) {
          const delay = Math.min(
            this.config.retryDelayMs * Math.pow(2, attempt - 1),
            this.config.maxRetryDelayMs
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError || new Error(`${provider} failed after ${this.config.maxRetries} attempts`);
  }

  /**
   * Wrap provider attempt for racing
   */
  private async wrapAttempt(
    provider: CompressionProvider,
    params: CompressParams,
    startTime: number
  ): Promise<RaceOutcome> {
    try {
      const result = await this.withRetry(() => provider.compress(params), provider.name);
      this.recordSuccess(provider.name);

      return {
        success: true,
        result,
        provider: provider.name,
        timeMs: Date.now() - startTime,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.recordFailure(provider.name);

      return {
        success: false,
        error,
        provider: provider.name,
        timeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Race multiple providers, return first success
   */
  private async raceProviders(
    attempts: Promise<RaceOutcome>[]
  ): Promise<
    { success: true; result: CompressResult; timeMs: number } | { success: false; errors: string[] }
  > {
    if (!attempts.length) {
      return { success: false, errors: ["No providers available"] };
    }

    const errors: string[] = [];
    let resolved = 0;
    let hasWinner = false;

    return new Promise((resolve) => {
      attempts.forEach((attempt) =>
        attempt.then((outcome) => {
          resolved++;

          if (outcome.success && !hasWinner && outcome.result) {
            hasWinner = true;
            resolve({ success: true, result: outcome.result, timeMs: outcome.timeMs });
          } else if (!outcome.success) {
            errors.push(`${outcome.provider}: ${outcome.error}`);

            if (resolved === attempts.length && !hasWinner) {
              resolve({ success: false, errors });
            }
          }
        })
      );
    });
  }

  /**
   * Compress an image using available providers
   */
  async compress(imageData: Uint8Array, dedupeKey?: string): Promise<CompressResult> {
    // Deduplication: return in-flight request if exists
    if (dedupeKey && this.inFlightRequests.has(dedupeKey)) {
      return this.inFlightRequests.get(dedupeKey)!;
    }

    const compressionPromise = this.doCompress(imageData);

    // Track in-flight request
    if (dedupeKey) {
      this.inFlightRequests.set(dedupeKey, compressionPromise);
      compressionPromise.finally(() => this.inFlightRequests.delete(dedupeKey));
    }

    return compressionPromise;
  }

  /**
   * Internal compression logic
   */
  private async doCompress(imageData: Uint8Array): Promise<CompressResult> {
    const startTime = Date.now();
    const { quality, width } = this.getQualitySettings(imageData.length);

    const params: CompressParams = {
      imageData,
      targetWidth: width,
      quality,
    };

    // Build list of available providers
    const attempts: Promise<RaceOutcome>[] = [];

    for (const providerName of this.config.providerPriority) {
      const provider = this.providers.get(providerName);
      if (provider && this.canAttempt(providerName)) {
        attempts.push(this.wrapAttempt(provider, params, startTime));
      }
    }

    if (!attempts.length) {
      throw new Error("No compression providers available (all circuits open or unconfigured)");
    }

    // Race providers
    const outcome = await this.raceProviders(attempts);

    if (outcome.success) {
      // Update metrics
      this.metrics.requestsTotal++;
      this.metrics.requestsSuccess++;
      this.metrics.bytesProcessed += imageData.length;
      this.metrics.bytesSaved += imageData.length - outcome.result.buffer.length;
      this.metrics.compressionsByProvider[outcome.result.provider]++;
      this.metrics.avgLatencyMs = this.metrics.avgLatencyMs * 0.9 + outcome.result.latencyMs * 0.1;

      log("info", "Compression complete", {
        provider: outcome.result.provider,
        method: outcome.result.method,
        inputSize: imageData.length,
        outputSize: outcome.result.buffer.length,
        savedPercent: ((1 - outcome.result.buffer.length / imageData.length) * 100).toFixed(0),
        latencyMs: outcome.result.latencyMs,
      });

      return outcome.result;
    }

    // All providers failed
    this.metrics.requestsTotal++;
    this.metrics.requestsFailed++;

    throw new Error(`All compression providers failed: ${outcome.errors.join("; ")}`);
  }

  /**
   * Check health of all providers
   */
  async checkHealth(): Promise<Record<CompressionProviderName, ProviderHealth>> {
    const results: Record<string, ProviderHealth> = {};

    for (const [name, provider] of this.providers) {
      results[name] = await provider.checkHealth();
    }

    // Add unconfigured providers
    if (!this.providers.has("tinypng")) {
      results.tinypng = {
        provider: "tinypng",
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "TINIFY_API_KEY not set",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    if (!this.providers.has("cloudinary")) {
      results.cloudinary = {
        provider: "cloudinary",
        status: "unconfigured",
        healthScore: 0,
        latencyMs: 0,
        message: "Cloudinary credentials not set",
        configured: false,
        lastChecked: Date.now(),
      };
    }

    return results as Record<CompressionProviderName, ProviderHealth>;
  }

  /**
   * Get quotas for all providers
   */
  getQuotas(): Record<CompressionProviderName, ProviderQuota> {
    const results: Record<string, ProviderQuota> = {};

    for (const [name, provider] of this.providers) {
      results[name] = provider.getQuota();
    }

    return results as Record<CompressionProviderName, ProviderQuota>;
  }

  /**
   * Get circuit breaker states
   */
  getCircuits(): Record<CompressionProviderName, { state: CircuitState; failures: number }> {
    const results: Record<string, { state: CircuitState; failures: number }> = {};

    for (const [name] of this.circuits) {
      results[name] = {
        state: this.getCircuitState(name),
        failures: this.circuits.get(name)?.failures || 0,
      };
    }

    return results as Record<CompressionProviderName, { state: CircuitState; failures: number }>;
  }

  /**
   * Get service metrics
   */
  getMetrics(): ServiceMetrics & { uptime: number } {
    return {
      ...this.metrics,
      uptime: Date.now() - this.metrics.startTime,
    };
  }

  /**
   * Get configured providers
   */
  getConfiguredProviders(): CompressionProviderName[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Check if any provider is available
   */
  hasAvailableProvider(): boolean {
    for (const name of this.providers.keys()) {
      if (this.canAttempt(name)) return true;
    }
    return false;
  }

  /**
   * Get debug info for all providers
   */
  getDebugInfo(): Record<CompressionProviderName, Record<string, unknown>> {
    const results: Record<string, Record<string, unknown>> = {};

    for (const [name, provider] of this.providers) {
      results[name] = provider.getDebugInfo();
    }

    return results as Record<CompressionProviderName, Record<string, unknown>>;
  }
}

/**
 * Create compression service from environment
 */
export function createCompressionService(
  config?: Partial<CompressionServiceConfig>
): CompressionService {
  return new CompressionService(config);
}

// Export providers for direct use if needed
export { TinyPNGProvider, CloudinaryProvider };
export { createTinyPNGProvider, createCloudinaryProvider };
