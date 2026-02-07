/**
 * Enterprise-Grade LLM Translation Service
 *
 * Production-ready translation service with:
 * - 5-tier fallback: Self-hosted LLM → DeepL → Google → Microsoft → Amazon
 * - Per-service circuit breakers with half-open state
 * - Retry budget to prevent cascading failures
 * - Request deadlines for timeout guarantees
 * - Structured JSON logging with request correlation
 * - LRU cache with TTL and request coalescing
 * - Fail-safe quota enforcement
 * - Comprehensive health monitoring
 *
 * @version 2.0.0 - Enterprise Grade
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/** Supported languages (28 total) */
const SUPPORTED_LANGUAGES = [
  'en', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh',
  'ar', 'nl', 'pl', 'tr', 'uk', 'cs', 'da', 'fi', 'el', 'hu',
  'id', 'no', 'ro', 'sk', 'sv', 'th', 'vi', 'hi'
] as const;

type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

/** Translation error codes for structured error handling */
enum TranslationErrorCode {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  QUOTA_EXHAUSTED = 'QUOTA_EXHAUSTED',
  INVALID_INPUT = 'INVALID_INPUT',
  LOW_QUALITY = 'LOW_QUALITY',
  ALL_SERVICES_FAILED = 'ALL_SERVICES_FAILED',
  DEADLINE_EXCEEDED = 'DEADLINE_EXCEEDED',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
}

/** Structured translation error */
class TranslationError extends Error {
  constructor(
    public code: TranslationErrorCode,
    message: string,
    public service?: string,
    public retryable: boolean = false,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

/** Log entry for structured logging */
interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  requestId: string;
  service: string;
  action: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

/** Circuit breaker state per service */
interface CircuitBreakerState {
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  openUntil: number;
}

/** Retry budget to limit cascading retries */
interface RetryBudget {
  remaining: number;
  windowStart: number;
  windowMs: number;
  maxRetries: number;
}

/** Translation options */
interface TranslationOptions {
  deadline?: number;
  timeout?: number;
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
  requestId?: string;
}

/** Alert thresholds for monitoring */
const ALERT_THRESHOLDS = {
  quotaWarning: 0.8,
  quotaCritical: 0.95,
  errorRateWarning: 0.05,
  errorRateCritical: 0.15,
  latencyWarningMs: 5000,
  latencyCriticalMs: 15000,
};

// ============================================================================
// STRUCTURED LOGGER
// ============================================================================

class StructuredLogger {
  private requestId: string;
  private serviceName: string;
  private startTime: number;

  constructor(requestId?: string, serviceName: string = 'translation') {
    this.requestId = requestId || crypto.randomUUID();
    this.serviceName = serviceName;
    this.startTime = Date.now();
  }

  getRequestId(): string {
    return this.requestId;
  }

  private formatEntry(level: LogEntry['level'], action: string, metadata?: Record<string, unknown>): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestId,
      service: this.serviceName,
      action,
      duration_ms: Date.now() - this.startTime,
      ...(metadata && { metadata }),
    };
    return JSON.stringify(entry);
  }

  debug(action: string, metadata?: Record<string, unknown>): void {
    console.debug(this.formatEntry('DEBUG', action, metadata));
  }

  info(action: string, metadata?: Record<string, unknown>): void {
    console.info(this.formatEntry('INFO', action, metadata));
  }

  warn(action: string, metadata?: Record<string, unknown>): void {
    console.warn(this.formatEntry('WARN', action, metadata));
  }

  error(action: string, metadata?: Record<string, unknown>): void {
    console.error(this.formatEntry('ERROR', action, metadata));
  }
}

// ============================================================================
// LRU CACHE WITH TTL
// ============================================================================

interface CacheEntry<V> {
  value: V;
  timestamp: number;
  accessCount: number;
}

class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>>;
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(maxSize: number, ttlMs: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    entry.accessCount++;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now(), accessCount: 1 });
  }

  getStats(): { size: number; maxSize: number; hitRate: number; hits: number; misses: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
      hits: this.hits,
      misses: this.misses,
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

// ============================================================================
// SERVICE CONFIGURATION
// ============================================================================

interface LLMConfig {
  endpoint: string;
  apiKey: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
  timeout?: number;
  maxRetries?: number;
  deeplApiKey?: string;
  googleApiKey?: string;
  microsoftApiKey?: string;
  microsoftRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
}

/** Enhanced translation result with enterprise metadata */
interface TranslationResult {
  success: boolean;
  text: string;
  cached: boolean;
  cacheLayer: 'memory' | 'llm' | 'fallback';
  quality: number;
  service: string;
  latency_ms: number;
  requestId: string;
  tokensUsed?: number;
  retries?: number;
  error?: {
    code: TranslationErrorCode;
    message: string;
    retryable: boolean;
  };
}

interface BatchTranslationResult {
  translations: string[];
  quality: number[];
  totalTime: number;
  fromCache: number;
  fromLLM: number;
  requestId: string;
}

/** Comprehensive health status */
interface HealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  timestamp: string;
  uptime_ms: number;
  version: string;
  services: {
    [key: string]: {
      status: 'UP' | 'DOWN' | 'DEGRADED';
      circuitBreaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
      quotaRemaining: number;
      quotaPercent: number;
      lastSuccess?: string;
      lastError?: string;
    };
  };
  cache: {
    size: number;
    maxSize: number;
    hitRate: number;
  };
  retryBudget: {
    remaining: number;
    windowResetIn: number;
  };
  alerts: string[];
}

/** Translation metrics for monitoring */
interface TranslationMetrics {
  translations_total: number;
  translations_cached: number;
  translations_failed: number;
  fallback_used: Record<string, number>;
  latency_samples: number[];
  quality_samples: number[];
}

// ============================================================================
// ENTERPRISE-GRADE TRANSLATION SERVICE
// ============================================================================

class LLMTranslationService {
  private config: LLMConfig;
  private readonly VERSION = '2.0.0';
  private readonly startupTime = Date.now();

  // LRU Cache with TTL
  private cache: LRUCache<string, { text: string; quality: number; service: string }>;
  private readonly CACHE_TTL = 3600000; // 1 hour
  private readonly MAX_CACHE_SIZE = 10000;

  // Timeouts - fast fail for quick fallback
  private readonly DEFAULT_TIMEOUT = 10000; // 10 seconds
  private readonly FALLBACK_TIMEOUT = 8000; // 8 seconds for fallbacks
  private readonly MAX_RETRIES = 1; // Single attempt - fail fast

  // Per-service circuit breakers
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private readonly CIRCUIT_CONFIG = {
    failureThreshold: 3,
    successThreshold: 2, // Successes needed in half-open to close
    resetTimeout: 60000, // 1 minute
    halfOpenRequests: 2,
  };

