/**
 * Email Templates
 *
 * Reusable HTML email templates for FoodShare
 */

// ============================================================================
// Base Template
// ============================================================================

interface BaseTemplateParams {
  title: string;
  preheader?: string;
  content: string;
  ctaText?: string;
  ctaUrl?: string;
  footerText?: string;
}

export function baseTemplate(params: BaseTemplateParams): string {
  const year = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${params.title}</title>
  ${params.preheader ? `<meta name="description" content="${params.preheader}">` : ""}
  <style>
    /* Reset */
    body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }

    /* Base */
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #363a57;
      margin: 0;
      padding: 0;
      background-color: #f5f5f7;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }

    .card {
      background: linear-gradient(135deg, #ffffff 0%, #fafafa 100%);
      border-radius: 16px;
      padding: 32px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }

    .logo {
      text-align: center;
      margin-bottom: 24px;
    }

    .logo img {
      max-width: 100%;
      height: auto;
      border-radius: 12px;
    }

    h1 {
      color: #363a57;
      text-align: center;
      font-size: 24px;
      font-weight: 600;
      margin: 0 0 24px 0;
    }

    p {
      margin: 0 0 16px 0;
      color: #4a4a4a;
    }

    .cta-container {
      text-align: center;
      margin: 24px 0;
    }

    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #ff2d55 0%, #ff385c 100%);
      color: #ffffff !important;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 600;
      font-size: 16px;
      box-shadow: 0 4px 12px rgba(255,45,85,0.3);
    }

    .footer {
      background: linear-gradient(135deg, #ff2d55 0%, #ff385c 100%);
      color: #ffffff;
      text-align: center;
      padding: 24px;
      border-radius: 12px;
      margin-top: 24px;
      font-size: 14px;
    }

    .footer a {
      color: #ffffff;
      text-decoration: underline;
    }

    .footer p {
      color: #ffffff;
      margin: 8px 0;
    }

    ul {
      padding-left: 20px;
      margin: 16px 0;
    }

    li {
      margin: 8px 0;
      color: #4a4a4a;
    }

    @media only screen and (max-width: 600px) {
      .container { padding: 12px; }
      .card { padding: 20px; }
      h1 { font-size: 20px; }
      .cta-button { padding: 12px 24px; font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">
        <img src="https://i.ibb.co/d6sMFKD/Cover.png" alt="FoodShare" width="504">
      </div>
      <h1>${params.title}</h1>
      ${params.content}
      ${
        params.ctaText && params.ctaUrl
          ? `
      <div class="cta-container">
        <a href="${params.ctaUrl}" class="cta-button">${params.ctaText}</a>
      </div>
      `
          : ""
      }
    </div>
    <div class="footer">
      <p><strong>FoodShare LLC © ${year}</strong> | USA 20231394981</p>
      <p>4632 Winding Way, Sacramento CA 95841</p>
      <p>Questions? <a href="mailto:contact@foodshare.club">contact@foodshare.club</a></p>
      <p>
        <a href="https://foodshare.club/">Visit Us</a> |
        <a href="https://app.gitbook.com/o/S1q71czYZ02oMxTaZgTT/s/XbVLvP6lx1ACYUl8wUUI/">Privacy</a> |
        <a href="https://app.gitbook.com/o/S1q71czYZ02oMxTaZgTT/s/XbVLvP6lx1ACYUl8wUUI/terms-of-use">Terms</a>
      </p>
      ${params.footerText ? `<p style="margin-top: 16px; font-size: 12px; opacity: 0.8;">${params.footerText}</p>` : ""}
    </div>
  </div>
</body>
</html>
`;
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
    <p>Hey ${displayName},</p>
    <p>We're thrilled to have you join the FoodShare community! Get ready to embark on a journey of delicious discoveries and meaningful connections.</p>
    <p>Here's what you can do:</p>
    <ul>
      <li>🍎 Share surplus food with your community</li>
      <li>🗺️ Discover food near you on our interactive map</li>
      <li>💬 Connect with other food enthusiasts</li>
      <li>🌍 Help reduce food waste together</li>
    </ul>
    <p>Best regards,<br><strong>The FoodShare Team</strong></p>
  `;

  return {
    subject: "Welcome to FoodShare! 🎉",
    html: baseTemplate({
      title: "Welcome to FoodShare! 🎉",
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
    <p>Hey ${displayName},</p>
    <p>We're very sad to see you go. Your presence in our community will be missed.</p>
    <p>If there's anything we could have done better, please don't hesitate to let us know.</p>
    <p>Remember, you're always welcome back if you change your mind!</p>
    <p>Best regards,<br><strong>The FoodShare Team</strong></p>
  `;

  return {
    subject: "Sorry to see you go 😢",
    html: baseTemplate({
      title: "We're Sad to See You Go 😢",
      preheader: "We hope to see you again soon",
      content,
      ctaText: "📝 Give Feedback",
      ctaUrl: "https://eu-submit.jotform.com/231016600816041",
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
    <p>Hey ${params.recipientName},</p>
    <p>Great news! A new ${params.listingType || "food"} listing is available near you:</p>
    <div style="background: #f8f8f8; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <p style="font-size: 18px; font-weight: 600; margin: 0 0 8px 0;">${emoji} ${params.listingTitle}</p>
      ${params.listingAddress ? `<p style="margin: 4px 0; color: #666;">📍 ${params.listingAddress}</p>` : ""}
      ${shortDesc ? `<p style="margin: 8px 0;">${shortDesc}</p>` : ""}
      <p style="margin: 8px 0 0 0; color: #666;">Posted by ${params.posterName}</p>
    </div>
    <p>Don't miss out - items go fast!</p>
  `;

  return {
    subject: `${emoji} New ${params.listingType || "food"} available: ${params.listingTitle}`,
    html: baseTemplate({
      title: "New Listing Near You!",
      preheader: `${params.listingTitle} is now available`,
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
    <p>Hey ${params.recipientName},</p>
    <p>You have a new message from <strong>${params.senderName}</strong>:</p>
    <div style="background: #f8f8f8; border-radius: 12px; padding: 16px; margin: 16px 0; border-left: 4px solid #ff2d55;">
      <p style="margin: 0; font-style: italic;">"${preview}"</p>
    </div>
    <p>Reply now to continue the conversation!</p>
  `;

  return {
    subject: `💬 New message from ${params.senderName}`,
    html: baseTemplate({
      title: "You've Got a Message! 💬",
      preheader: `${params.senderName} sent you a message`,
      content,
      ctaText: "Reply Now",
      ctaUrl: params.chatUrl,
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
    <p>Hey ${params.name},</p>
    <p>We received a request to reset your password. Click the button below to create a new password:</p>
    <p style="color: #666; font-size: 14px;">This link will expire in ${params.expiresIn || "1 hour"}.</p>
    <p>If you didn't request this, you can safely ignore this email.</p>
    <p>Best regards,<br><strong>The FoodShare Team</strong></p>
  `;

  return {
    subject: "Reset your FoodShare password 🔐",
    html: baseTemplate({
      title: "Reset Your Password",
      preheader: "Click to reset your FoodShare password",
      content,
      ctaText: "Reset Password",
      ctaUrl: params.resetUrl,
      footerText: "If you didn't request a password reset, please ignore this email.",
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
    <p>Hey ${displayName},</p>
    <p>Thanks for signing up! You're just one click away from joining our community dedicated to <strong>reducing food waste</strong> and <strong>sharing delicious meals</strong> with neighbors.</p>
    <p>Please confirm your email address to complete your registration:</p>
    
    <div style="background: #f8f8f8; border-radius: 8px; padding: 16px; margin: 20px 0; border-left: 4px solid #ff2d55;">
      <p style="margin: 0; font-size: 14px; color: #666;">
        <strong style="color: #ff2d55;">✨ What happens next?</strong><br>
        Once confirmed, you'll have full access to share surplus food, discover items near you, and connect with your local community.
      </p>
    </div>
    
    <p><strong>🌱 What You Can Do on FoodShare:</strong></p>
    <ul>
      <li><strong style="color: #ff2d55;">🍎 Share Surplus Food</strong> - Post your extra groceries for neighbors to pick up for free.</li>
      <li><strong style="color: #00A699;">🗺️ Discover Food Near You</strong> - Browse the map to find available food and community fridges.</li>
      <li><strong style="color: #FC642D;">💬 Connect & Chat</strong> - Message members to coordinate pickups.</li>
      <li><strong style="color: #8B5CF6;">🏆 Join Challenges</strong> - Participate in community challenges to reduce waste.</li>
    </ul>
    
    <p style="margin-top: 20px; font-size: 13px; color: #999;">
      <em>Didn't sign up? You can safely ignore this email.</em>
    </p>
  `;

  return {
    subject: "Confirm your email to join FoodShare! ✉️",
    html: baseTemplate({
      title: "Welcome to FoodShare! 🎉",
      preheader: "One click to confirm your FoodShare account",
      content,
      ctaText: "✓ Confirm Your Email",
      ctaUrl: params.verifyUrl,
    }),
  };
}
