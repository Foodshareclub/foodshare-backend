/**
 * Email Service - Unified Email Provider Orchestration
 *
 * Features:
 * - Multi-provider support (no automatic fallback)
 * - Uses first configured provider per email type
 * - Health monitoring and metrics tracking
 * - Configurable priority by email type
 * - Database-driven template support with caching
 * - Hardcoded template fallbacks for resilience
 */

import {
  CircuitState,
  DEFAULT_EMAIL_CONFIG,
  EmailProvider,
  EmailProviderName,
  EmailServiceConfig,
  EmailType,
  ProviderHealth,
  SendEmailParams,
  SendEmailResult,
} from "./types.ts";
import { createResendProvider, ResendProvider } from "./resend-provider.ts";
import { BrevoProvider, createBrevoProvider } from "./brevo-provider.ts";
import { AWSSESProvider, createAWSSESProvider } from "./aws-ses-provider.ts";
import { createMailerSendProvider, MailerSendProvider } from "./mailersend-provider.ts";
import { cache } from "../cache.ts";
import { logger } from "../logger.ts";

// ============================================================================
// Feature Flag
// ============================================================================

const USE_DB_TEMPLATES = Deno.env.get("USE_DB_TEMPLATES") !== "false";
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Template Types
// ============================================================================

interface TemplateVariable {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "url";
  required: boolean;
  default?: unknown;
}

interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  category: string;
  subject: string;
  html_content: string;
  text_content: string | null;
  variables: TemplateVariable[];
  metadata: Record<string, unknown>;
  version: number;
}

