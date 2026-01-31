/**
 * Email Templates
 *
 * Modern, responsive HTML email templates for FoodShare
 */

// ============================================================================
// Constants
// ============================================================================

const LOGO_URL =
  "https://***REMOVED***/storage/v1/object/public/assets/logo-512.png";

const SOCIAL_LINKS = {
  facebook: "https://facebook.com/foodshareclub",
  twitter: "https://twitter.com/foodshareclub",
  instagram: "https://instagram.com/foodshareclub",
  linkedin: "https://linkedin.com/company/foodshareclub",
};

const COMPANY_INFO = {
  name: "FoodShare LLC",
  ein: "USA 20231394981",
  address: "4632 Winding Way",
  city: "Sacramento, CA 95841",
  email: "support@foodshare.club",
  website: "https://foodshare.club",
  privacy: "https://foodshare.club/privacy",
  terms: "https://foodshare.club/terms",
};

// ============================================================================
// Base Template
// ============================================================================

interface BaseTemplateParams {
  title: string;
  subtitle?: string;
  preheader?: string;
  content: string;
  ctaText?: string;
  ctaUrl?: string;
  showSocialLinks?: boolean;
}

export function baseTemplate(params: BaseTemplateParams): string {
  const year = new Date().getFullYear();
  const showSocial = params.showSocialLinks !== false;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${params.title}</title>
  ${params.preheader ? `<!--[if !mso]><!--><meta name="description" content="${params.preheader}"><!--<![endif]-->` : ""}
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f0f0f0; color: #363a57;">

  <!-- Email Container -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background: linear-gradient(135deg, #f0f0f0 0%, #e5e5e5 100%); padding: 60px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; box-shadow: 0 10px 40px rgba(255, 45, 85, 0.2); overflow: hidden;">

          <!-- Header with Logo & Gradient -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff5177 50%, #ff6b8a 100%); padding: 50px 30px; text-align: center;">
              <img src="${LOGO_URL}"
                   alt="FoodShare Logo"
                   style="width: 100px; height: 100px; border-radius: 50%; margin-bottom: 24px; border: 5px solid rgba(255, 255, 255, 0.4); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); background: white; padding: 4px;">

              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.25); letter-spacing: -0.5px;">
                ${params.title}
              </h1>

              ${
                params.subtitle
                  ? `<p style="margin: 12px 0 0; color: rgba(255, 255, 255, 0.95); font-size: 16px; font-weight: 500; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);">
                ${params.subtitle}
              </p>`
                  : ""
              }
            </td>
          </tr>

          <!-- Content Section -->
          <tr>
            <td style="padding: 50px 40px; background-color: #fafafa;">

              <!-- Main Message -->
              <div style="background: white; padding: 30px; border-radius: 12px; border: 2px solid #f0f0f0; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);">
                ${params.content}

                ${
                  params.ctaText && params.ctaUrl
                    ? `
                <!-- CTA Button -->
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding: 24px 0 10px;">
                      <a href="${params.ctaUrl}"
                         style="display: inline-block; padding: 18px 48px; background: linear-gradient(135deg, #ff2d55 0%, #ff4873 50%, #ff5e8a 100%); color: #ffffff; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 6px 24px rgba(255, 45, 85, 0.35), 0 2px 8px rgba(255, 45, 85, 0.2); text-transform: uppercase; letter-spacing: 1px; border: 2px solid rgba(255, 255, 255, 0.3);">
                        ${params.ctaText}
                      </a>
                    </td>
                  </tr>
                </table>`
                    : ""
                }
              </div>

            </td>
          </tr>

          <!-- Footer Section -->
          <tr>
            <td style="background: linear-gradient(135deg, #ff2d55 0%, #ff4270 100%); padding: 40px 30px; text-align: center;">

              ${
                showSocial
                  ? `
              <!-- Social Media Icons -->
              <p style="margin: 0 0 10px; font-size: 15px; color: rgba(255, 255, 255, 0.9); font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">
                Connect With Us
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 15px 0 25px;">
                <tr>
                  <td align="center">
                    <a href="${SOCIAL_LINKS.facebook}" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);">
                      <strong style="font-size: 24px; color: #ffffff; font-family: Georgia, serif;">f</strong>
                    </a>
                    <a href="${SOCIAL_LINKS.twitter}" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);">
                      <strong style="font-size: 20px; color: #ffffff;">𝕏</strong>
                    </a>
                    <a href="${SOCIAL_LINKS.instagram}" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);">
                      <strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 900;">IG</strong>
                    </a>
                    <a href="${SOCIAL_LINKS.linkedin}" style="display: inline-block; margin: 0 6px; width: 48px; height: 48px; background: rgba(255, 255, 255, 0.25); border-radius: 50%; line-height: 48px; text-align: center; text-decoration: none; border: 2px solid rgba(255, 255, 255, 0.4);">
                      <strong style="font-size: 22px; color: #ffffff; font-family: Arial, sans-serif; font-weight: 700;">in</strong>
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <div style="height: 1px; background: rgba(255, 255, 255, 0.3); margin: 25px auto; max-width: 400px;"></div>
              `
                  : ""
              }

              <!-- Footer Logo -->
              <img src="${LOGO_URL}" alt="FoodShare" style="width: 45px; height: 45px; border-radius: 50%; margin: 15px 0 10px; border: 3px solid rgba(255, 255, 255, 0.4); background: white; padding: 2px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);">

              <!-- Company Info -->
              <p style="margin: 12px 0 0; font-size: 16px; line-height: 1.5; color: #ffffff; font-weight: 700;">
                ${COMPANY_INFO.name}
              </p>

              <p style="margin: 8px 0 0; font-size: 13px; line-height: 1.5; color: rgba(255, 255, 255, 0.9);">
                &copy; ${year} ${COMPANY_INFO.ein}<br>
                All Rights Reserved
              </p>

              <p style="margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: rgba(255, 255, 255, 0.9);">
                📍 ${COMPANY_INFO.address}<br>
                ${COMPANY_INFO.city}
              </p>

              <!-- Contact -->
              <p style="margin: 20px 0 0; font-size: 14px; color: rgba(255, 255, 255, 0.95);">
                💬 Questions? <a href="mailto:${COMPANY_INFO.email}" style="color: #ffffff; text-decoration: none; font-weight: 700; border-bottom: 2px solid rgba(255, 255, 255, 0.5);">${COMPANY_INFO.email}</a>
              </p>

              <!-- Footer Links -->
              <p style="margin: 25px 0 0; font-size: 13px; color: rgba(255, 255, 255, 0.9); line-height: 2;">
                <a href="${COMPANY_INFO.website}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🏠 Visit Us</a>
                <a href="${COMPANY_INFO.privacy}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">🔒 Privacy</a>
                <a href="${COMPANY_INFO.terms}" style="color: #ffffff; text-decoration: none; margin: 0 8px; padding: 8px 16px; background: rgba(255, 255, 255, 0.15); border-radius: 20px; display: inline-block; font-weight: 600;">📋 Terms</a>
              </p>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ============================================================================
// Helper: Info Box
// ============================================================================

function infoBox(content: string, icon?: string): string {
  return `
    <div style="margin: 24px 0 0; padding: 20px; background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 8px; border-left: 4px solid #ff2d55;">
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #666;">
        ${icon ? `<strong style="color: #ff2d55;">${icon}</strong><br>` : ""}
        ${content}
      </p>
    </div>`;
}

// ============================================================================
// Helper: Disclaimer Box
// ============================================================================

function disclaimerBox(content: string): string {
  return `
    <div style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #999; text-align: center; padding: 20px; background-color: #fafafa; border-radius: 8px; border: 1px dashed #e0e0e0;">
      ${content}
    </div>`;
}

// ============================================================================
// Welcome Email
// ============================================================================

interface WelcomeEmailParams {
  name: string;
  email: string;
}

export function welcomeEmail(params: WelcomeEmailParams): { subject: string; html: string } {
  const displayName = params.name || params.email.split("@")[0];

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${displayName}</strong>! 👋
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      We're thrilled to have you join the <strong style="color: #ff2d55;">FoodShare</strong> community! Get ready to embark on a journey of delicious discoveries and meaningful connections.
    </p>

    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: #555;">
      <strong>🌱 Here's what you can do:</strong>
    </p>

    <ul style="margin: 0 0 24px; padding-left: 24px; font-size: 15px; line-height: 2; color: #555;">
      <li><strong style="color: #ff2d55;">🍎 Share Surplus Food</strong> – Post your extra groceries for neighbors</li>
      <li><strong style="color: #00A699;">🗺️ Discover Food Near You</strong> – Browse the map to find available food</li>
      <li><strong style="color: #FC642D;">💬 Connect & Chat</strong> – Message members to coordinate pickups</li>
      <li><strong style="color: #8B5CF6;">🏆 Join Challenges</strong> – Participate in community challenges</li>
    </ul>

    ${infoBox("Together, we're reducing food waste and building stronger communities. Every meal shared makes a difference!", "✨ Your Impact Matters")}
  `;

  return {
    subject: "Welcome to FoodShare! 🎉",
    html: baseTemplate({
      title: "Welcome to FoodShare! 🎉",
      subtitle: "Your journey to reducing food waste starts now",
      preheader: "Start sharing and discovering food in your community",
      content,
      ctaText: "🚀 Get Started",
      ctaUrl: "https://foodshare.club/products",
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
  const displayName = params.name || params.email.split("@")[0];

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${displayName}</strong>,
    </p>

    <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.7; color: #555;">
      We're very sad to see you go. Your presence in our community will be missed.
    </p>

    <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.7; color: #555;">
      If there's anything we could have done better, please don't hesitate to let us know. Your feedback helps us improve for everyone.
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      Remember, you're always welcome back if you change your mind! 💚
    </p>

    ${infoBox("Your account data has been securely removed. If you ever want to return, just sign up again – we'd love to have you back!", "📝 Note")}
  `;

  return {
    subject: "We'll miss you at FoodShare 😢",
    html: baseTemplate({
      title: "We're Sad to See You Go 😢",
      subtitle: "We hope to see you again soon",
      preheader: "Your FoodShare account has been deleted",
      content,
      ctaText: "📝 Give Feedback",
      ctaUrl: "https://foodshare.club/feedback",
    }),
  };
}

// ============================================================================
// Email Verification / Confirmation
// ============================================================================

interface EmailVerificationParams {
  name: string;
  verifyUrl: string;
}

export function emailVerificationEmail(params: EmailVerificationParams): {
  subject: string;
  html: string;
} {
  const displayName = params.name || "there";

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Thanks for signing up for <strong style="color: #ff2d55;">FoodShare</strong>! 🥗
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      We're excited to have you join our community dedicated to reducing food waste and sharing delicious meals. To complete your registration and start making a difference, please confirm your email address below:
    </p>

    ${infoBox("Once confirmed, your email will be uniquely associated with your account, and you'll gain full access to share and discover food in your community.", "✨ What happens next?")}

    ${disclaimerBox("<strong style=\"color: #666;\">Didn't sign up?</strong><br>If you didn't register with FoodShare, you can safely ignore this email.")}
  `;

  return {
    subject: "Confirm your email to join FoodShare! ✉️",
    html: baseTemplate({
      title: "Welcome to FoodShare! 🎉",
      subtitle: "Let's confirm your email to get started",
      preheader: "One click to confirm your FoodShare account",
      content,
      ctaText: "✓ Confirm Your Email",
      ctaUrl: params.verifyUrl,
    }),
  };
}

// ============================================================================
// Password Reset Email
// ============================================================================

interface PasswordResetParams {
  name: string;
  resetUrl: string;
  expiresIn?: string;
}

export function passwordResetEmail(params: PasswordResetParams): { subject: string; html: string } {
  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${params.name}</strong>,
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      We received a request to reset your password. Click the button below to create a new password:
    </p>

    ${infoBox(`This link will expire in <strong>${params.expiresIn || "1 hour"}</strong>. If you didn't request this, you can safely ignore this email.`, "⏰ Time Sensitive")}

    ${disclaimerBox("<strong style=\"color: #666;\">Didn't request this?</strong><br>If you didn't request a password reset, your account is still secure. No action is needed.")}
  `;

  return {
    subject: "Reset your FoodShare password 🔐",
    html: baseTemplate({
      title: "Reset Your Password 🔐",
      subtitle: "Let's get you back into your account",
      preheader: "Click to reset your FoodShare password",
      content,
      ctaText: "🔑 Reset Password",
      ctaUrl: params.resetUrl,
    }),
  };
}

// ============================================================================
// Feedback Alert Email (for support team)
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

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      New feedback has been submitted:
    </p>

    <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
      <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Type:</strong> ${emoji} ${params.feedback_type}</p>
      <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Subject:</strong> ${params.subject}</p>
      <p style="margin: 0 0 12px; font-size: 15px; color: #555;"><strong style="color: #363a57;">From:</strong> ${params.submitter_name} (<a href="mailto:${params.submitter_email}" style="color: #ff2d55;">${params.submitter_email}</a>)</p>
      <p style="margin: 0 0 16px; font-size: 15px; color: #555;"><strong style="color: #363a57;">Submitted:</strong> ${timestamp}</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
      <p style="margin: 0; font-size: 15px; line-height: 1.7; color: #555; white-space: pre-wrap;">${params.message}</p>
    </div>

    <p style="margin: 0; font-size: 13px; color: #999;">Feedback ID: ${params.feedback_id}</p>
  `;

  return {
    subject: `${emoji} New Feedback: ${params.subject}`,
    html: baseTemplate({
      title: "New Feedback Received",
      subtitle: `${params.feedback_type} feedback from ${params.submitter_name}`,
      preheader: `${params.feedback_type} feedback from ${params.submitter_name}`,
      content,
      ctaText: "View in Dashboard",
      ctaUrl: "https://foodshare.club/admin/feedback",
      showSocialLinks: false,
    }),
  };
}

// ============================================================================
// New Food Listing Notification
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
  const shortDesc = params.listingDescription
    ? params.listingDescription.length > 150
      ? params.listingDescription.substring(0, 150) + "..."
      : params.listingDescription
    : "";

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${params.recipientName}</strong>! 👋
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      Great news! A new ${params.listingType || "food"} listing is available near you:
    </p>

    <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
      <p style="font-size: 20px; font-weight: 700; margin: 0 0 12px; color: #363a57;">${emoji} ${params.listingTitle}</p>
      ${params.listingAddress ? `<p style="margin: 0 0 8px; color: #666; font-size: 14px;">📍 ${params.listingAddress}</p>` : ""}
      ${shortDesc ? `<p style="margin: 12px 0 0; font-size: 15px; line-height: 1.6; color: #555;">${shortDesc}</p>` : ""}
      <p style="margin: 12px 0 0; color: #999; font-size: 14px;">Posted by <strong style="color: #555;">${params.posterName}</strong></p>
    </div>

    <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">
      Don't miss out – items go fast! 🏃‍♂️
    </p>
  `;

  return {
    subject: `${emoji} New ${params.listingType || "food"} available: ${params.listingTitle}`,
    html: baseTemplate({
      title: "New Listing Near You! 📍",
      subtitle: `${params.listingTitle} is now available`,
      preheader: `${params.listingTitle} is now available near you`,
      content,
      ctaText: "View Listing",
      ctaUrl: params.listingUrl,
    }),
  };
}

// ============================================================================
// Chat Message Notification
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
  const preview =
    params.messagePreview.length > 100
      ? params.messagePreview.substring(0, 100) + "..."
      : params.messagePreview;

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${params.recipientName}</strong>! 👋
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      You have a new message from <strong style="color: #ff2d55;">${params.senderName}</strong>:
    </p>

    <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
      <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555; font-style: italic;">"${preview}"</p>
    </div>

    <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">
      Reply now to continue the conversation! 💬
    </p>
  `;

  return {
    subject: `💬 New message from ${params.senderName}`,
    html: baseTemplate({
      title: "You've Got a Message! 💬",
      subtitle: `${params.senderName} sent you a message`,
      preheader: `${params.senderName} sent you a message`,
      content,
      ctaText: "Reply Now",
      ctaUrl: params.chatUrl,
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
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${params.recipientName}</strong>! 👋
    </p>

    <div style="background: linear-gradient(135deg, #f8f8f8 0%, #f3f3f3 100%); border-radius: 12px; padding: 24px; margin: 0 0 24px; border-left: 4px solid #ff2d55;">
      <p style="margin: 0; font-size: 16px; line-height: 1.7; color: #555;">
        ${params.body.replace(/\n/g, "<br>")}
      </p>
    </div>

    <p style="margin: 20px 0 0; font-size: 13px; color: #999; text-align: center;">
      You received this email because you have ${categoryLabel} notifications enabled.
      <a href="${params.unsubscribeUrl}" style="color: #ff2d55; text-decoration: none;">Unsubscribe</a>
    </p>
  `;

  return {
    subject: params.title,
    html: baseTemplate({
      title: params.title,
      preheader: params.body.substring(0, 100),
      content,
      ctaText: params.actionText || "View Details",
      ctaUrl: params.actionUrl || "https://foodshare.club",
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
  const frequencyLabel = params.frequency === "hourly" ? "Hourly" : params.frequency === "daily" ? "Daily" : "Weekly";

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
          <h3 style="margin: 0; font-size: 16px; color: #ff2d55; font-weight: 600; border-bottom: 2px solid #ff2d55; padding-bottom: 8px; display: inline-block;">
            ${emoji} ${categoryName} (${categoryItems.length})
          </h3>
        </td>
      </tr>`;

    for (const item of categoryItems.slice(0, 5)) {
      const bodyPreview = item.body.length > 100 ? item.body.substring(0, 100) + "..." : item.body;
      itemsHtml += `
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0;">
          <p style="margin: 0 0 4px; font-size: 15px; font-weight: 600; color: #333333;">${item.title}</p>
          <p style="margin: 0; font-size: 14px; color: #666666; line-height: 1.4;">${bodyPreview}</p>
        </td>
      </tr>`;
    }

    if (categoryItems.length > 5) {
      itemsHtml += `
      <tr>
        <td style="padding: 8px 0;">
          <p style="margin: 0; font-size: 13px; color: #999999;">...and ${categoryItems.length - 5} more</p>
        </td>
      </tr>`;
    }
  }

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: #363a57;">
      Hey <strong>${params.recipientName}</strong>! 👋
    </p>

    <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.7; color: #555;">
      Here's your ${frequencyLabel.toLowerCase()} digest with <strong>${params.items.length}</strong> notification${params.items.length !== 1 ? "s" : ""}:
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 24px;">
      ${itemsHtml}
    </table>

    <p style="margin: 20px 0 0; font-size: 13px; color: #999; text-align: center;">
      <a href="${params.settingsUrl || "https://foodshare.club/settings/notifications"}" style="color: #ff2d55; text-decoration: none;">Manage Preferences</a>
      &nbsp;|&nbsp;
      <a href="${params.unsubscribeUrl}" style="color: #ff2d55; text-decoration: none;">Unsubscribe</a>
    </p>
  `;

  return {
    subject: `${frequencyLabel} Digest: ${params.items.length} new notification${params.items.length !== 1 ? "s" : ""}`,
    html: baseTemplate({
      title: `Your ${frequencyLabel} Digest`,
      subtitle: `${params.items.length} notification${params.items.length !== 1 ? "s" : ""} to catch up on`,
      preheader: `${params.items.length} notifications from FoodShare`,
      content,
      ctaText: "Open FoodShare",
      ctaUrl: "https://foodshare.club",
    }),
  };
}
