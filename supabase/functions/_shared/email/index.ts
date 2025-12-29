/**
 * Email Module - Unified Email Provider System
 *
 * Usage:
 * ```typescript
 * import { getEmailService, EmailType } from "../_shared/email/index.ts";
 *
 * const emailService = getEmailService();
 *
 * // Send with automatic provider selection
 * const result = await emailService.sendEmail({
 *   to: "user@example.com",
 *   subject: "Welcome!",
 *   html: "<h1>Hello</h1>",
 * }, "welcome");
 *
 * // Send with specific provider
 * const result = await emailService.sendEmailWithProvider({
 *   to: "user@example.com",
 *   subject: "Welcome!",
 *   html: "<h1>Hello</h1>",
 * }, "resend");
 *
 * // Check health
 * const health = await emailService.checkAllHealth();
 * ```
 */

// Types
export type {
  EmailProviderName,
  EmailType,
  CircuitState,
  SendEmailParams,
  SendEmailResult,
  ProviderHealth,
  ProviderQuota,
  EmailProvider,
  ProviderConfig,
  EmailServiceConfig,
} from "./types.ts";

export { DEFAULT_EMAIL_CONFIG, PROVIDER_LIMITS } from "./types.ts";

// Providers
export { ResendProvider, createResendProvider } from "./resend-provider.ts";
export { BrevoProvider, createBrevoProvider } from "./brevo-provider.ts";
export { AWSSESProvider, createAWSSESProvider } from "./aws-ses-provider.ts";
export { MailerSendProvider, createMailerSendProvider } from "./mailersend-provider.ts";

// Service
export { EmailService, getEmailService, resetEmailService } from "./email-service.ts";
