/**
 * Email Service - Unified Email Provider Orchestration
 *
 * Features:
 * - Multi-provider support (no automatic fallback)
 * - Uses first configured provider per email type
 * - Health monitoring and metrics tracking
 * - Configurable priority by email type
 */

import {
  EmailProvider,
  EmailProviderName,
  EmailType,
  SendEmailParams,
  SendEmailResult,
  ProviderHealth,
  EmailServiceConfig,
  DEFAULT_EMAIL_CONFIG,
  CircuitState,
} from "./types.ts";
import { ResendProvider, createResendProvider } from "./resend-provider.ts";
import { BrevoProvider, createBrevoProvider } from "./brevo-provider.ts";
import { AWSSESProvider, createAWSSESProvider } from "./aws-ses-provider.ts";
import { MailerSendProvider, createMailerSendProvider } from "./mailersend-provider.ts";

// ============================================================================
// Circuit Breaker
// ============================================================================

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
}

class CircuitBreaker {
  private circuits: Map<EmailProviderName, CircuitBreakerState> = new Map();
  private threshold: number;
  private resetMs: number;

  constructor(threshold: number = 5, resetMs: number = 60000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  getState(provider: EmailProviderName): CircuitState {
    const circuit = this.circuits.get(provider);
    if (!circuit) return "closed";

    // Check if circuit should transition from open to half-open
    if (circuit.state === "open" && Date.now() - circuit.lastFailure > this.resetMs) {
      circuit.state = "half-open";
    }

    return circuit.state;
  }

  recordSuccess(provider: EmailProviderName): void {
    const circuit = this.circuits.get(provider) || this.createCircuit();
    circuit.failures = 0;
    circuit.lastSuccess = Date.now();
    circuit.state = "closed";
    this.circuits.set(provider, circuit);
  }

  recordFailure(provider: EmailProviderName): void {
    const circuit = this.circuits.get(provider) || this.createCircuit();
    circuit.failures++;
    circuit.lastFailure = Date.now();

    if (circuit.failures >= this.threshold) {
      circuit.state = "open";
    }

    this.circuits.set(provider, circuit);
  }

  isAvailable(provider: EmailProviderName): boolean {
    const state = this.getState(provider);
    return state !== "open";
  }

  private createCircuit(): CircuitBreakerState {
    return {
      state: "closed",
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0,
    };
  }

  getCircuitInfo(): Record<EmailProviderName, CircuitBreakerState> {
    const info: Record<string, CircuitBreakerState> = {};
    for (const [provider, state] of this.circuits) {
      info[provider] = { ...state, state: this.getState(provider) };
    }
    return info as Record<EmailProviderName, CircuitBreakerState>;
  }
}

// ============================================================================
// Email Service
// ============================================================================

export class EmailService {
  private providers: Map<EmailProviderName, EmailProvider> = new Map();
  private config: EmailServiceConfig;
  private circuitBreaker: CircuitBreaker;
  private healthCache: Map<EmailProviderName, ProviderHealth> = new Map();
  private healthCacheExpiry: number = 0;
  private readonly HEALTH_CACHE_TTL = 60000; // 1 minute

  constructor(config: Partial<EmailServiceConfig> = {}) {
    this.config = { ...DEFAULT_EMAIL_CONFIG, ...config };
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs
    );

    // Initialize providers
    this.initializeProviders();
  }

  /**
   * Initialize all email providers
   */
  private initializeProviders(): void {
    const resend = createResendProvider();
    const brevo = createBrevoProvider();
    const awsSes = createAWSSESProvider();
    const mailersend = createMailerSendProvider();

    this.providers.set("resend", resend);
    this.providers.set("brevo", brevo);
    this.providers.set("aws_ses", awsSes);
    this.providers.set("mailersend", mailersend);
  }