  // Retry budget - prevent cascading failures
  private retryBudget: RetryBudget = {
    remaining: 20,
    windowStart: Date.now(),
    windowMs: 60000, // Per minute
    maxRetries: 20,
  };

  // Round-robin fallback rotation
  private fallbackIndex = 0;

  // Free tier limits per service (characters per month)
  private readonly FREE_LIMITS: Record<string, number> = {
    deepl: 500000,
    google: 500000,
    microsoft: 2000000,
    amazon: 2000000,
  };

  // Supabase client for quota tracking
  private supabase: ReturnType<typeof import("jsr:@supabase/supabase-js@2").createClient> | null = null;

  // Exhausted services cache (fail-safe quota enforcement)
  private exhaustedServices: Map<string, number> = new Map();
  private readonly EXHAUSTED_CACHE_TTL = 300000; // 5 minutes

  // Request coalescing - prevent duplicate in-flight requests
  private inFlightRequests: Map<string, Promise<TranslationResult>> = new Map();

  // Metrics tracking
  private metrics: TranslationMetrics = {
    translations_total: 0,
    translations_cached: 0,
    translations_failed: 0,
    fallback_used: {},
    latency_samples: [],
    quality_samples: [],
  };

  // Service status tracking
  private serviceLastSuccess: Map<string, number> = new Map();
  private serviceLastError: Map<string, string> = new Map();

  constructor(config: LLMConfig) {
    // Validate required config - no hardcoded fallbacks for security
    if (!config.apiKey) {
      throw new Error('LLM_TRANSLATION_API_KEY is required - check environment variables');
    }

    this.config = {
      ...config,
      timeout: config.timeout || this.DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries || this.MAX_RETRIES,
    };

    this.cache = new LRUCache(this.MAX_CACHE_SIZE, this.CACHE_TTL);

    // Initialize circuit breakers for all services
    const services = ['llm', 'deepl', 'google', 'microsoft', 'amazon'];
    for (const service of services) {
      this.circuitBreakers.set(service, {
        failures: 0,
        successes: 0,
        lastFailure: 0,
        lastSuccess: 0,
        state: 'CLOSED',
        openUntil: 0,
      });
    }
  }

  // ============================================================================
  // CIRCUIT BREAKER METHODS
  // ============================================================================

  /**
   * Get circuit breaker state for a service
   */
  private getCircuitBreaker(service: string): CircuitBreakerState {
    let cb = this.circuitBreakers.get(service);
    if (!cb) {
      cb = {
        failures: 0,
        successes: 0,
        lastFailure: 0,
        lastSuccess: 0,
        state: 'CLOSED',
        openUntil: 0,
      };
      this.circuitBreakers.set(service, cb);
    }
    return cb;
  }

  /**
   * Check if circuit allows request for a service
   */
  private isCircuitAllowed(service: string, logger: StructuredLogger): boolean {
    const cb = this.getCircuitBreaker(service);
    const now = Date.now();

    switch (cb.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        if (now >= cb.openUntil) {
          // Transition to half-open
          cb.state = 'HALF_OPEN';
          cb.successes = 0;
          logger.info('circuit_half_open', { service });
          return true;
        }
        logger.debug('circuit_open_blocked', { service, openUntil: new Date(cb.openUntil).toISOString() });
        return false;

      case 'HALF_OPEN':
        // Allow limited requests in half-open state
        return cb.successes < this.CIRCUIT_CONFIG.halfOpenRequests;
    }
  }

  /**
   * Record success for circuit breaker
   */
  private recordCircuitSuccess(service: string, logger: StructuredLogger): void {
    const cb = this.getCircuitBreaker(service);
    cb.lastSuccess = Date.now();
    cb.failures = 0;
    this.serviceLastSuccess.set(service, Date.now());

    if (cb.state === 'HALF_OPEN') {
      cb.successes++;
      if (cb.successes >= this.CIRCUIT_CONFIG.successThreshold) {
        cb.state = 'CLOSED';
        logger.info('circuit_closed', { service, reason: 'success_threshold_reached' });
      }
    }
  }

  /**
   * Record failure for circuit breaker
   */
  private recordCircuitFailure(service: string, error: string, logger: StructuredLogger): void {
    const cb = this.getCircuitBreaker(service);
    cb.failures++;
    cb.lastFailure = Date.now();
    this.serviceLastError.set(service, error);

    if (cb.state === 'HALF_OPEN') {
      // Immediately re-open on failure in half-open
      cb.state = 'OPEN';
      cb.openUntil = Date.now() + this.CIRCUIT_CONFIG.resetTimeout;
      logger.warn('circuit_reopened', { service, error });
    } else if (cb.failures >= this.CIRCUIT_CONFIG.failureThreshold) {
      cb.state = 'OPEN';
      cb.openUntil = Date.now() + this.CIRCUIT_CONFIG.resetTimeout;
      logger.error('circuit_opened', {
        service,
        failures: cb.failures,
        openUntil: new Date(cb.openUntil).toISOString(),
      });
    }
  }

  // ============================================================================
  // RETRY BUDGET METHODS
  // ============================================================================

  /**
   * Check if retry budget allows another retry
   */
  private canRetry(logger: StructuredLogger): boolean {
    const now = Date.now();
    if (now - this.retryBudget.windowStart > this.retryBudget.windowMs) {
      // Reset window
      this.retryBudget = {
        remaining: this.retryBudget.maxRetries,
        windowStart: now,
        windowMs: this.retryBudget.windowMs,
        maxRetries: this.retryBudget.maxRetries,
      };
      logger.debug('retry_budget_reset', { remaining: this.retryBudget.remaining });
    }
    return this.retryBudget.remaining > 0;
  }

  /**
   * Consume a retry from the budget
   */
  private consumeRetry(): void {
    this.retryBudget.remaining = Math.max(0, this.retryBudget.remaining - 1);
  }

  // ============================================================================
  // DEADLINE METHODS
  // ============================================================================

  /**
   * Check if deadline has been exceeded
   */
  private checkDeadline(deadline: number | undefined, logger: StructuredLogger): void {
    if (deadline && Date.now() > deadline) {
      logger.warn('deadline_exceeded', { deadline: new Date(deadline).toISOString() });
      throw new TranslationError(
        TranslationErrorCode.DEADLINE_EXCEEDED,
        'Translation deadline exceeded',
        undefined,
        false
      );
    }
  }

  // ============================================================================
  // SUPABASE & QUOTA METHODS
  // ============================================================================

  /**
   * Get or create Supabase client for quota tracking
   */
  private getSupabaseClient() {
    if (!this.supabase) {
      this.supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
    }
    return this.supabase;
  }

  /**
   * Get current month in YYYY-MM format
   */
  private getCurrentMonth(): string {
    return new Date().toISOString().slice(0, 7);
  }

