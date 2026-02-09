/**
 * Email Template Components
 *
 * Reusable, componentized email building blocks for consistent FoodShare branding.
 * All templates MUST use these components to ensure design consistency.
 *
 * Design inspired by best practices from Olio and other food-sharing platforms,
 * with FoodShare's unique pink branding and warm community feel.
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
  // Colors - FoodShare's vibrant pink palette
  primaryColor: "#ff2d55",
  primaryDark: "#e0264b",
  primaryGradient: "linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%)",
  footerGradient: "linear-gradient(135deg, #ff2d55 0%, #ff4270 100%)",

  // Accent colors for variety
  accentTeal: "#00A699",
  accentOrange: "#FC642D",
  accentPurple: "#8B5CF6",
  accentGreen: "#10B981",

  // Background - soft, warm tones (inspired by Olio's lavender)
  bgPrimary: "#fff5f7",      // Soft pink tint
  bgSecondary: "#fafafa",    // Light gray
  bgCard: "#ffffff",

  // Typography
  fontFamily:
    "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  textPrimary: "#363a57",
  textSecondary: "#555555",
  textMuted: "#666666",
  textLight: "#999999",

  // Layout
  maxWidth: "600px",
  borderRadius: "20px",      // Rounded corners like Olio
  cardRadius: "12px",
  buttonRadius: "50px",

  // Assets
  logoUrl:
    "https://api.foodshare.club/storage/v1/object/public/assets/logo-512.png",

  // App Store links
  appStore: {
    ios: "https://apps.apple.com/us/app/foodshare-club/id1573242804",
    android: null, // Coming soon
    iosBadge: "https://api.foodshare.club/storage/v1/object/public/assets/apple-store.png",
    androidBadge: "https://api.foodshare.club/storage/v1/object/public/assets/google-store.png",
  },

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
    instagram: "https://www.instagram.com/foodshare.club/",
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
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background-color: ${BRAND.bgPrimary}; padding: 40px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width: ${BRAND.maxWidth}; background-color: ${BRAND.bgCard}; border-radius: ${BRAND.borderRadius}; box-shadow: 0 4px 24px rgba(255, 45, 85, 0.12); overflow: hidden;">
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
  secondary?: boolean;
}

export function ctaButton({ text, url, emoji, secondary }: CTAProps): string {
  const buttonText = emoji ? `${emoji} ${text}` : text;

  if (secondary) {
    return `<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 16px 0 10px;">
      <a href="${url}" style="display: inline-block; padding: 14px 36px; background: ${BRAND.bgCard}; color: ${BRAND.primaryColor}; text-decoration: none; border-radius: ${BRAND.buttonRadius}; font-weight: 700; font-size: 15px; border: 2px solid ${BRAND.primaryColor};">${buttonText}</a>
    </td>
  </tr>
</table>`;
  }

  return `<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td align="center" style="padding: 24px 0 10px;">
      <a href="${url}" style="display: inline-block; padding: 16px 40px; background: ${BRAND.primaryColor}; color: #ffffff; text-decoration: none; border-radius: ${BRAND.buttonRadius}; font-weight: 700; font-size: 16px; box-shadow: 0 4px 16px rgba(255, 45, 85, 0.3);">${buttonText}</a>
    </td>
  </tr>
</table>`;
}

// ============================================================================
// Component: Hero Image (inspired by Olio)
// ============================================================================

export function heroImage(imageUrl: string, alt = "FoodShare community"): string {
  return `<tr>
  <td style="padding: 0;">
    <img src="${imageUrl}" alt="${alt}" style="width: 100%; height: auto; display: block;" />
  </td>
</tr>`;
}

// ============================================================================
// Component: Stats Bar (social proof - handles low numbers gracefully)
// ============================================================================

export interface StatItem {
  value: string | number;
  label: string;
  color?: string;
  hideIfZero?: boolean;
}

/**
 * Format a number for display:
 * - < 10: show exact number or hide
 * - 10-999: show exact number
 * - 1000-9999: show as "1.2K+"
 * - 10000+: show as "10K+"
 */
export function formatStatNumber(num: number): string {
  if (num < 1000) return num.toString();
  if (num < 10000) return `${(num / 1000).toFixed(1)}K+`;
  return `${Math.round(num / 1000)}K+`;
}

