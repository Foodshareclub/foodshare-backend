/**
 * Email Templates
 *
 * Modern, responsive HTML email templates for FoodShare.
 * All templates use the componentized system for consistent branding.
 *
 * @see template-components.ts - Reusable design components
 * @see template-builder.ts - Template implementations
 */

import {
  BRAND,
  buildEmail,
  type BulletItem,
  bulletList,
  disclaimerBox,
  greeting,
  highlightBox,
  infoBox,
  paragraph,
} from "./template-components.ts";
import { extractDisplayName } from "../display-name.ts";

// Re-export templates from the component-based builder
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

// Re-export components and BRAND for direct usage
export { BRAND } from "./template-components.ts";

// ============================================================================
// Legacy Wrapper Functions (for backwards compatibility with email-service.ts)
// ============================================================================

interface WelcomeEmailParams {
  name: string;
  email: string;
}

export function welcomeEmail(params: WelcomeEmailParams): { subject: string; html: string } {
  const displayName = extractDisplayName({ firstName: params.name, email: params.email });

  const features: BulletItem[] = [
    {
      emoji: "🍎",
      title: "Share Surplus Food",
      description: "Post your extra groceries for neighbors",
      color: BRAND.primaryColor,
    },
    {
      emoji: "🗺️",
      title: "Discover Food Near You",
      description: "Browse the map to find available food",
      color: BRAND.accentTeal,
    },
    {
      emoji: "💬",
      title: "Connect & Chat",
      description: "Message members to coordinate pickups",
      color: BRAND.accentOrange,
    },
    {
      emoji: "🏆",
      title: "Join Challenges",
      description: "Participate in community challenges",
      color: BRAND.accentPurple,
    },
  ];

  const content = `
    ${greeting(displayName)}
    ${
    paragraph(
      `We're thrilled to have you join the <strong style="color: ${BRAND.primaryColor};">FoodShare</strong> community! Get ready to embark on a journey of delicious discoveries and meaningful connections.`,
    )
  }
    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};"><strong>🌱 Here's what you can do:</strong></p>
    ${bulletList(features)}
    ${
    infoBox(
      "Your Impact Matters",
      "Together, we're reducing food waste and building stronger communities. Every meal shared makes a difference!",
      "✨",
    )
  }
  `;

  return {
    subject: "Welcome to FoodShare! 🎉",
    html: buildEmail({
      title: "Welcome to FoodShare! 🎉",
      subtitle: "Your journey to reducing food waste starts now",
      content,
      cta: { text: "Get Started", url: "https://foodshare.club/products", emoji: "🚀" },
    }),
  };
}

// ============================================================================
// Goodbye Email
// ============================================================================

interface GoodbyeEmailParams {
  name: string;
  email: string;
}

export function goodbyeEmail(params: GoodbyeEmailParams): { subject: string; html: string } {
  const displayName = extractDisplayName({ firstName: params.name, email: params.email });

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">
      Hey <strong>${displayName}</strong>,
    </p>
    ${paragraph("We're very sad to see you go. Your presence in our community will be missed.")}
    ${
    paragraph(
      "If there's anything we could have done better, please don't hesitate to let us know. Your feedback helps us improve for everyone.",
    )
  }
    ${paragraph("Remember, you're always welcome back if you change your mind! 💚")}
    ${
    infoBox(
      "Note",
      "Your account data has been securely removed. If you ever want to return, just sign up again – we'd love to have you back!",
      "📝",
    )
  }
  `;

  return {
    subject: "We'll miss you at FoodShare 😢",
    html: buildEmail({
      title: "We're Sad to See You Go 😢",
      subtitle: "We hope to see you again soon",
      content,
      cta: { text: "Give Feedback", url: "https://foodshare.club/feedback", emoji: "📝" },
    }),
  };
}

// ============================================================================
// Email Verification
// ============================================================================

interface EmailVerificationParams {
  name: string;
  verifyUrl: string;
}