  /**
   * Check if service is known to be exhausted (fast path, no DB call)
   */
  private isServiceExhausted(service: string, logger: StructuredLogger): boolean {
    const exhaustedAt = this.exhaustedServices.get(service);
    if (!exhaustedAt) return false;

    if (Date.now() - exhaustedAt > this.EXHAUSTED_CACHE_TTL) {
      this.exhaustedServices.delete(service);
      logger.debug('exhausted_cache_expired', { service });
      return false;
    }
    return true;
  }

  /**
   * Mark service as exhausted - will be skipped until cache expires
   */
  private markServiceExhausted(service: string, logger: StructuredLogger): void {
    this.exhaustedServices.set(service, Date.now());
    logger.warn('service_exhausted', {
      service,
      skipDurationSec: this.EXHAUSTED_CACHE_TTL / 1000,
    });
  }

  /**
   * Check if a service has remaining quota for the current month
   * FAIL-OPEN: Returns true if quota cannot be verified (let the service try)
   * This prevents DB/network issues from blocking all translation services
   */
  private async hasQuotaRemaining(service: string, charCount: number, logger: StructuredLogger): Promise<boolean> {
    try {
      const supabase = this.getSupabaseClient();
      const monthYear = this.getCurrentMonth();

      const { data, error } = await supabase.rpc('get_translation_usage', {
        p_service: service,
        p_month: monthYear
      });

      if (error) {
        // FAIL-OPEN: Allow service to be tried if we can't verify quota
        // The service API itself will reject if quota is actually exhausted
        logger.warn('quota_check_failed', { service, error: error.message, action: 'allowing_service' });
        return true;
      }

      const remaining = data?.[0]?.remaining ?? this.FREE_LIMITS[service];
      const hasQuota = remaining >= charCount;

      if (!hasQuota) {
        logger.info('quota_exhausted', { service, remaining, needed: charCount });
      }

      return hasQuota;
    } catch (err) {
      // FAIL-OPEN: Allow service to be tried on any error
      logger.warn('quota_check_error', { service, error: (err as Error).message, action: 'allowing_service' });
      return true;
    }
  }

  /**
   * Get quota info for all services (for health check)
   */
  private async getQuotaInfo(): Promise<Record<string, { used: number; limit: number; remaining: number; percent: number }>> {
    const quotaInfo: Record<string, { used: number; limit: number; remaining: number; percent: number }> = {};
    const monthYear = this.getCurrentMonth();

    try {
      const supabase = this.getSupabaseClient();

      for (const [service, limit] of Object.entries(this.FREE_LIMITS)) {
        const { data } = await supabase.rpc('get_translation_usage', {
          p_service: service,
          p_month: monthYear
        });

        const used = data?.[0]?.chars_used ?? 0;
        const remaining = limit - used;
        quotaInfo[service] = {
          used,
          limit,
          remaining,
          percent: used / limit,
        };
      }
    } catch {
      // Return empty info on error
    }

    return quotaInfo;
  }

  /**
   * Record usage after successful translation
   * Also checks if quota was exceeded and marks service as exhausted
   */
  private async recordUsage(service: string, charCount: number, logger: StructuredLogger): Promise<void> {
    try {
      const supabase = this.getSupabaseClient();
      const monthYear = this.getCurrentMonth();

      const { data, error } = await supabase.rpc('increment_translation_usage', {
        p_service: service,
        p_month: monthYear,
        p_chars: charCount,
        p_limit: this.FREE_LIMITS[service]
      });

      if (error) {
        logger.warn('usage_record_failed', { service, error: error.message });
        return;
      }

      const newUsage = data?.[0]?.chars_used ?? 0;
      const freeLimit = this.FREE_LIMITS[service];
      const remaining = freeLimit - newUsage;
      const percentUsed = (newUsage / freeLimit * 100).toFixed(1);

      logger.info('usage_recorded', {
        service,
        chars: charCount,
        totalUsed: newUsage,
        limit: freeLimit,
        remaining,
        percentUsed: `${percentUsed}%`,
      });

      // Check alert thresholds
      if (newUsage / freeLimit >= ALERT_THRESHOLDS.quotaCritical) {
        logger.error('quota_critical', { service, percentUsed: `${percentUsed}%` });
      } else if (newUsage / freeLimit >= ALERT_THRESHOLDS.quotaWarning) {
        logger.warn('quota_warning', { service, percentUsed: `${percentUsed}%` });
      }

      // Immediately mark as exhausted if we exceeded the limit
      if (newUsage >= freeLimit) {
        this.markServiceExhausted(service, logger);
      }
    } catch (err) {
      logger.warn('usage_record_error', { service, error: (err as Error).message });
    }
  }

  /**
   * Get available fallback services with quota remaining, in round-robin order
   * Uses circuit breakers and exhausted cache for fast path
   */
  private async getAvailableFallbackServices(charCount: number, logger: StructuredLogger): Promise<string[]> {
    const allServices = ['deepl', 'google', 'microsoft', 'amazon'];
    const available: string[] = [];

    for (const service of allServices) {
      // Fast path 1: Skip if circuit breaker is open
      if (!this.isCircuitAllowed(service, logger)) {
        logger.debug('service_skipped_circuit', { service });
        continue;
      }

      // Fast path 2: Skip if known to be exhausted
      if (this.isServiceExhausted(service, logger)) {
        logger.debug('service_skipped_exhausted', { service });
        continue;
      }

      // Slow path: Check quota in database
      if (await this.hasQuotaRemaining(service, charCount, logger)) {
        available.push(service);
      } else {
        this.markServiceExhausted(service, logger);
      }
    }

    if (available.length === 0) {
      logger.error('all_quotas_exhausted', { month: this.getCurrentMonth() });
      return [];
    }

    // Rotate order for load balancing
    const startIndex = this.fallbackIndex % available.length;
    const rotated = [
      ...available.slice(startIndex),
      ...available.slice(0, startIndex)
    ];
    this.fallbackIndex++;

    logger.debug('fallback_services_available', { services: rotated });
    return rotated;
  }

  /**
   * Try a specific fallback service
   */
  private async tryFallbackService(
    service: string,
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    switch (service) {
      case 'deepl':
        return this.tryDeepL(text, sourceLang, targetLang);
      case 'google':
        return this.tryGoogleTranslate(text, sourceLang, targetLang);
      case 'microsoft':
        return this.tryMicrosoftTranslator(text, sourceLang, targetLang);
      case 'amazon':
        return this.tryAmazonTranslate(text, sourceLang, targetLang);
      default:
        return { text, cached: false, quality: 0 };
    }
  }