export function statsBar(stats: StatItem[]): string {
  // Filter out stats with zero/low values if hideIfZero is set
  const visibleStats = stats.filter(stat => {
    if (!stat.hideIfZero) return true;
    const numValue = typeof stat.value === "number" ? stat.value : parseInt(String(stat.value), 10);
    return !isNaN(numValue) && numValue > 0;
  });

  if (visibleStats.length === 0) return "";

  const statCells = visibleStats.map(stat => {
    const displayValue = typeof stat.value === "number"
      ? formatStatNumber(stat.value)
      : stat.value;

    return `
    <td align="center" style="padding: 16px 8px;">
      <p style="margin: 0; font-size: 28px; font-weight: 800; color: ${stat.color || BRAND.primaryColor};">${displayValue}</p>
      <p style="margin: 4px 0 0; font-size: 13px; color: ${BRAND.textMuted}; text-transform: uppercase; letter-spacing: 0.5px;">${stat.label}</p>
    </td>
  `;
  }).join("");

  return `<div style="margin: 24px 0; padding: 20px; background: ${BRAND.bgSecondary}; border-radius: ${BRAND.cardRadius};">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${statCells}
    </tr>
  </table>
</div>`;
}

// ============================================================================
// Component: Growing Community Message (for early-stage areas)
// ============================================================================

export function growingCommunityBox(): string {
  return `<div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, ${BRAND.bgSecondary} 0%, #fff5f7 100%); border-radius: ${BRAND.cardRadius}; text-align: center;">
  <p style="margin: 0 0 8px; font-size: 24px;">🌱</p>
  <p style="margin: 0 0 4px; font-size: 16px; font-weight: 700; color: ${BRAND.textPrimary};">You're an early member!</p>
  <p style="margin: 0; font-size: 14px; color: ${BRAND.textSecondary}; line-height: 1.5;">Our community is growing every day. Be one of the first to share in your area and help us reduce food waste together.</p>
</div>`;
}

// ============================================================================
// Component: Featured Items (show what others are sharing)
// ============================================================================

export interface FeaturedItem {
  title: string;
  imageUrl: string;
  sharedBy: string;
  timeAgo?: string;
  url?: string;
}

export function featuredItems(items: FeaturedItem[], title = "See what others are sharing"): string {
  const itemCards = items.slice(0, 3).map(item => `
    <td align="center" valign="top" style="width: 33%; padding: 8px;">
      <a href="${item.url || BRAND.company.website}" style="text-decoration: none;">
        <img src="${item.imageUrl}" alt="${item.title}" style="width: 100%; height: 120px; object-fit: cover; border-radius: 8px; display: block;" />
        <p style="margin: 10px 0 4px; font-size: 14px; font-weight: 700; color: ${BRAND.textPrimary}; line-height: 1.3;">${item.title}</p>
        <p style="margin: 0; font-size: 12px; color: ${BRAND.textMuted};">Shared by ${item.sharedBy}</p>
        ${item.timeAgo ? `<p style="margin: 2px 0 0; font-size: 11px; color: ${BRAND.textLight};">Requested in ${item.timeAgo}</p>` : ""}
      </a>
    </td>
  `).join("");

  return `<div style="margin: 30px 0; padding: 24px 0; border-top: 1px solid #f0f0f0;">
  <h3 style="margin: 0 0 20px; font-size: 20px; font-weight: 700; color: ${BRAND.textPrimary}; text-align: center;">${title}</h3>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      ${itemCards}
    </tr>
  </table>
</div>`;
}

// ============================================================================
// Component: Divider
// ============================================================================

