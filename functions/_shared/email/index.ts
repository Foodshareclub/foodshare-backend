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
export {
  EmailService,
  getEmailService,
  resetEmailService,
  type SendTemplateEmailParams,
} from "./email-service.ts";

// Templates - Component System
export { BRAND } from "./template-components.ts";
export type {
  HeaderProps,
  BulletItem,
  CTAProps,
  FooterProps,
  EmailConfig,
  StatItem,
  FeaturedItem,
} from "./template-components.ts";

export {
  documentWrapper,
  emailContainer,
  header,
  contentSection,
  greeting,
  paragraph,
  bulletList,
  infoBox,
  highlightBox,
  disclaimerBox,
  ctaButton,
  heroImage,
  statsBar,
  featuredItems,
  divider,
  signOff,
  appStoreBadges,
  socialIcons,
  footer,
  buildEmail,
  growingCommunityBox,
  formatStatNumber,
} from "./template-components.ts";

// Templates - Pre-built
export {
  welcomeTemplate,
  emailVerificationTemplate,
  passwordResetTemplate,
  chatNotificationTemplate,
  newListingTemplate,
  volunteerWelcomeTemplate,
  completeProfileTemplate,
  firstShareTipsTemplate,
  milestoneTemplate,
  reengagementTemplate,
  feedbackAlertTemplate,
  renderTemplate,
  templates,
  type TemplateSlug,
} from "./template-builder.ts";

// Templates - Legacy (backwards compatible)
export {
  welcomeEmail,
  goodbyeEmail,
  emailVerificationEmail,
  passwordResetEmail,
  feedbackAlertEmail,
  newListingEmail,
  chatNotificationEmail,
  notificationEmail,
  digestEmail,
} from "./templates.ts";
