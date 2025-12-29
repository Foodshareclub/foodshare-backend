/**
 * Email Provider Types & Interfaces
 *
 * Shared type definitions for the email provider system
 */

// ============================================================================
// Core Types
// ============================================================================

export type EmailProviderName = "resend" | "brevo" | "aws_ses" | "mailersend";

export type EmailType =
  | "auth"
  | "chat"
  | "food_listing"
  | "feedback"
  | "review_reminder"
  | "newsletter"
  | "announcement"
  | "welcome"
  | "goodbye"
  | "notification";

export type CircuitState = "closed" | "open" | "half-open";

// ============================================================================
// Email Params & Results
// ============================================================================

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface SendEmailResult {
  success: boolean;
  provider: EmailProviderName;
  messageId?: string;
  error?: string;
  latencyMs: number;
  timestamp: number;
}

// ============================================================================
// Provider Health & Quota
// ============================================================================

export interface ProviderHealth {
  provider: EmailProviderName;
  status: "ok" | "degraded" | "error" | "unconfigured";
  healthScore: number; // 0-100
  latencyMs: number;
  message: string;
  configured: boolean;
  lastChecked: number;
}

export interface ProviderQuota {
  provider: EmailProviderName;
  daily: {
    sent: number;
    limit: number;
    remaining: number;
    percentUsed: number;
  };
  monthly?: {
    sent: number;
    limit: number;
    remaining: number;
    percentUsed: number;
  };
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface EmailProvider {
  /** Provider identifier */
  readonly name: EmailProviderName;

  /** Check if provider is configured with required credentials */
  isConfigured(): boolean;

  /** Send an email */
  sendEmail(params: SendEmailParams): Promise<SendEmailResult>;

  /** Check provider health/connectivity */
  checkHealth(): Promise<ProviderHealth>;

  /** Get current quota (if supported) */
  getQuota?(): Promise<ProviderQuota>;

  /** Get debug info (masked credentials) */
  getDebugInfo(): Record<string, unknown>;
}

// ============================================================================
// Provider Factory Config
// ============================================================================

export interface ProviderConfig {
  resend?: {
    apiKey: string;
    fromEmail?: string;
    fromName?: string;
  };
  brevo?: {
    apiKey: string;
    fromEmail?: string;
    fromName?: string;
  };
  aws_ses?: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    fromEmail?: string;
    fromName?: string;
  };
  mailersend?: {
    apiKey: string;
    fromEmail?: string;
    fromName?: string;
  };
}

// ============================================================================
// Email Service Config
// ============================================================================

export interface EmailServiceConfig {
  /** Default from email */
  defaultFromEmail: string;
  /** Default from name */
  defaultFromName: string;
  /** Provider priority by email type */
  providerPriority: Record<EmailType, EmailProviderName[]>;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Enable circuit breaker */
  circuitBreakerEnabled: boolean;
  /** Circuit breaker threshold (failures before opening) */
  circuitBreakerThreshold: number;
  /** Circuit breaker reset time in ms */
  circuitBreakerResetMs: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_EMAIL_CONFIG: EmailServiceConfig = {
  defaultFromEmail: "contact@foodshare.club",
  defaultFromName: "FoodShare",
  providerPriority: {
    auth: ["resend", "brevo", "mailersend", "aws_ses"],
    chat: ["brevo", "mailersend", "resend", "aws_ses"],
    food_listing: ["brevo", "mailersend", "resend", "aws_ses"],
    feedback: ["brevo", "mailersend", "resend", "aws_ses"],
    review_reminder: ["brevo", "mailersend", "resend", "aws_ses"],
    newsletter: ["brevo", "mailersend", "aws_ses", "resend"],
    announcement: ["brevo", "mailersend", "aws_ses", "resend"],
    welcome: ["resend", "brevo", "mailersend", "aws_ses"],
    goodbye: ["resend", "brevo", "mailersend", "aws_ses"],
    notification: ["resend", "brevo", "mailersend", "aws_ses"],
  },
  timeoutMs: 10000,
  circuitBreakerEnabled: true,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 60000,
};

// ============================================================================
// Provider Limits
// ============================================================================

export const PROVIDER_LIMITS: Record<EmailProviderName, { daily: number; monthly: number }> = {
  resend: { daily: 100, monthly: 3000 },
  brevo: { daily: 300, monthly: 9000 },
  mailersend: { daily: 400, monthly: 12000 },
  aws_ses: { daily: 200, monthly: 62000 }, // Sandbox: 200/day, Production: 50,000+/day
};
