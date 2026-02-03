/**
 * Email Template Components
 *
 * Reusable, componentized email building blocks for consistent FoodShare branding.
 * All templates MUST use these components to ensure design consistency.
 *
 * @example
 * ```ts
 * const html = buildEmail({
 *   title: "Welcome!",
 *   subtitle: "Your journey starts now",
 *   content: emailContent({ greeting: "Hey John!", body: "..." }),
 *   cta: { text: "Get Started", url: "https://foodshare.club" }
 * });
 * ```
 */

// ============================================================================
// Design Tokens (Single Source of Truth)
// ============================================================================

export const BRAND = {
  // Colors
  primaryColor: "#ff2d55",
  primaryGradient: "linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%)",
  footerGradient: "linear-gradient(135deg, #ff2d55 0%, #ff4270 100%)",
  accentTeal: "#00A699",
  accentOrange: "#FC642D",
  accentPurple: "#8B5CF6",

  // Typography
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  textPrimary: "#363a57",
  textSecondary: "#555555",
  textMuted: "#666666",
  textLight: "#999999",

  // Layout
  maxWidth: "600px",
  borderRadius: "16px",
  cardRadius: "12px",
  buttonRadius: "50px",

  // Assets
  logoUrl:
    "https://***REMOVED***/storage/v1/object/public/assets/logo-512.png",

  // Company Info
  company: {
    name: "FoodShare LLC",
    ein: "USA 20231394981",
    address: "4632 Winding Way",
    city: "Sacramento, CA 95841",
    email: "support@foodshare.club",
    website: "https://foodshare.club",
    privacy: "https://foodshare.club/privacy",
    terms: "https://foodshare.club/terms",
  },

  // Social Links
  social: {
    facebook: "https://facebook.com/foodshareclub",
    twitter: "https://twitter.com/foodshareclub",
    instagram: "https://instagram.com/foodshareclub",
    linkedin: "https://linkedin.com/company/foodshareclub",
  },
} as const;

// ============================================================================
// Component: Document Wrapper
// ============================================================================

export function documentWrapper(body: string, title: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${BRAND.fontFamily}; background-color: #f0f0f0; color: ${BRAND.textPrimary};">
  ${body}
</body>
</html>`;
}

// ============================================================================
// Component: Email Container
// ============================================================================

export function emailContainer(content: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width: ${BRAND.maxWidth}; background-color: #ffffff; border-radius: ${BRAND.borderRadius}; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">
        ${content}
      </table>
    </td>
  </tr>
</table>`;
}

// ============================================================================
// Component: Header
// ============================================================================

export interface HeaderProps {
  title: string;
  subtitle?: string;
}

export function header({ title, subtitle }: HeaderProps): string {
  return `<tr>
  <td style="background: ${BRAND.primaryGradient}; padding: 50px 30px; text-align: center;">
    <img src="${BRAND.logoUrl}" alt="FoodShare Logo" style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">
    <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">${title}</h1>
    ${subtitle ? `<p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">${subtitle}</p>` : ""}
  </td>
</tr>`;
}

// ============================================================================
// Component: Content Section
// ============================================================================

export function contentSection(innerContent: string): string {
  return `<tr>
  <td style="padding: 50px 40px; background-color: #fafafa;">
    <div style="background: white; padding: 30px; border-radius: ${BRAND.cardRadius}; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
      ${innerContent}
    </div>
  </td>
</tr>`;
}

// ============================================================================
// Component: Greeting
// ============================================================================

export function greeting(name: string, emoji = "👋"): string {
  return `<p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">Hey <strong>${name}</strong>! ${emoji}</p>`;
}

// ============================================================================
// Component: Paragraph
// ============================================================================

export function paragraph(text: string, marginBottom = "24px"): string {
  return `<p style="margin: 0 0 ${marginBottom}; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};">${text}</p>`;
}

// ============================================================================
// Component: Bullet List
// ============================================================================

export interface BulletItem {
  emoji: string;
  title: string;
  description: string;
  color?: string;
}

export function bulletList(items: BulletItem[]): string {
  const listItems = items
    .map(
      (item) =>
        `<li><strong style="color: ${item.color || BRAND.primaryColor};">${item.emoji} ${item.title}</strong> – ${item.description}</li>`
    )
    .join("\n");

  return `<ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: ${BRAND.textSecondary};">
  ${listItems}
</ul>`;
}

// ============================================================================
// Component: Info Box
// ============================================================================

export function infoBox(title: string, content: string, emoji?: string): string {
  return `<div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid ${BRAND.primaryColor};">
  <p style="margin: 0; font-size: 14px; line-height: 1.6; color: ${BRAND.textMuted};"><strong style="color: ${BRAND.primaryColor};">${emoji ? emoji + " " : ""}${title}</strong><br>${content}</p>
</div>`;
}