export function emailVerificationEmail(params: EmailVerificationParams): {
  subject: string;
  html: string;
} {
  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">Thanks for signing up for <strong style="color: ${BRAND.primaryColor};">FoodShare</strong>! 🥗</p>
    ${
    paragraph(
      "We're excited to have you join our community dedicated to reducing food waste and sharing delicious meals. To complete your registration and start making a difference, please confirm your email address below:",
    )
  }
    ${
    infoBox(
      "What happens next?",
      "Once confirmed, your email will be uniquely associated with your account, and you'll gain full access to share and discover food in your community.",
      "✨",
    )
  }
    ${
    disclaimerBox(
      `<strong style="color: ${BRAND.textMuted};">Didn't sign up?</strong><br>If you didn't register with FoodShare, you can safely ignore this email.`,
    )
  }
  `;

  return {
    subject: "Confirm your email to join FoodShare! ✉️",
    html: buildEmail({
      title: "Welcome to FoodShare! 🎉",
      subtitle: "Let's confirm your email to get started",
      content,
      cta: { text: "Confirm Your Email", url: params.verifyUrl, emoji: "✓" },
    }),
  };
}

// ============================================================================
// Password Reset
// ============================================================================

interface PasswordResetParams {
  name: string;
  resetUrl: string;
  expiresIn?: string;
}

export function passwordResetEmail(params: PasswordResetParams): { subject: string; html: string } {
  const expiresIn = params.expiresIn || "1 hour";

  const content = `
    ${greeting(params.name, "")}
    ${
    paragraph(
      "We received a request to reset your password. Click the button below to create a new password:",
    )
  }
    ${
    infoBox(
      "Time Sensitive",
      `This link will expire in <strong>${expiresIn}</strong>. If you didn't request this, you can safely ignore this email.`,
      "⏰",
    )
  }
    ${
    disclaimerBox(
      `<strong style="color: ${BRAND.textMuted};">Didn't request this?</strong><br>If you didn't request a password reset, your account is still secure. No action is needed.`,
    )
  }
  `;

  return {
    subject: "Reset your FoodShare password 🔐",
    html: buildEmail({
      title: "Reset Your Password 🔐",
      subtitle: "Let's get you back into your account",
      content,
      cta: { text: "Reset Password", url: params.resetUrl, emoji: "🔑" },
    }),
  };
}

// ============================================================================
// Feedback Alert (Admin)
// ============================================================================

interface FeedbackAlertParams {
  feedback_id: string;
  feedback_type: string;
  subject: string;
  submitter_name: string;
  submitter_email: string;
  message: string;
  created_at?: string;
}

export function feedbackAlertEmail(params: FeedbackAlertParams): {
  subject: string;
  html: string;
} {
  const typeEmoji: Record<string, string> = {
    general: "💬",
    bug: "🐛",
    feature: "✨",
    complaint: "⚠️",
  };

  const emoji = typeEmoji[params.feedback_type] || "📩";
  const timestamp = params.created_at
    ? new Date(params.created_at).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    })
    : new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const feedbackBox = `
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Type:</strong> ${emoji} ${params.feedback_type}</p>
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Subject:</strong> ${params.subject}</p>
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">From:</strong> ${params.submitter_name} (<a href="mailto:${params.submitter_email}" style="color: ${BRAND.primaryColor};">${params.submitter_email}</a>)</p>
    <p style="margin: 0 0 16px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Submitted:</strong> ${timestamp}</p>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
    <p style="margin: 0; font-size: 15px; line-height: 1.7; color: ${BRAND.textSecondary}; white-space: pre-wrap;">${params.message}</p>
  `;

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">New feedback has been submitted:</p>
    ${highlightBox(feedbackBox)}
    <p style="margin: 0; font-size: 13px; color: ${BRAND.textLight};">Feedback ID: ${params.feedback_id}</p>
  `;

  return {
    subject: `${emoji} New Feedback: ${params.subject}`,
    html: buildEmail({
      title: "New Feedback Received",
      subtitle: `${params.feedback_type} feedback from ${params.submitter_name}`,
      content,
      cta: { text: "View in Dashboard", url: "https://foodshare.club/admin/feedback", emoji: "📋" },
      footer: { minimal: true, showSocialLinks: false },
    }),
  };
}

// ============================================================================
// New Listing Notification
// ============================================================================

interface NewListingEmailParams {
  recipientName: string;
  listingTitle: string;
  listingDescription?: string;
  listingAddress?: string;
  posterName: string;
  listingUrl: string;
  listingType?: string;
}