export interface SendTemplateEmailParams {
  to: string | string[];
  slug: string;
  variables: Record<string, unknown>;
  from?: string;
  fromName?: string;
  replyTo?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

// ============================================================================
// Template Rendering Utilities
// ============================================================================

function renderTemplateString(template: string, variables: Record<string, unknown>): string {
  if (!template) return "";

  let result = template;

  // Replace {{variable}} syntax (Mustache-style)
  result = result.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, key) => {
    const trimmedKey = key.trim();
    const value = getNestedValue(variables, trimmedKey);
    return value !== undefined ? String(value) : "";
  });

  // Replace {{ .Variable }} syntax (Go-style)
  result = result.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
    return value !== undefined ? String(value) : "";
  });

  return result;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function buildFinalVariables(
  templateVars: TemplateVariable[],
  inputVars: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const v of templateVars) {
    if (v.name in inputVars) {
      result[v.name] = inputVars[v.name];
    } else if (v.default !== undefined) {
      result[v.name] = v.default;
    }
  }

  // Also include any extra variables not in schema
  for (const [key, value] of Object.entries(inputVars)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }

  return result;
}

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
      this.config.circuitBreakerResetMs,
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
    emailType: EmailType = "notification",
  ): Promise<SendEmailResult> {
    const priority = this.config.providerPriority[emailType] ||
      ["resend", "brevo", "mailersend", "aws_ses"];

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
    providerName: EmailProviderName,
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
    result: SendEmailResult,
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
      }),
    );

    this.healthCacheExpiry = Date.now() + this.HEALTH_CACHE_TTL;
    return healthChecks;
  }

  /**
   * Get the best available provider based on health
   */
  async getBestProvider(emailType: EmailType = "notification"): Promise<EmailProviderName | null> {
    const health = await this.checkAllHealth();
    const priority = this.config.providerPriority[emailType] ||
      ["resend", "brevo", "mailersend", "aws_ses"];

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

  // ============================================================================
  // Database Template Methods
  // ============================================================================

  /**
   * Fetch a template from the database with caching
   */
  private async fetchTemplateBySlug(slug: string): Promise<EmailTemplate | null> {
    if (!USE_DB_TEMPLATES) {
      logger.info("Database templates disabled via feature flag", { slug });
      return null;
    }

    const cacheKey = `email_template:${slug}`;

    // Check cache first
    const cached = cache.get<EmailTemplate>(cacheKey);
    if (cached) {
      logger.info("Template cache hit", { slug });
      return cached;
    }

    try {
      const { getSupabaseClient } = await import("../supabase.ts");
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from("email_templates")
        .select(
          "id, slug, name, category, subject, html_content, text_content, variables, metadata, version",
        )
        .eq("slug", slug)
        .eq("is_active", true)
        .single();

      if (error || !data) {
        logger.warn("Template not found in database", { slug, error: error?.message });
        return null;
      }

      // Cache the template
      cache.set(cacheKey, data, TEMPLATE_CACHE_TTL_MS);
      logger.info("Template fetched and cached", { slug, version: data.version });

      return data as EmailTemplate;
    } catch (error) {
      logger.error(
        "Failed to fetch template from database",
        error instanceof Error ? error : new Error(String(error)),
      );
      return null;
    }
  }

  /**
   * Send email using a database template
   * Falls back to hardcoded templates if database lookup fails
   */
  async sendTemplateEmail(
    params: SendTemplateEmailParams,
    emailType: EmailType = "notification",
  ): Promise<SendEmailResult> {
    const { to, slug, variables, from, fromName, replyTo, tags, metadata } = params;

    // Try to fetch template from database
    const template = await this.fetchTemplateBySlug(slug);

    if (template) {
      // Render template with variables
      const templateVars = (template.variables || []) as TemplateVariable[];
      const finalVars = buildFinalVariables(templateVars, variables);

      const subject = renderTemplateString(template.subject, finalVars);
      const html = renderTemplateString(template.html_content, finalVars);
      const text = template.text_content
        ? renderTemplateString(template.text_content, finalVars)
        : undefined;

      logger.info("Sending email with database template", {
        slug,
        templateVersion: template.version,
        emailType,
      });

      return this.sendEmail(
        {
          to,
          subject,
          html,
          text,
          from,
          fromName,
          replyTo,
          tags,
          metadata: {
            ...metadata,
            template_slug: slug,
            template_version: String(template.version),
          },
        },
        emailType,
      );
    }

    // Fall back to hardcoded templates
    logger.warn("Falling back to hardcoded template", { slug });
    return this.sendFallbackTemplateEmail(params, emailType);
  }

  /**
   * Send email using hardcoded fallback templates
   */
  private async sendFallbackTemplateEmail(
    params: SendTemplateEmailParams,
    emailType: EmailType,
  ): Promise<SendEmailResult> {
    const { to, slug, variables, from, fromName, replyTo, tags, metadata } = params;

    try {
      // Dynamically import templates to avoid circular dependency
      const templates = await import("./templates.ts");

      let rendered: { subject: string; html: string } | null = null;

      // Map slug to hardcoded template function
      switch (slug) {
        case "welcome":
          rendered = templates.welcomeEmail({
            name: String(variables.name || "there"),
            email: String(variables.email || ""),
          });
          break;
        case "email-verification":
          rendered = templates.emailVerificationEmail({
            name: String(variables.name || "there"),
            verifyUrl: String(variables.verifyUrl || ""),
          });
          break;
        case "password-reset":
          rendered = templates.passwordResetEmail({
            name: String(variables.name || "there"),
            resetUrl: String(variables.resetUrl || ""),
            expiresIn: String(variables.expiresIn || "1 hour"),
          });
          break;
        case "chat-notification":
          rendered = templates.chatNotificationEmail({
            recipientName: String(variables.recipientName || "there"),
            senderName: String(variables.senderName || "Someone"),
            messagePreview: String(variables.messagePreview || ""),
            chatUrl: String(variables.chatUrl || ""),
          });
          break;
        case "new-listing-nearby":
          rendered = templates.newListingEmail({
            recipientName: String(variables.recipientName || "there"),
            listingTitle: String(variables.listingTitle || ""),
            listingDescription: variables.listingDescription as string | undefined,
            listingAddress: variables.listingAddress as string | undefined,
            posterName: String(variables.posterName || ""),
            listingUrl: String(variables.listingUrl || ""),
            listingType: variables.listingType as string | undefined,
          });
          break;
        case "feedback-alert":
          rendered = templates.feedbackAlertEmail({
            feedback_id: String(variables.feedbackId || ""),
            feedback_type: String(variables.feedbackType || "general"),
            subject: String(variables.subject || ""),
            submitter_name: String(variables.submitterName || ""),
            submitter_email: String(variables.submitterEmail || ""),
            message: String(variables.message || ""),
            created_at: variables.timestamp as string | undefined,
          });
          break;
        default:
          // For unknown templates, return an error
          logger.error("No fallback template available", { slug });
          return {
            success: false,
            provider: "resend" as EmailProviderName,
            error: `No fallback template available for slug: ${slug}`,
            latencyMs: 0,
            timestamp: Date.now(),
          };
      }

      if (rendered) {
        return this.sendEmail(
          {
            to,
            subject: rendered.subject,
            html: rendered.html,
            from,
            fromName,
            replyTo,
            tags,
            metadata: {
              ...metadata,
              template_slug: slug,
              template_source: "fallback",
            },
          },
          emailType,
        );
      }

      return {
        success: false,
        provider: "resend" as EmailProviderName,
        error: `Failed to render fallback template: ${slug}`,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error(
        "Failed to send fallback template email",
        error instanceof Error ? error : new Error(String(error)),
      );
      return {
        success: false,
        provider: "resend" as EmailProviderName,
        error: `Fallback template error: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Check if database templates are enabled
   */
  isDbTemplatesEnabled(): boolean {
    return USE_DB_TEMPLATES;
  }

  /**
   * Get template cache stats
   */
  getTemplateCacheStats() {
    return cache.getStats();
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

export { AWSSESProvider, BrevoProvider, MailerSendProvider, ResendProvider };
export {
  createAWSSESProvider,
  createBrevoProvider,
  createMailerSendProvider,
  createResendProvider,
};
