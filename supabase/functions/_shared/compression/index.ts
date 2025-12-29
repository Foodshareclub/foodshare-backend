/**
 * Compression Module - Public API
 *
 * Modular image compression system with multiple provider support.
 *
 * Usage:
 * ```typescript
 * import { createCompressionService } from "../_shared/compression/index.ts";
 *
 * const service = createCompressionService();
 * const result = await service.compress(imageData, "dedupe-key");
 * ```
 */

// Types
export type {
  CompressionProvider,
  CompressionProviderName,
  CompressParams,
  CompressResult,
  CompressionResult,
  ProviderHealth,
  ProviderQuota,
  CompressionServiceConfig,
  CircuitBreakerState,
  CircuitState,
  QualityTier,
  TinyPNGConfig,
  CloudinaryConfig,
  ProviderConfigs,
  ErrorType,
  LogLevel,
  BatchItem,
  BatchResult,
} from "./types.ts";

// Constants
export { DEFAULT_COMPRESSION_CONFIG, PROVIDER_LIMITS } from "./types.ts";

// Providers
export { TinyPNGProvider, createTinyPNGProvider } from "./tinypng-provider.ts";
export { CloudinaryProvider, createCloudinaryProvider } from "./cloudinary-provider.ts";

// Service
export { CompressionService, createCompressionService } from "./compression-service.ts";