// ============================================================================
// Component: Highlight Box (for stats, quotes, etc.)
// ============================================================================

export function highlightBox(content: string): string {
  return `<div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid ${BRAND.primaryColor};">
  ${content}
</div>`;
}

// ============================================================================
// Component: Disclaimer Box
// ============================================================================

export function disclaimerBox(content: string): string {
  return `<div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: ${BRAND.textLight}; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
  ${content}
</div>`;
}

// ============================================================================
// Component: CTA Button
// ============================================================================

export interface CTAProps {
  text: string;
  url: string;
  emoji?: string;
}

export function ctaButton({ text, url, emoji }: CTAProps): string {
  const buttonText = emoji ? `${emoji} ${text.toUpperCase()}` : text.toUpperCase();

  return `<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 24px 0 10px;">
      <a href="${url}" style="display: inline-block; padding: 18px 48px; background: ${BRAND.primaryGradient}; color: #ffffff; text-decoration: none; border-radius: ${BRAND.buttonRadius}; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">${buttonText}</a>
    </td>
  </tr>
</table>`;
}

// ============================================================================
// Component: Social Icons
// ============================================================================

function socialIcon(url: string, label: string, fontSize: string): string {
  return `<a href="${url}" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);"><strong style="font-size: ${fontSize}; color: #ffffff; font-family: ${label === "f" ? "Georgia, serif" : "Arial, sans-serif"}; font-weight: ${label === "in" ? "700" : "900"};">${label}</strong></a>`;
}

export function socialIcons(): string {
  return `<p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Connect With Us</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
  <tr>
    <td align="center">
      ${socialIcon(BRAND.social.facebook, "f", "24px")}
      ${socialIcon(BRAND.social.twitter, "𝕏", "20px")}
      ${socialIcon(BRAND.social.instagram, "IG", "22px")}
      ${socialIcon(BRAND.social.linkedin, "in", "22px")}
    </td>
  </tr>
</table>
<div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>`;
}

// ============================================================================
// Component: Footer
// ============================================================================

export interface FooterProps {
  showSocialLinks?: boolean;
  showUnsubscribe?: boolean;
  unsubscribeUrl?: string;
  minimal?: boolean;
}

export function footer(props: FooterProps = {}): string {
  const { showSocialLinks = true, showUnsubscribe = false, unsubscribeUrl, minimal = false } = props;
  const year = new Date().getFullYear();

  if (minimal) {
    return `<tr>
  <td style="background: ${BRAND.footerGradient}; padding: 30px; text-align: center;">
    <img src="${BRAND.logoUrl}" alt="FoodShare" style="width: 40px; height: 40px; border-radius: 50%; margin-bottom: 10px; border: 2px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px;">
    <p style="margin: 0; font-size: 14px; color: #ffffff; font-weight: 600;">FoodShare Admin</p>
    <p style="margin: 8px 0 0; font-size: 12px; color: rgba(255, 255, 255, 0.8);">© ${year} ${BRAND.company.name}</p>
  </td>
</tr>`;
  }

  const footerLinks = showUnsubscribe && unsubscribeUrl
    ? `<a href="${BRAND.company.website}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
       <a href="${BRAND.company.privacy}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
       <a href="${unsubscribeUrl}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📧 Unsubscribe</a>`
    : `<a href="${BRAND.company.website}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
       <a href="${BRAND.company.privacy}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
       <a href="${BRAND.company.terms}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>`;

  return `<tr>
  <td style="background: ${BRAND.footerGradient}; padding: 40px 30px; text-align: center;">
    ${showSocialLinks ? socialIcons() : ""}
    <img src="${BRAND.logoUrl}" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">
    <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">${BRAND.company.name}</p>
    <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">© ${year} ${BRAND.company.ein}<br>All Rights Reserved</p>
    <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">📍 ${BRAND.company.address}<br>${BRAND.company.city}</p>
    <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">💬 Questions? <a href="mailto:${BRAND.company.email}" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">${BRAND.company.email}</a></p>
    <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
      ${footerLinks}
    </p>
  </td>
</tr>`;
}

// ============================================================================
// Builder: Complete Email
// ============================================================================

export interface EmailConfig {
  title: string;
  subtitle?: string;
  content: string;
  cta?: CTAProps;
  footer?: FooterProps;
}

export function buildEmail(config: EmailConfig): string {
  const { title, subtitle, content, cta, footer: footerProps } = config;

  const contentWithCta = cta ? `${content}${ctaButton(cta)}` : content;

  const emailBody = emailContainer(
    header({ title, subtitle }) +
    contentSection(contentWithCta) +
    footer(footerProps)
  );

  return documentWrapper(emailBody, title);
}

// ============================================================================
// Export All
// ============================================================================

export default {
  BRAND,
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
  socialIcons,
  footer,
  buildEmail,
};
