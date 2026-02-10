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
  CircuitState,
  EmailProvider,
  EmailProviderName,
  EmailServiceConfig,
  EmailType,
  ProviderConfig,
  ProviderHealth,
  ProviderQuota,
  SendEmailParams,
  SendEmailResult,
} from "./types.ts";

export { DEFAULT_EMAIL_CONFIG, PROVIDER_LIMITS } from "./types.ts";

// Providers
export { createResendProvider, ResendProvider } from "./resend-provider.ts";
export { BrevoProvider, createBrevoProvider } from "./brevo-provider.ts";
export { AWSSESProvider, createAWSSESProvider } from "./aws-ses-provider.ts";
export { createMailerSendProvider, MailerSendProvider } from "./mailersend-provider.ts";

// Service
export {
  EmailService,
  getEmailService,
  resetEmailService,
  type SendTemplateEmailParams,
} from "./email-service.ts";

// Templates - Component System
export { BRAND } from "./template-components.ts";
export type {
  BulletItem,
  CTAProps,
  EmailConfig,
  FeaturedItem,
  FooterProps,
  HeaderProps,
  StatItem,
} from "./template-components.ts";

export {
  appStoreBadges,
  buildEmail,
  bulletList,
  contentSection,
  ctaButton,
  disclaimerBox,
  divider,
  documentWrapper,
  emailContainer,
  featuredItems,
  footer,
  formatStatNumber,
  greeting,
  growingCommunityBox,
  header,
  heroImage,
  highlightBox,
  infoBox,
  paragraph,
  signOff,
  socialIcons,
  statsBar,
} from "./template-components.ts";

// Templates - Pre-built
export {
  chatNotificationTemplate,
  completeProfileTemplate,
  emailVerificationTemplate,
  feedbackAlertTemplate,
  firstShareTipsTemplate,
  milestoneTemplate,
  newListingTemplate,
  passwordResetTemplate,
  reengagementTemplate,
  renderTemplate,
  templates,
  type TemplateSlug,
  volunteerWelcomeTemplate,
  welcomeTemplate,
} from "./template-builder.ts";

// Templates - Legacy (backwards compatible)
export {
  chatNotificationEmail,
  digestEmail,
  emailVerificationEmail,
  feedbackAlertEmail,
  goodbyeEmail,
  newListingEmail,
  notificationEmail,
  passwordResetEmail,
  welcomeEmail,
} from "./templates.ts";