  /**
   * Get a specific provider
   */
  getProvider(name: EmailProviderName): EmailProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all configured providers
   */
  getConfiguredProviders(): EmailProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.isConfigured());
  }

  /**
   * Send email with the preferred provider for the email type (no fallback)
   */
  async sendEmail(
    params: SendEmailParams,
    emailType: EmailType = "notification"
  ): Promise<SendEmailResult> {
    const priority = this.config.providerPriority[emailType] || ["resend", "brevo", "mailersend", "aws_ses"];

    // Apply defaults
    const emailParams: SendEmailParams = {
      ...params,
      from: params.from || this.config.defaultFromEmail,
      fromName: params.fromName || this.config.defaultFromName,
    };

    // Find first configured provider
    const providerName = priority.find((name) => {
      const provider = this.providers.get(name);
      return provider?.isConfigured();
    });

    if (!providerName) {
      return {
        success: false,
        provider: priority[0],
        error: "No email provider configured",
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    const provider = this.providers.get(providerName)!;
    const result = await provider.sendEmail(emailParams);

    // Track metrics
    if (result.success) {
      this.circuitBreaker.recordSuccess(providerName);
    } else {
      this.circuitBreaker.recordFailure(providerName);
    }

    return result;
  }

  /**
   * Send email with a specific provider (no failover)
   */
  async sendEmailWithProvider(
    params: SendEmailParams,
    providerName: EmailProviderName
  ): Promise<SendEmailResult> {
    const provider = this.providers.get(providerName);

    if (!provider) {
      return {
        success: false,
        provider: providerName,
        error: `Provider ${providerName} not found`,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    if (!provider.isConfigured()) {
      return {
        success: false,
        provider: providerName,
        error: `Provider ${providerName} not configured`,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }

    const emailParams: SendEmailParams = {
      ...params,
      from: params.from || this.config.defaultFromEmail,
      fromName: params.fromName || this.config.defaultFromName,
    };

    const result = await provider.sendEmail(emailParams);

    // Update circuit breaker
    if (result.success) {
      this.circuitBreaker.recordSuccess(providerName);
    } else {
      this.circuitBreaker.recordFailure(providerName);
    }

    // Record metrics asynchronously (don't block response)
    this.recordSendMetrics(providerName, result).catch(() => {});

    return result;
  }

  /**
   * Record send metrics to database for quota tracking
   */
  private async recordSendMetrics(
    providerName: EmailProviderName,
    result: SendEmailResult
  ): Promise<void> {
    try {
      // Dynamic import to avoid circular dependency
      const { getSupabaseClient } = await import("../supabase.ts");
      const supabase = getSupabaseClient();

      await supabase.rpc("record_email_send", {
        p_provider: providerName,
        p_success: result.success,
        p_latency_ms: result.latencyMs,
        p_message_id: result.messageId || null,
      });
    } catch (error) {
      // Log but don't fail the email send
      console.warn(`[email-service] Failed to record metrics: ${error}`);
    }
  }

  /**
   * Check health of all providers
   */
  async checkAllHealth(forceRefresh: boolean = false): Promise<ProviderHealth[]> {
    // Return cached if valid
    if (!forceRefresh && this.healthCacheExpiry > Date.now() && this.healthCache.size > 0) {
      return Array.from(this.healthCache.values());
    }

    const healthChecks = await Promise.all(
      Array.from(this.providers.entries()).map(async ([name, provider]) => {
        const health = await provider.checkHealth();
        this.healthCache.set(name, health);
        return health;
      })
    );

    this.healthCacheExpiry = Date.now() + this.HEALTH_CACHE_TTL;
    return healthChecks;
  }

  /**
   * Get the best available provider based on health
   */
  async getBestProvider(emailType: EmailType = "notification"): Promise<EmailProviderName | null> {
    const health = await this.checkAllHealth();
    const priority = this.config.providerPriority[emailType] || ["resend", "brevo", "mailersend", "aws_ses"];

    // Sort by priority, then by health score
    const available = health
      .filter((h) => h.configured && h.status !== "error")
      .filter((h) => this.circuitBreaker.isAvailable(h.provider))
      .sort((a, b) => {
        const aPriority = priority.indexOf(a.provider);
        const bPriority = priority.indexOf(b.provider);

        // If same priority tier, sort by health score
        if (Math.abs(aPriority - bPriority) <= 1) {
          return b.healthScore - a.healthScore;
        }

        return aPriority - bPriority;
      });

    return available[0]?.provider || null;
  }

  /**
   * Get service status summary
   */
  async getStatus(): Promise<{
    providers: ProviderHealth[];
    circuits: Record<EmailProviderName, CircuitBreakerState>;
    config: EmailServiceConfig;
  }> {
    const providers = await this.checkAllHealth();
    const circuits = this.circuitBreaker.getCircuitInfo();

    return {
      providers,
      circuits,
      config: this.config,
    };
  }

  /**
   * Get debug info for all providers
   */
  getDebugInfo(): Record<EmailProviderName, Record<string, unknown>> {
    const info: Record<string, Record<string, unknown>> = {};

    for (const [name, provider] of this.providers) {
      info[name] = provider.getDebugInfo();
    }

    return info as Record<EmailProviderName, Record<string, unknown>>;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let emailServiceInstance: EmailService | null = null;

/**
 * Get the singleton email service instance
 */
export function getEmailService(config?: Partial<EmailServiceConfig>): EmailService {
  if (!emailServiceInstance) {
    emailServiceInstance = new EmailService(config);
  }
  return emailServiceInstance;
}

/**
 * Reset the email service (useful for testing)
 */
export function resetEmailService(): void {
  emailServiceInstance = null;
}

// ============================================================================
// Convenience Exports
// ============================================================================

export { ResendProvider, BrevoProvider, AWSSESProvider, MailerSendProvider };
export { createResendProvider, createBrevoProvider, createAWSSESProvider, createMailerSendProvider };