export function newListingEmail(params: NewListingEmailParams): { subject: string; html: string } {
  const typeEmoji: Record<string, string> = {
    food: "🍎",
    request: "🙋",
    fridge: "🧊",
    foodbank: "🏦",
    default: "📦",
  };

  const emoji = typeEmoji[params.listingType || "default"] || typeEmoji.default;
  const listingType = params.listingType || "food";
  const shortDesc = params.listingDescription
    ? params.listingDescription.length > 150
      ? params.listingDescription.substring(0, 150) + "..."
      : params.listingDescription
    : "";

  const listingBox = `
    <p style="font-size: 20px; font-weight: 700; margin: 0 0 12px; color: ${BRAND.textPrimary};">${emoji} ${params.listingTitle}</p>
    ${
    params.listingAddress
      ? `<p style="margin: 0 0 8px; color: ${BRAND.textMuted}; font-size: 14px;">📍 ${params.listingAddress}</p>`
      : ""
  }
    ${
    shortDesc
      ? `<p style="margin: 12px 0 0; font-size: 15px; line-height: 1.6; color: ${BRAND.textSecondary};">${shortDesc}</p>`
      : ""
  }
    <p style="margin: 12px 0 0; color: ${BRAND.textLight}; font-size: 14px;">Posted by <strong style="color: ${BRAND.textSecondary};">${params.posterName}</strong></p>
  `;

  const content = `
    ${greeting(params.recipientName)}
    ${paragraph(`Great news! A new ${listingType} listing is available near you:`)}
    ${highlightBox(listingBox)}
    ${paragraph("Don't miss out – items go fast! 🏃‍♂️", "0")}
  `;

  return {
    subject: `${emoji} New ${listingType} available: ${params.listingTitle}`,
    html: buildEmail({
      title: "New Listing Near You! 📍",
      subtitle: `${params.listingTitle} is now available`,
      content,
      cta: { text: "View Listing", url: params.listingUrl, emoji: "👀" },
    }),
  };
}

// ============================================================================
// Chat Notification
// ============================================================================

interface ChatNotificationParams {
  recipientName: string;
  senderName: string;
  messagePreview: string;
  chatUrl: string;
}

export function chatNotificationEmail(params: ChatNotificationParams): {
  subject: string;
  html: string;
} {
  const preview = params.messagePreview.length > 100
    ? params.messagePreview.substring(0, 100) + "..."
    : params.messagePreview;

  const content = `
    ${greeting(params.recipientName)}
    ${
    paragraph(
      `You have a new message from <strong style="color: ${BRAND.primaryColor};">${params.senderName}</strong>:`,
    )
  }
    ${
    highlightBox(
      `<p style="margin: 0; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary}; font-style: italic;">"${preview}"</p>`,
    )
  }
    ${paragraph("Reply now to continue the conversation! 💬", "0")}
  `;

  return {
    subject: `💬 New message from ${params.senderName}`,
    html: buildEmail({
      title: "You've Got a Message! 💬",
      subtitle: `${params.senderName} sent you a message`,
      content,
      cta: { text: "Reply Now", url: params.chatUrl, emoji: "💬" },
    }),
  };
}

// ============================================================================
// Notification Email
// ============================================================================

interface NotificationEmailParams {
  recipientName: string;
  title: string;
  body: string;
  category: string;
  actionUrl?: string;
  actionText?: string;
  unsubscribeUrl: string;
}

export function notificationEmail(params: NotificationEmailParams): {
  subject: string;
  html: string;
} {
  const categoryLabels: Record<string, string> = {
    posts: "listing",
    forum: "forum",
    challenges: "challenge",
    comments: "comment",
    chats: "message",
    social: "social",
    system: "system",
    marketing: "marketing",
  };

  const categoryLabel = categoryLabels[params.category] || "notification";

  const content = `
    ${greeting(params.recipientName)}
    ${
    highlightBox(
      `<p style="margin: 0; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};">${
        params.body.replace(/\n/g, "<br>")
      }</p>`,
    )
  }
    <p style="margin: 20px 0 0; font-size: 13px; color: ${BRAND.textLight}; text-align: center;">
      You received this email because you have ${categoryLabel} notifications enabled.
      <a href="${params.unsubscribeUrl}" style="color: ${BRAND.primaryColor}; text-decoration: none;">Unsubscribe</a>
    </p>
  `;

  return {
    subject: params.title,
    html: buildEmail({
      title: params.title,
      content,
      cta: {
        text: params.actionText || "View Details",
        url: params.actionUrl || "https://foodshare.club",
      },
      footer: { showUnsubscribe: true, unsubscribeUrl: params.unsubscribeUrl },
    }),
  };
}