  /**
   * Categorize error type for better logging
   */
  private categorizeError(error: Error): string {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('aborted')) return 'TIMEOUT';
    if (msg.includes('429') || msg.includes('rate')) return 'RATE_LIMITED';
    if (msg.includes('503') || msg.includes('502') || msg.includes('504')) return 'SERVICE_DOWN';
    if (msg.includes('network') || msg.includes('fetch')) return 'NETWORK_ERROR';
    return 'UNKNOWN';
  }

  /**
   * Map language codes to DeepL format
   */
  private mapToDeepLLanguage(lang: string): string {
    const mapping: Record<string, string> = {
      'en': 'EN',
      'ru': 'RU',
      'es': 'ES',
      'fr': 'FR',
      'de': 'DE',
      'it': 'IT',
      'pt': 'PT-BR',
      'ja': 'JA',
      'ko': 'KO',
      'zh': 'ZH',
      'ar': 'AR',
      'nl': 'NL',
      'pl': 'PL',
      'tr': 'TR',
      'uk': 'UK',
      'cs': 'CS',
      'da': 'DA',
      'fi': 'FI',
      'el': 'EL',
      'hu': 'HU',
      'id': 'ID',
      'no': 'NB',
      'ro': 'RO',
      'sk': 'SK',
      'sv': 'SV',
      'th': 'TH',
      'vi': 'VI',
      'hi': 'HI',
    };
    return mapping[lang.toLowerCase()] || lang.toUpperCase();
  }

  /**
   * Map language codes to Google Cloud Translation format
   * Google uses BCP-47 language tags
   */
  private mapToGoogleLanguage(lang: string): string {
    const mapping: Record<string, string> = {
      'zh': 'zh-CN',  // Simplified Chinese
      'pt': 'pt-BR',  // Brazilian Portuguese
    };
    return mapping[lang.toLowerCase()] || lang.toLowerCase();
  }

  /**
   * Map language codes to Microsoft Translator format
   */
  private mapToMicrosoftLanguage(lang: string): string {
    const mapping: Record<string, string> = {
      'zh': 'zh-Hans',  // Simplified Chinese
      'pt': 'pt-br',    // Brazilian Portuguese
    };
    return mapping[lang.toLowerCase()] || lang.toLowerCase();
  }

  /**
   * Map language codes to Amazon Translate format
   */
  private mapToAmazonLanguage(lang: string): string {
    const mapping: Record<string, string> = {
      'zh': 'zh',       // Simplified Chinese
      'pt': 'pt-BR',    // Brazilian Portuguese
    };
    return mapping[lang.toLowerCase()] || lang.toLowerCase();
  }

  /**
   * Fallback translation using DeepL API
   * Used when primary LLM service is down or circuit breaker is open
   */
  private async tryDeepL(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const deeplKey = this.config.deeplApiKey || Deno.env.get("DEEPL_API_KEY");

    if (!deeplKey) {
      console.warn("DeepL API key not configured, skipping fallback");
      return { text, cached: false, quality: 0, service: 'deepl' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout for DeepL

      const deeplTargetLang = this.mapToDeepLLanguage(targetLang);
      const deeplSourceLang = this.mapToDeepLLanguage(sourceLang);

      // Use free API endpoint (api-free.deepl.com) or pro (api.deepl.com)
      const endpoint = deeplKey.endsWith(':fx')
        ? 'https://api-free.deepl.com/v2/translate'
        : 'https://api.deepl.com/v2/translate';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `DeepL-Auth-Key ${deeplKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: [text],
          source_lang: deeplSourceLang,
          target_lang: deeplTargetLang,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`DeepL API error: ${response.status} - ${errorText}`);
        return { text, cached: false, quality: 0, service: 'deepl' };
      }

      const data = await response.json();
      const translatedText = data.translations?.[0]?.text;

      if (!translatedText || translatedText === text) {
        return { text, cached: false, quality: 0, service: 'deepl' };
      }

      // DeepL translations are high quality
      const quality = this.calculateQuality(text, translatedText);
      console.log(`DeepL fallback success: quality=${quality.toFixed(2)}`);

      // Cache the result
      if (quality > 0.5) {
        const cacheKey = `${sourceLang}:${targetLang}:${text}`;
        this.cache.set(cacheKey, {
          text: translatedText,
          quality,
          service: 'deepl',
        });
      }

      return { text: translatedText, cached: false, quality, service: 'deepl' };
    } catch (error) {
      const err = error as Error;
      console.error(`DeepL fallback failed: ${err.message}`);
      return { text, cached: false, quality: 0, service: 'deepl' };
    }
  }

  /**
   * Fallback translation using Google Cloud Translation API
   * Used when DeepL fails or is not available
   */
  private async tryGoogleTranslate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const googleKey = this.config.googleApiKey || Deno.env.get("GOOGLE_TRANSLATE_API_KEY");

    if (!googleKey) {
      console.warn("Google Translate API key not configured, skipping fallback");
      return { text, cached: false, quality: 0, service: 'google' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

      const googleTargetLang = this.mapToGoogleLanguage(targetLang);
      const googleSourceLang = this.mapToGoogleLanguage(sourceLang);

      const response = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${googleKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            q: text,
            source: googleSourceLang,
            target: googleTargetLang,
            format: 'text',
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Google Translate API error: ${response.status} - ${errorText}`);
        return { text, cached: false, quality: 0, service: 'google' };
      }

      const data = await response.json();
      const translatedText = data.data?.translations?.[0]?.translatedText;

      if (!translatedText || translatedText === text) {
        return { text, cached: false, quality: 0, service: 'google' };
      }

      // Google translations are high quality
      const quality = this.calculateQuality(text, translatedText);
      console.log(`Google Translate fallback success: quality=${quality.toFixed(2)}`);

      // Cache the result
      if (quality > 0.5) {
        const cacheKey = `${sourceLang}:${targetLang}:${text}`;
        this.cache.set(cacheKey, {
          text: translatedText,
          quality,
          service: 'google',
        });
      }

      return { text: translatedText, cached: false, quality, service: 'google' };
    } catch (error) {
      const err = error as Error;
      console.error(`Google Translate fallback failed: ${err.message}`);
      return { text, cached: false, quality: 0, service: 'google' };
    }
  }

  /**
   * Fallback translation using Microsoft Translator API
   * Used when both DeepL and Google fail
   */
  private async tryMicrosoftTranslator(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const msKey = this.config.microsoftApiKey || Deno.env.get("MICROSOFT_TRANSLATOR_API_KEY");
    const msRegion = this.config.microsoftRegion || Deno.env.get("MICROSOFT_TRANSLATOR_REGION") || "global";

    if (!msKey) {
      console.warn("Microsoft Translator API key not configured, skipping fallback");
      return { text, cached: false, quality: 0, service: 'microsoft' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

      const msTargetLang = this.mapToMicrosoftLanguage(targetLang);
      const msSourceLang = this.mapToMicrosoftLanguage(sourceLang);

      const response = await fetch(
        `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=${msSourceLang}&to=${msTargetLang}`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': msKey,
            'Ocp-Apim-Subscription-Region': msRegion,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ text }]),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Microsoft Translator API error: ${response.status} - ${errorText}`);
        return { text, cached: false, quality: 0, service: 'microsoft' };
      }

      const data = await response.json();
      const translatedText = data?.[0]?.translations?.[0]?.text;

      if (!translatedText || translatedText === text) {
        return { text, cached: false, quality: 0, service: 'microsoft' };
      }

      // Microsoft translations are high quality
      const quality = this.calculateQuality(text, translatedText);
      console.log(`Microsoft Translator fallback success: quality=${quality.toFixed(2)}`);

      // Cache the result
      if (quality > 0.5) {
        const cacheKey = `${sourceLang}:${targetLang}:${text}`;
        this.cache.set(cacheKey, {
          text: translatedText,
          quality,
          service: 'microsoft',
        });
      }

      return { text: translatedText, cached: false, quality, service: 'microsoft' };
    } catch (error) {
      const err = error as Error;
      console.error(`Microsoft Translator fallback failed: ${err.message}`);
      return { text, cached: false, quality: 0, service: 'microsoft' };
    }
  }

  /**
   * Generate AWS Signature V4 for Amazon Translate API
   */
  private async generateAwsSignature(
    method: string,
    service: string,
    region: string,
    host: string,
    path: string,
    payload: string,
    accessKeyId: string,
    secretAccessKey: string
  ): Promise<{ headers: Record<string, string>; }> {
    const algorithm = 'AWS4-HMAC-SHA256';
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

    // Create canonical request
    const payloadHash = await this.sha256Hash(payload);
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:AWSShineFrontendService_20170701.TranslateText\n`;
    const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
    const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    // Create string to sign
    const canonicalRequestHash = await this.sha256Hash(canonicalRequest);
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;

    // Calculate signature
    const signingKey = await this.getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = await this.hmacSha256Hex(signingKey, stringToSign);

    // Create authorization header
    const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      headers: {
        'Content-Type': 'application/json',
        'X-Amz-Date': amzDate,
        'X-Amz-Target': 'AWSShineFrontendService_20170701.TranslateText',
        'Authorization': authorizationHeader,
      }
    };
  }

  private async sha256Hash(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  }

  private async hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
    const signature = await this.hmacSha256(key, message);
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async getSignatureKey(
    secretKey: string,
    dateStamp: string,
    region: string,
    service: string
  ): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const kDate = await this.hmacSha256(encoder.encode('AWS4' + secretKey), dateStamp);
    const kRegion = await this.hmacSha256(kDate, region);
    const kService = await this.hmacSha256(kRegion, service);
    return this.hmacSha256(kService, 'aws4_request');
  }

  /**
   * Fallback translation using Amazon Translate API
   * Used when DeepL, Google, and Microsoft all fail
   */
  private async tryAmazonTranslate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const awsAccessKeyId = this.config.awsAccessKeyId || Deno.env.get("AWS_ACCESS_KEY_ID");
    const awsSecretAccessKey = this.config.awsSecretAccessKey || Deno.env.get("AWS_SECRET_ACCESS_KEY");
    const awsRegion = this.config.awsRegion || Deno.env.get("AWS_REGION") || "us-east-1";

    if (!awsAccessKeyId || !awsSecretAccessKey) {
      console.warn("AWS credentials not configured, skipping Amazon Translate fallback");
      return { text, cached: false, quality: 0, service: 'amazon' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout

      const amazonSourceLang = this.mapToAmazonLanguage(sourceLang);
      const amazonTargetLang = this.mapToAmazonLanguage(targetLang);

      const host = `translate.${awsRegion}.amazonaws.com`;
      const path = '/';
      const payload = JSON.stringify({
        SourceLanguageCode: amazonSourceLang,
        TargetLanguageCode: amazonTargetLang,
        Text: text,
      });

      const { headers } = await this.generateAwsSignature(
        'POST', 'translate', awsRegion, host, path, payload, awsAccessKeyId, awsSecretAccessKey
      );

      const response = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Amazon Translate API error: ${response.status} - ${errorText}`);
        return { text, cached: false, quality: 0, service: 'amazon' };
      }

      const data = await response.json();
      const translatedText = data.TranslatedText;

      if (!translatedText || translatedText === text) {
        return { text, cached: false, quality: 0, service: 'amazon' };
      }

      // Amazon translations are high quality
      const quality = this.calculateQuality(text, translatedText);
      console.log(`Amazon Translate fallback success: quality=${quality.toFixed(2)}`);

      // Cache the result
      if (quality > 0.5) {
        const cacheKey = `${sourceLang}:${targetLang}:${text}`;
        this.cache.set(cacheKey, {
          text: translatedText,
          quality,
          service: 'amazon',
        });
      }

      return { text: translatedText, cached: false, quality, service: 'amazon' };
    } catch (error) {
      const err = error as Error;
      console.error(`Amazon Translate fallback failed: ${err.message}`);
      return { text, cached: false, quality: 0, service: 'amazon' };
    }
  }

  /**
   * Comprehensive health check with detailed status
   */
  async checkHealth(): Promise<HealthStatus> {
    const logger = new StructuredLogger(undefined, 'health-check');
    const alerts: string[] = [];
    let overallStatus: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' = 'HEALTHY';

    // Get quota info for all services
    const quotaInfo = await this.getQuotaInfo();

    // Build service status
    const services: HealthStatus['services'] = {};
    const serviceNames = ['llm', 'deepl', 'google', 'microsoft', 'amazon'];

    for (const service of serviceNames) {
      const cb = this.getCircuitBreaker(service);
      const quota = quotaInfo[service];

      let status: 'UP' | 'DOWN' | 'DEGRADED' = 'UP';

      // Check circuit breaker state
      if (cb.state === 'OPEN') {
        status = 'DOWN';
        overallStatus = 'DEGRADED';
        alerts.push(`${service} circuit breaker is OPEN`);
      } else if (cb.state === 'HALF_OPEN') {
        status = 'DEGRADED';
        if (overallStatus === 'HEALTHY') overallStatus = 'DEGRADED';
      }

      // Check quota (skip for llm)
      let quotaRemaining = 0;
      let quotaPercent = 0;
      if (quota) {
        quotaRemaining = quota.remaining;
        quotaPercent = quota.percent;

        if (quota.percent >= ALERT_THRESHOLDS.quotaCritical) {
          status = 'DOWN';
          overallStatus = 'DEGRADED';
          alerts.push(`${service} quota critical: ${(quota.percent * 100).toFixed(1)}% used`);
        } else if (quota.percent >= ALERT_THRESHOLDS.quotaWarning) {
          if (status === 'UP') status = 'DEGRADED';
          alerts.push(`${service} quota warning: ${(quota.percent * 100).toFixed(1)}% used`);
        }
      }

      // Check if service is exhausted
      if (this.exhaustedServices.has(service)) {
        status = 'DOWN';
        if (overallStatus === 'HEALTHY') overallStatus = 'DEGRADED';
      }

      services[service] = {
        status,
        circuitBreaker: cb.state,
        quotaRemaining,
        quotaPercent,
        lastSuccess: this.serviceLastSuccess.get(service)
          ? new Date(this.serviceLastSuccess.get(service)!).toISOString()
          : undefined,
        lastError: this.serviceLastError.get(service),
      };
    }

    // Check if all fallback services are down
    const fallbackServices = ['deepl', 'google', 'microsoft', 'amazon'];
    const allFallbacksDown = fallbackServices.every(s => services[s].status === 'DOWN');
    if (allFallbacksDown) {
      overallStatus = 'UNHEALTHY';
      alerts.push('All fallback services are unavailable');
    }

    // Check error rate from metrics
    const errorRate = this.metrics.translations_total > 0
      ? this.metrics.translations_failed / this.metrics.translations_total
      : 0;
    if (errorRate >= ALERT_THRESHOLDS.errorRateCritical) {
      overallStatus = 'UNHEALTHY';
      alerts.push(`Error rate critical: ${(errorRate * 100).toFixed(1)}%`);
    } else if (errorRate >= ALERT_THRESHOLDS.errorRateWarning) {
      if (overallStatus === 'HEALTHY') overallStatus = 'DEGRADED';
      alerts.push(`Error rate elevated: ${(errorRate * 100).toFixed(1)}%`);
    }

    // Get cache stats
    const cacheStats = this.cache.getStats();

    // Retry budget info
    const now = Date.now();
    const windowResetIn = Math.max(0, this.retryBudget.windowMs - (now - this.retryBudget.windowStart));

    logger.info('health_check_complete', {
      status: overallStatus,
      alertCount: alerts.length,
    });

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - this.startupTime,
      version: this.VERSION,
      services,
      cache: {
        size: cacheStats.size,
        maxSize: cacheStats.maxSize,
        hitRate: cacheStats.hitRate,
      },
      retryBudget: {
        remaining: this.retryBudget.remaining,
        windowResetIn,
      },
      alerts,
    };
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): TranslationMetrics & { cache: { hitRate: number; size: number } } {
    const cacheStats = this.cache.getStats();
    return {
      ...this.metrics,
      cache: {
        hitRate: cacheStats.hitRate,
        size: cacheStats.size,
      },
    };
  }

  /**
   * Validate if a language is supported
   */
  static isValidLanguage(lang: string): lang is SupportedLanguage {
    return SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage);
  }

  /**
   * Get list of supported languages
   */
  static getSupportedLanguages(): readonly string[] {
    return SUPPORTED_LANGUAGES;
  }

  /**
   * Try the primary LLM translation service (internal method)
   */
  private async tryPrimaryService(
    text: string,
    sourceLang: string,
    targetLang: string,
    context?: string
  ): Promise<TranslationResult> {
    const enhancedContext = this.getEnhancedContext(context || "post", text);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          "CF-Access-Client-Id": this.config.cfAccessClientId,
          "CF-Access-Client-Secret": this.config.cfAccessClientSecret,
        },
        body: JSON.stringify({
          text: text,
          targetLanguage: targetLang,
          sourceLanguage: sourceLang,
          context: enhancedContext,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Translation API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      let translatedText = data.translatedText || data.text || text;

      // Clean up response
      if (typeof translatedText === 'string') {
        const trimmed = translatedText.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('{\n')) {
          try {
            const cleanJson = trimmed.replace(/\n/g, '').replace(/\r/g, '');
            const parsed = JSON.parse(cleanJson);
            translatedText = parsed.translation || parsed.translatedText || parsed.text || translatedText;
          } catch {
            const patterns = [
              /"translation"\s*:\s*"([^"]+)"/,
              /"translatedText"\s*:\s*"([^"]+)"/,
              /"text"\s*:\s*"([^"]+)"/,
            ];
            for (const pattern of patterns) {
              const match = trimmed.match(pattern);
              if (match && match[1]) {
                translatedText = match[1];
                break;
              }
            }
          }
        }
        translatedText = translatedText
          .replace(/^(Translation:|Translated text:|Result:)\s*/i, '')
          .replace(/^["']|["']$/g, '')
          .trim();
      }

      const quality = this.calculateQuality(text, translatedText);
      return { text: translatedText, cached: false, quality, tokensUsed: data.tokensUsed };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Detect if text contains HTML formatting
   */
  private detectContentFormat(text: string): 'html' | 'plain' {
    const htmlTags = /<(p|br|div|span|a|ul|li|ol|h[1-6]|strong|em|b|i)[^>]*>/i;
    return htmlTags.test(text) ? 'html' : 'plain';
  }

  /**
   * Enhanced context for food-sharing posts
   */
  private getEnhancedContext(contentType: string, text: string): string {
    const baseContext = "food-sharing platform where people share surplus food";

    // Detect content characteristics
    const hasFood = /\b(food|meal|bread|fruit|vegetable|meat|dairy|snack|drink|beverage)\b/i.test(text);
    const hasLocation = /\b(pickup|location|address|street|avenue|road)\b/i.test(text);
    const hasTime = /\b(today|tomorrow|tonight|morning|afternoon|evening|expires|expiry)\b/i.test(text);

    let context = baseContext;
    if (hasFood) context += ", describing food items";
    if (hasLocation) context += ", mentioning pickup location";
    if (hasTime) context += ", with time-sensitive information";

    // Add HTML preservation instruction if content contains HTML
    const format = this.detectContentFormat(text);
    if (format === 'html') {
      context += ". CRITICAL: Preserve all HTML tags exactly (<p>, <br>, <a href>, etc.). Only translate the text content between tags, never modify or remove the tags themselves.";
    }

    return context;
  }

  /**
   * Calculate quality score based on translation characteristics
   */
  private calculateQuality(original: string, translated: string): number {
    // Base quality
    let quality = 0.95;

    // Penalize if translation is identical to original (likely failed)
    if (original === translated) quality = 0.1;

    // Penalize if translation is much shorter or longer (likely hallucination)
    const lengthRatio = translated.length / original.length;
    if (lengthRatio < 0.5 || lengthRatio > 2.0) quality *= 0.7;

    // Penalize if translation contains JSON artifacts
    if (translated.includes('{') || translated.includes('"translation"')) quality *= 0.5;

    // Bonus for reasonable length
    if (lengthRatio >= 0.7 && lengthRatio <= 1.5) quality = Math.min(1.0, quality + 0.05);

    // Check HTML preservation
    const originalFormat = this.detectContentFormat(original);
    if (originalFormat === 'html') {
      const originalTags = (original.match(/<[^>]+>/g) || []).sort().join(',');
      const translatedTags = (translated.match(/<[^>]+>/g) || []).sort().join(',');

      if (originalTags !== translatedTags) {
        quality *= 0.5; // Penalize if HTML structure changed
        console.warn(`HTML structure changed: expected ${originalTags.split(',').length} tags, got ${translatedTags.split(',').length}`);
      }
    }

    return quality;
  }

  /**
   * Translate text with enterprise-grade reliability patterns
   * - Request coalescing for duplicate requests
   * - Circuit breakers per service
   * - Retry budget to prevent cascading failures
   * - Deadline support for timeout guarantees
   */
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string,
    context?: string,
    options?: TranslationOptions
  ): Promise<TranslationResult> {
    const startTime = Date.now();
    const logger = new StructuredLogger(options?.requestId);
    const requestId = logger.getRequestId();
    const cacheKey = `${sourceLang}:${targetLang}:${text}`;

    // Calculate deadline
    const deadline = options?.deadline || (options?.timeout ? Date.now() + options.timeout : undefined);

    logger.info('translate_start', {
      sourceLang,
      targetLang,
      textLength: text.length,
      hasDeadline: !!deadline,
    });

    // Request coalescing - check for in-flight request
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      logger.debug('request_coalesced', { cacheKey: cacheKey.substring(0, 50) });
      return inFlight;
    }

    // Create and track new request
    const promise = this.translateInternal(text, sourceLang, targetLang, context, deadline, logger);
    this.inFlightRequests.set(cacheKey, promise);

    try {
      const result = await promise;
      const latency = Date.now() - startTime;

      // Update metrics
      this.metrics.translations_total++;
      this.metrics.latency_samples.push(latency);
      if (this.metrics.latency_samples.length > 1000) {
        this.metrics.latency_samples = this.metrics.latency_samples.slice(-500);
      }
      if (result.cached) this.metrics.translations_cached++;
      if (!result.success) this.metrics.translations_failed++;
      if (result.service !== 'llm' && result.success) {
        this.metrics.fallback_used[result.service] = (this.metrics.fallback_used[result.service] || 0) + 1;
      }
      this.metrics.quality_samples.push(result.quality);
      if (this.metrics.quality_samples.length > 1000) {
        this.metrics.quality_samples = this.metrics.quality_samples.slice(-500);
      }

      // Check latency thresholds
      if (latency > ALERT_THRESHOLDS.latencyCriticalMs) {
        logger.error('latency_critical', { latency_ms: latency });
      } else if (latency > ALERT_THRESHOLDS.latencyWarningMs) {
        logger.warn('latency_warning', { latency_ms: latency });
      }

      logger.info('translate_complete', {
        success: result.success,
        service: result.service,
        cached: result.cached,
        quality: result.quality.toFixed(2),
        latency_ms: latency,
      });

      return { ...result, latency_ms: latency, requestId };
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  /**
   * Internal translation logic with all reliability patterns
   */
  private async translateInternal(
    text: string,
    sourceLang: string,
    targetLang: string,
    context: string | undefined,
    deadline: number | undefined,
    logger: StructuredLogger
  ): Promise<TranslationResult> {
    const requestId = logger.getRequestId();
    const cacheKey = `${sourceLang}:${targetLang}:${text}`;

    // Check deadline
    this.checkDeadline(deadline, logger);

    // Check LRU cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return {
        success: true,
        text: cached.text,
        cached: true,
        cacheLayer: 'memory',
        quality: cached.quality,
        service: cached.service,
        latency_ms: 0,
        requestId,
      };
    }

    let shouldTryFallback = false;
    let usedService = 'llm';

    // Check circuit breaker for primary service
    if (!this.isCircuitAllowed('llm', logger)) {
      logger.info('primary_circuit_open', { action: 'trying_fallback' });
      shouldTryFallback = true;
    }

    // Try primary service if circuit allows
    if (!shouldTryFallback) {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < this.config.maxRetries!; attempt++) {
        // Check deadline and retry budget
        this.checkDeadline(deadline, logger);
        if (attempt > 0 && !this.canRetry(logger)) {
          logger.warn('retry_budget_exhausted', { attempt });
          break;
        }

        try {
          const result = await this.tryPrimaryService(text, sourceLang, targetLang, context);

          if (result.quality > 0.5) {
            // Cache the result
            this.cache.set(cacheKey, {
              text: result.text,
              quality: result.quality,
              service: 'llm',
            });

            this.recordCircuitSuccess('llm', logger);
            logger.info('primary_success', { attempt: attempt + 1, quality: result.quality.toFixed(2) });

            return {
              success: true,
              text: result.text,
              cached: false,
              cacheLayer: 'llm',
              quality: result.quality,
              service: 'llm',
              latency_ms: 0,
              requestId,
              tokensUsed: result.tokensUsed,
              retries: attempt,
            };
          }

          // Low quality - try fallback
          logger.warn('primary_low_quality', { quality: result.quality.toFixed(2) });
          shouldTryFallback = true;
          break;
        } catch (error) {
          lastError = error as Error;
          const errorType = this.categorizeError(lastError);

          if (attempt > 0) this.consumeRetry();

          logger.warn('primary_attempt_failed', {
            attempt: attempt + 1,
            errorType,
            error: lastError.message,
          });

          // Exponential backoff (but check deadline first)
          if (attempt < this.config.maxRetries! - 1) {
            const backoffMs = Math.pow(2, attempt) * 1000;
            if (deadline && Date.now() + backoffMs > deadline) {
              logger.warn('skipping_backoff_deadline', { backoffMs });
              break;
            }
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        }
      }

      if (lastError) {
        this.recordCircuitFailure('llm', lastError.message, logger);
        shouldTryFallback = true;
      }
    }

    // Try fallback services
    if (shouldTryFallback) {
      const charCount = text.length;
      const availableServices = await this.getAvailableFallbackServices(charCount, logger);

      if (availableServices.length === 0) {
        return {
          success: false,
          text,
          cached: false,
          cacheLayer: 'fallback',
          quality: 0,
          service: 'none',
          latency_ms: 0,
          requestId,
          error: {
            code: TranslationErrorCode.QUOTA_EXHAUSTED,
            message: 'All translation service quotas exhausted',
            retryable: false,
          },
        };
      }

      for (const service of availableServices) {
        // Check deadline before each fallback attempt
        this.checkDeadline(deadline, logger);

        // Check circuit breaker
        if (!this.isCircuitAllowed(service, logger)) {
          continue;
        }

        const result = await this.tryFallbackService(service, text, sourceLang, targetLang);

        if (result.quality > 0.5) {
          // Record usage and circuit success
          await this.recordUsage(service, charCount, logger);
          this.recordCircuitSuccess(service, logger);

          // Cache the result
          this.cache.set(cacheKey, {
            text: result.text,
            quality: result.quality,
            service,
          });

          logger.info('fallback_success', { service, quality: result.quality.toFixed(2) });
          usedService = service;

          return {
            success: true,
            text: result.text,
            cached: false,
            cacheLayer: 'fallback',
            quality: result.quality,
            service,
            latency_ms: 0,
            requestId,
          };
        }

        this.recordCircuitFailure(service, 'Low quality translation', logger);
        logger.warn('fallback_low_quality', { service, quality: result.quality.toFixed(2) });
      }
    }

    // All services failed
    logger.error('all_services_failed', { textLength: text.length });

    return {
      success: false,
      text,
      cached: false,
      cacheLayer: 'fallback',
      quality: 0,
      service: 'none',
      latency_ms: 0,
      requestId,
      retries: this.config.maxRetries,
      error: {
        code: TranslationErrorCode.ALL_SERVICES_FAILED,
        message: 'All translation services failed',
        retryable: true,
      },
    };
  }

  /**
   * Batch translate multiple texts in parallel with concurrency control
   */
  async batchTranslate(
    texts: string[],
    sourceLang: string,
    targetLang: string,
    context?: string,
    options?: TranslationOptions
  ): Promise<BatchTranslationResult> {
    const startTime = Date.now();
    const logger = new StructuredLogger(options?.requestId);
    const requestId = logger.getRequestId();

    logger.info('batch_translate_start', {
      count: texts.length,
      sourceLang,
      targetLang,
    });

    let fromCache = 0;
    let fromLLM = 0;

    // Translate all texts in parallel with concurrency limit
    const CONCURRENCY_LIMIT = 5;
    const results: TranslationResult[] = [];

    for (let i = 0; i < texts.length; i += CONCURRENCY_LIMIT) {
      const batch = texts.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.all(
        batch.map(text => this.translate(text, sourceLang, targetLang, context, {
          ...options,
          requestId: `${requestId}-${i}`,
        }))
      );
      results.push(...batchResults);
    }

    // Extract translations and quality scores
    const translations = results.map(r => r.text);
    const quality = results.map(r => r.quality);

    // Count cache hits
    fromCache = results.filter(r => r.cached).length;
    fromLLM = results.filter(r => !r.cached && r.success).length;

    const totalTime = Date.now() - startTime;

    logger.info('batch_translate_complete', {
      count: texts.length,
      fromCache,
      fromLLM,
      failed: results.filter(r => !r.success).length,
      totalTime_ms: totalTime,
    });

    return {
      translations,
      quality,
      totalTime,
      fromCache,
      fromLLM,
      requestId,
    };
  }

  /**
   * Translate with smart chunking for long texts
   */
  async translateLongText(
    text: string,
    sourceLang: string,
    targetLang: string,
    context?: string,
    maxChunkSize: number = 500,
    options?: TranslationOptions
  ): Promise<TranslationResult> {
    const logger = new StructuredLogger(options?.requestId);

    // If text is short enough, translate directly
    if (text.length <= maxChunkSize) {
      return this.translate(text, sourceLang, targetLang, context, options);
    }

    logger.info('long_text_chunking', { textLength: text.length, maxChunkSize });

    // Split into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks: string[] = [];
    let currentChunk = "";

    for (const sentence of sentences) {
      if ((currentChunk + sentence).length <= maxChunkSize) {
        currentChunk += sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      }
    }
    if (currentChunk) chunks.push(currentChunk.trim());

    logger.debug('chunks_created', { chunkCount: chunks.length });

    // Translate chunks in parallel
    const batchResult = await this.batchTranslate(chunks, sourceLang, targetLang, context, options);

    // Combine translated chunks
    const combinedText = batchResult.translations.join(" ");
    const avgQuality = batchResult.quality.reduce((a, b) => a + b, 0) / batchResult.quality.length;

    return {
      success: true,
      text: combinedText,
      cached: false,
      cacheLayer: 'llm',
      quality: avgQuality,
      service: 'batch',
      latency_ms: batchResult.totalTime,
      requestId: batchResult.requestId,
    };
  }

  /**
   * Clear memory cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats (deprecated - use getMetrics instead)
   */
  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return this.cache.getStats();
  }

  /**
   * Warm up cache with common translations
   */
  async warmupCache(
    commonPhrases: string[],
    targetLangs: string[],
    sourceLang: string = "en"
  ): Promise<void> {
    const logger = new StructuredLogger();
    logger.info('cache_warmup_start', {
      phrases: commonPhrases.length,
      languages: targetLangs.length,
    });

    for (const lang of targetLangs) {
      await this.batchTranslate(commonPhrases, sourceLang, lang, "food-sharing");
    }

    const stats = this.cache.getStats();
    logger.info('cache_warmup_complete', { cacheSize: stats.size });
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

/**
 * Create the translation service singleton with environment configuration
 * All sensitive values MUST come from environment variables - no fallbacks
 */
function createTranslationService(): LLMTranslationService {
  const apiKey = Deno.env.get("LLM_TRANSLATION_API_KEY");
  if (!apiKey) {
    console.error('CRITICAL: LLM_TRANSLATION_API_KEY environment variable is required');
    // Don't throw here - let the constructor handle validation
  }

  return new LLMTranslationService({
    endpoint: Deno.env.get("LLM_TRANSLATION_ENDPOINT") || "https://translate.foodshare.club/api/translate",
    apiKey: apiKey || '', // Will fail in constructor if empty
    cfAccessClientId: Deno.env.get("CF_ACCESS_CLIENT_ID") || "",
    cfAccessClientSecret: Deno.env.get("CF_ACCESS_CLIENT_SECRET") || "",
    timeout: 10000, // 10 seconds - fast fail for quick fallback
    maxRetries: 1,  // Single attempt - rely on fallbacks
    deeplApiKey: Deno.env.get("DEEPL_API_KEY"),
    googleApiKey: Deno.env.get("GOOGLE_TRANSLATE_API_KEY"),
    microsoftApiKey: Deno.env.get("MICROSOFT_TRANSLATOR_API_KEY"),
    microsoftRegion: Deno.env.get("MICROSOFT_TRANSLATOR_REGION"),
    awsAccessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID"),
    awsSecretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY"),
    awsRegion: Deno.env.get("AWS_REGION"),
  });
}

export const llmTranslationService = createTranslationService();

// Export types and utilities
export {
  TranslationError,
  TranslationErrorCode,
  SUPPORTED_LANGUAGES,
  ALERT_THRESHOLDS,
};
export type {
  TranslationResult,
  BatchTranslationResult,
  HealthStatus,
  TranslationMetrics,
  TranslationOptions,
  SupportedLanguage,
};