export function divider(margin = "24px"): string {
  return `<div style="height: 1px; background: linear-gradient(90deg, transparent, #e0e0e0, transparent); margin: ${margin} 0;"></div>`;
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
// Component: Footer Sign-Off (warm closing like Olio's "Happy sharing!")
// ============================================================================

export function signOff(message = "Happy sharing!", teamName = "Team FoodShare"): string {
  return `<tr>
  <td style="background: ${BRAND.primaryGradient}; padding: 32px 30px; text-align: center; border-radius: 0 0 0 0;">
    <p style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff;">${message}</p>
    <p style="margin: 8px 0 0; font-size: 15px; color: rgba(255, 255, 255, 0.9);">${teamName}</p>
  </td>
</tr>`;
}

// ============================================================================
// Component: App Store Badges (like Olio)
// ============================================================================

export function appStoreBadges(): string {
  // Use table layout for better email client compatibility
  const iosBadgeCell = `
    <td align="center" style="padding: 0 8px;">
      <a href="${BRAND.appStore.ios}" style="display: inline-block;">
        <img src="${BRAND.appStore.iosBadge}" alt="Download on App Store" style="height: 44px; width: auto; border-radius: 8px;" />
      </a>
    </td>`;

  // Google Play - coming soon (grayed out, not clickable)
  const androidBadgeCell = BRAND.appStore.android
    ? `<td align="center" style="padding: 0 8px;">
        <a href="${BRAND.appStore.android}" style="display: inline-block;">
          <img src="${BRAND.appStore.androidBadge}" alt="Get it on Google Play" style="height: 44px; width: auto; border-radius: 8px;" />
        </a>
      </td>`
    : `<td align="center" style="padding: 0 8px;">
        <img src="${BRAND.appStore.androidBadge}" alt="Google Play" style="height: 44px; width: auto; border-radius: 8px; opacity: 0.35; filter: grayscale(100%);" />
      </td>`;

  return `<div style="margin: 20px 0; text-align: center;">
  <p style="margin: 0 0 16px; font-size: 18px; font-weight: 700; color: ${BRAND.textPrimary};">Get the FoodShare App</p>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0">
          <tr>
            ${iosBadgeCell}
            ${androidBadgeCell}
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`;
}

// ============================================================================
// Component: Footer
// ============================================================================

export interface FooterProps {
  showSocialLinks?: boolean;
  showUnsubscribe?: boolean;
  unsubscribeUrl?: string;
  showAppBadges?: boolean;
  minimal?: boolean;
  signOffMessage?: string;
}

export function footer(props: FooterProps = {}): string {
  const {
    showSocialLinks = true,
    showUnsubscribe = false,
    unsubscribeUrl,
    showAppBadges = false,
    minimal = false,
    signOffMessage,
  } = props;
  const year = new Date().getFullYear();

  // Minimal footer for admin/internal emails
  if (minimal) {
    return `<tr>
  <td style="background: ${BRAND.bgSecondary}; padding: 30px; text-align: center;">
    <img src="${BRAND.logoUrl}" alt="FoodShare" style="width: 36px; height: 36px; border-radius: 50%; margin-bottom: 10px;">
    <p style="margin: 0; font-size: 13px; color: ${BRAND.textMuted};">© ${year} ${BRAND.company.name}</p>
  </td>
</tr>`;
  }

  // Sign-off section
  const signOffSection = signOffMessage
    ? signOff(signOffMessage)
    : signOff();

  // Social icons (cleaner, without heavy styling)
  const socialSection = showSocialLinks ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px;">
      <tr>
        <td align="center">
          <a href="${BRAND.social.facebook}" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: ${BRAND.textPrimary}; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 18px; color: #ffffff; font-family: Georgia, serif; font-weight: bold;">f</span>
          </a>
          <a href="${BRAND.social.instagram}" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: ${BRAND.textPrimary}; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 14px; color: #ffffff; font-weight: 900;">IG</span>
          </a>
          <a href="${BRAND.social.twitter}" style="display: inline-block; margin: 0 8px; width: 36px; height: 36px; background: ${BRAND.textPrimary}; border-radius: 50%; line-height: 36px; text-align: center; text-decoration: none;">
            <span style="font-size: 16px; color: #ffffff;">𝕏</span>
          </a>
        </td>
      </tr>
    </table>` : "";

  // App badges section
  const appBadgesSection = showAppBadges ? appStoreBadges() : "";

  // Unsubscribe link
  const unsubscribeLink = showUnsubscribe && unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color: ${BRAND.primaryColor}; text-decoration: none;">Unsubscribe</a>`
    : "";

  return `${signOffSection}
<tr>
  <td style="background: ${BRAND.bgSecondary}; padding: 40px 30px; text-align: center;">
    ${socialSection}
    ${appBadgesSection}
    <p style="margin: 0 0 8px; font-size: 13px; color: ${BRAND.textMuted};">${BRAND.company.name}</p>
    <p style="margin: 0 0 12px; font-size: 12px; color: ${BRAND.textLight};">${BRAND.company.address}, ${BRAND.company.city}</p>
    <p style="margin: 0; font-size: 12px; color: ${BRAND.textLight};">
      © ${year} ${BRAND.company.name}. All rights reserved.
    </p>
    ${unsubscribeLink ? `<p style="margin: 16px 0 0; font-size: 12px;">${unsubscribeLink}</p>` : ""}
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
  heroImage,
  statsBar,
  formatStatNumber,
  featuredItems,
  divider,
  signOff,
  appStoreBadges,
  growingCommunityBox,
  socialIcons,
  footer,
  buildEmail,
};