// ============================================================================
// Digest Email
// ============================================================================

interface DigestItem {
  type: string;
  category: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  created_at: string;
}

interface DigestEmailParams {
  recipientName: string;
  frequency: "hourly" | "daily" | "weekly";
  items: DigestItem[];
  unsubscribeUrl: string;
  settingsUrl?: string;
}

export function digestEmail(params: DigestEmailParams): {
  subject: string;
  html: string;
} {
  const frequencyLabel = params.frequency === "hourly"
    ? "Hourly"
    : params.frequency === "daily"
    ? "Daily"
    : "Weekly";

  const categoryNames: Record<string, string> = {
    posts: "Listings",
    forum: "Forum",
    challenges: "Challenges",
    comments: "Comments",
    chats: "Messages",
    social: "Social",
    system: "System",
    marketing: "News",
  };

  const categoryEmoji: Record<string, string> = {
    posts: "📦",
    forum: "💬",
    challenges: "🏆",
    comments: "💭",
    chats: "📨",
    social: "👥",
    system: "⚙️",
    marketing: "📢",
  };

  // Group items by category
  const grouped: Record<string, DigestItem[]> = {};
  for (const item of params.items) {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  }

  // Build items HTML
  let itemsHtml = "";
  for (const [category, categoryItems] of Object.entries(grouped)) {
    const categoryName = categoryNames[category] || category;
    const emoji = categoryEmoji[category] || "📋";

    itemsHtml += `
      <tr>
        <td style="padding: 20px 0 10px;">
          <h3 style="margin: 0; font-size: 16px; color: ${BRAND.primaryColor}; font-weight: 600; border-bottom: 2px solid ${BRAND.primaryColor}; padding-bottom: 8px; display: inline-block;">
            ${emoji} ${categoryName} (${categoryItems.length})
          </h3>
        </td>
      </tr>`;

    for (const item of categoryItems.slice(0, 5)) {
      const bodyPreview = item.body.length > 100 ? item.body.substring(0, 100) + "..." : item.body;
      itemsHtml += `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
          <p style="margin: 0 0 4px; font-size: 15px; font-weight: 600; color: ${BRAND.textPrimary};">${item.title}</p>
          <p style="margin: 0; font-size: 14px; color: ${BRAND.textMuted}; line-height: 1.4;">${bodyPreview}</p>
        </td>
      </tr>`;
    }

    if (categoryItems.length > 5) {
      itemsHtml += `
      <tr>
        <td style="padding: 8px 0;">
          <p style="margin: 0; font-size: 13px; color: ${BRAND.textLight};">...and ${
        categoryItems.length - 5
      } more</p>
        </td>
      </tr>`;
    }
  }

  const content = `
    ${greeting(params.recipientName)}
    ${
    paragraph(
      `Here's your ${frequencyLabel.toLowerCase()} digest with <strong>${params.items.length}</strong> notification${
        params.items.length !== 1 ? "s" : ""
      }:`,
    )
  }
    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px;">
      ${itemsHtml}
    </table>
    <p style="margin: 20px 0 0; font-size: 13px; color: ${BRAND.textLight}; text-align: center;">
      <a href="${
    params.settingsUrl || "https://foodshare.club/settings/notifications"
  }" style="color: ${BRAND.primaryColor}; text-decoration: none;">Manage Preferences</a>
      &nbsp;|&nbsp;
      <a href="${params.unsubscribeUrl}" style="color: ${BRAND.primaryColor}; text-decoration: none;">Unsubscribe</a>
    </p>
  `;

  return {
    subject: `${frequencyLabel} Digest: ${params.items.length} new notification${
      params.items.length !== 1 ? "s" : ""
    }`,
    html: buildEmail({
      title: `Your ${frequencyLabel} Digest`,
      subtitle: `${params.items.length} notification${
        params.items.length !== 1 ? "s" : ""
      } to catch up on`,
      content,
      cta: { text: "Open FoodShare", url: "https://foodshare.club" },
      footer: { showUnsubscribe: true, unsubscribeUrl: params.unsubscribeUrl },
    }),
  };
}
