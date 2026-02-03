/**
 * Email Template Builder
 *
 * Generates all FoodShare email templates using the componentized system.
 * This is the SINGLE SOURCE OF TRUTH for all email templates.
 *
 * Usage:
 * - Edge Functions: Import and call template functions directly
 * - Database Seeding: Run `deno run template-builder.ts --generate-sql`
 * - Preview: Run `deno run template-builder.ts --preview welcome`
 */

import {
  BRAND,
  buildEmail,
  greeting,
  paragraph,
  bulletList,
  infoBox,
  highlightBox,
  disclaimerBox,
  statsBar,
  divider,
  growingCommunityBox,
  type BulletItem,
  type StatItem,
} from "./template-components.ts";

// ============================================================================
// Template: Welcome
// ============================================================================

export interface WelcomeParams {
  name: string;
  nearbyMembers?: number;
  mealsSharedMonthly?: number;
  totalMembers?: number;
}

// Thresholds for showing different content
const NEARBY_THRESHOLD = 10;  // Show "nearby" stats only if >= 10 members
const MEALS_THRESHOLD = 100;  // Show meals stat only if >= 100

export function welcomeTemplate(params: WelcomeParams): { subject: string; html: string } {
  const nearbyMembers = params.nearbyMembers ?? 0;
  const mealsShared = params.mealsSharedMonthly ?? 0;
  const totalMembers = params.totalMembers ?? 0;

  const features: BulletItem[] = [
    { emoji: "🍎", title: "Share Surplus Food", description: "Post your extra groceries for neighbors", color: BRAND.primaryColor },
    { emoji: "🗺️", title: "Discover Food Near You", description: "Browse the map to find available food", color: BRAND.accentTeal },
    { emoji: "💬", title: "Connect & Chat", description: "Message members to coordinate pickups", color: BRAND.accentOrange },
    { emoji: "🏆", title: "Join Challenges", description: "Participate in community challenges", color: BRAND.accentPurple },
  ];

  // Determine what to show based on actual numbers
  const hasNearbyMembers = nearbyMembers >= NEARBY_THRESHOLD;
  const hasMealsStats = mealsShared >= MEALS_THRESHOLD;
  const isEarlyStage = !hasNearbyMembers && !hasMealsStats;

  // Build stats section based on what we have
  let statsSection = "";

  if (isEarlyStage) {
    // Show encouraging "early member" message instead of stats
    statsSection = growingCommunityBox();
  } else {
    // Build stats array with only meaningful numbers
    const stats: StatItem[] = [];

    if (hasNearbyMembers) {
      stats.push({
        value: nearbyMembers,
        label: "Members near you",
        color: BRAND.primaryColor,
      });
    } else if (totalMembers >= 50) {
      // Show total community if no nearby members but community exists
      stats.push({
        value: totalMembers,
        label: "Community members",
        color: BRAND.primaryColor,
      });
    }

    if (hasMealsStats) {
      stats.push({
        value: mealsShared,
        label: "Meals shared",
        color: BRAND.accentTeal,
      });
    }

    if (stats.length > 0) {
      statsSection = statsBar(stats);
    }
  }

  // Adjust welcome message based on community size
  const welcomeMessage = isEarlyStage
    ? `Welcome to <strong style="color: ${BRAND.primaryColor};">FoodShare</strong>! You're joining a growing movement of neighbors who are reducing food waste and building community through sharing.`
    : `Welcome to the <strong style="color: ${BRAND.primaryColor};">FoodShare</strong> community! You're joining neighbors who are reducing food waste and sharing delicious food together.`;

  // Adjust CTA message
  const ctaMessage = isEarlyStage
    ? `Be one of the first to share in your area! Every journey starts with a single step – why not post something you're not using?`
    : `Why not have a look around and see what's available near you?`;

  const content = `
    ${greeting(params.name)}
    ${paragraph(welcomeMessage)}
    ${statsSection}
    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};"><strong>🌱 Here's what you can do:</strong></p>
    ${bulletList(features)}
    ${divider()}
    ${paragraph(ctaMessage, "0")}
  `;

  return {
    subject: "Welcome to FoodShare! 🎉",
    html: buildEmail({
      title: "Welcome to FoodShare! 🎉",
      subtitle: "Your journey to reducing food waste starts now",
      content,
      cta: {
        text: isEarlyStage ? "Share Something" : "Start Exploring",
        url: isEarlyStage ? "https://foodshare.club/share" : "https://foodshare.club/map",
        emoji: isEarlyStage ? "🍎" : "🗺️",
      },
      footer: { showAppBadges: true, signOffMessage: "Happy sharing!" },
    }),
  };
}

// ============================================================================
// Template: Email Verification
// ============================================================================

export interface EmailVerificationParams {
  verifyUrl: string;
}

export function emailVerificationTemplate(params: EmailVerificationParams): { subject: string; html: string } {
  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">Thanks for signing up for <strong style="color: ${BRAND.primaryColor};">FoodShare</strong>! 🥗</p>
    ${paragraph("We're excited to have you join our community dedicated to reducing food waste and sharing delicious meals. To complete your registration and start making a difference, please confirm your email address below:")}
    ${infoBox("What happens next?", "Once confirmed, your email will be uniquely associated with your account, and you'll gain full access to share and discover food in your community.", "✨")}
    ${disclaimerBox(`<strong style="color: ${BRAND.textMuted};">Didn't sign up?</strong><br>If you didn't register with FoodShare, you can safely ignore this email.`)}
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
// Template: Password Reset
// ============================================================================

export interface PasswordResetParams {
  name: string;
  resetUrl: string;
  expiresIn?: string;
}

export function passwordResetTemplate(params: PasswordResetParams): { subject: string; html: string } {
  const expiresIn = params.expiresIn || "1 hour";

  const content = `
    ${greeting(params.name, "")}
    ${paragraph("We received a request to reset your password. Click the button below to create a new password:")}
    ${infoBox("Time Sensitive", `This link will expire in <strong>${expiresIn}</strong>. If you didn't request this, you can safely ignore this email.`, "⏰")}
    ${disclaimerBox(`<strong style="color: ${BRAND.textMuted};">Didn't request this?</strong><br>If you didn't request a password reset, your account is still secure. No action is needed.`)}
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
// Template: Chat Notification
// ============================================================================

export interface ChatNotificationParams {
  recipientName: string;
  senderName: string;
  messagePreview: string;
  chatUrl: string;
}

export function chatNotificationTemplate(params: ChatNotificationParams): { subject: string; html: string } {
  const preview = params.messagePreview.length > 100
    ? params.messagePreview.substring(0, 100) + "..."
    : params.messagePreview;

  const content = `
    ${greeting(params.recipientName)}
    ${paragraph(`You have a new message from <strong style="color: ${BRAND.primaryColor};">${params.senderName}</strong>:`)}
    ${highlightBox(`<p style="margin: 0; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary}; font-style: italic;">"${preview}"</p>`)}
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
// Template: New Listing Nearby
// ============================================================================

export interface NewListingParams {
  recipientName: string;
  listingTitle: string;
  listingDescription?: string;
  listingAddress?: string;
  posterName: string;
  listingUrl: string;
  listingType?: string;
  listingEmoji?: string;
}

export function newListingTemplate(params: NewListingParams): { subject: string; html: string } {
  const emoji = params.listingEmoji || "🍎";
  const listingType = params.listingType || "food";
  const shortDesc = params.listingDescription
    ? params.listingDescription.length > 150
      ? params.listingDescription.substring(0, 150) + "..."
      : params.listingDescription
    : "";

  const listingBox = `
    <p style="font-size: 20px; font-weight: 700; margin: 0 0 12px; color: ${BRAND.textPrimary};">${emoji} ${params.listingTitle}</p>
    ${params.listingAddress ? `<p style="margin: 0 0 8px; color: ${BRAND.textMuted}; font-size: 14px;">📍 ${params.listingAddress}</p>` : ""}
    ${shortDesc ? `<p style="margin: 12px 0 0; font-size: 15px; line-height: 1.6; color: ${BRAND.textSecondary};">${shortDesc}</p>` : ""}
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
// Template: Volunteer Welcome
// ============================================================================

export interface VolunteerWelcomeParams {
  name: string;
}

export function volunteerWelcomeTemplate(params: VolunteerWelcomeParams): { subject: string; html: string } {
  const features: BulletItem[] = [
    { emoji: "📦", title: "Coordinate Pickups", description: "Help connect donors with recipients", color: BRAND.primaryColor },
    { emoji: "🏪", title: "Manage Community Fridges", description: "Keep local fridges stocked and clean", color: BRAND.accentTeal },
    { emoji: "📣", title: "Spread the Word", description: "Help grow our community", color: BRAND.accentOrange },
    { emoji: "📊", title: "Track Impact", description: "See your contributions in real-time", color: BRAND.accentPurple },
  ];

  const content = `
    ${greeting(params.name)}
    ${paragraph(`Thank you for joining the <strong style="color: ${BRAND.primaryColor};">FoodShare Volunteer Program</strong>! Your dedication helps make our community stronger.`)}
    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};"><strong>🌟 As a volunteer, you can:</strong></p>
    ${bulletList(features)}
    ${infoBox("Your Impact Starts Now", "Every volunteer hour helps reduce food waste and feeds families in need. Thank you for being part of the solution!", "💪")}
  `;

  return {
    subject: "Welcome to the FoodShare Volunteer Team! 🌟",
    html: buildEmail({
      title: "Welcome, Volunteer! 🙌",
      subtitle: "You're joining an amazing team",
      content,
      cta: { text: "Start Volunteering", url: "https://foodshare.club/volunteer/dashboard", emoji: "🚀" },
    }),
  };
}

// ============================================================================
// Template: Complete Profile
// ============================================================================

export interface CompleteProfileParams {
  name: string;
  completionPercent?: number;
}

export function completeProfileTemplate(params: CompleteProfileParams): { subject: string; html: string } {
  const percent = params.completionPercent || 50;

  const benefits: BulletItem[] = [
    { emoji: "🔍", title: "Get Found", description: "Neighbors can discover you more easily", color: BRAND.primaryColor },
    { emoji: "🤝", title: "Build Trust", description: "People are more likely to connect with complete profiles", color: BRAND.accentTeal },
    { emoji: "📍", title: "Get Matched", description: "Find food shares near your location", color: BRAND.accentOrange },
  ];

  const content = `
    ${greeting(params.name)}
    ${paragraph(`Your FoodShare profile is <strong>${percent}%</strong> complete. Add a few more details to get the full experience!`)}
    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};"><strong>✅ A complete profile helps you:</strong></p>
    ${bulletList(benefits)}
    ${infoBox("Quick Tip", "Adding a profile photo increases your chances of successful connections by 3x!", "💡")}
  `;

  return {
    subject: "Complete your FoodShare profile 📝",
    html: buildEmail({
      title: "Almost There! 📝",
      subtitle: "Complete your profile to unlock all features",
      content,
      cta: { text: "Complete Profile", url: "https://foodshare.club/settings/profile", emoji: "📝" },
    }),
  };
}

// ============================================================================
// Template: First Share Tips
// ============================================================================

export interface FirstShareTipsParams {
  name: string;
}

export function firstShareTipsTemplate(params: FirstShareTipsParams): { subject: string; html: string } {
  const tips: BulletItem[] = [
    { emoji: "📷", title: "Add Clear Photos", description: "Good photos get 5x more interest", color: BRAND.primaryColor },
    { emoji: "📝", title: "Be Descriptive", description: "Include quantity, expiry dates, and dietary info", color: BRAND.accentTeal },
    { emoji: "📍", title: "Set Pickup Details", description: "Clear time and location help coordination", color: BRAND.accentOrange },
    { emoji: "⚡", title: "Respond Quickly", description: "Fast responses lead to successful pickups", color: BRAND.accentPurple },
  ];

  const content = `
    ${greeting(params.name)}
    ${paragraph("Ready to make your first food share? Here are some tips to make it a great experience:")}
    <p style="margin: 0 0 16px; font-size: 16px; line-height: 1.7; color: ${BRAND.textSecondary};"><strong>📸 Creating a Great Listing:</strong></p>
    ${bulletList(tips)}
    ${infoBox("Pro Tip", "Start with items that are still fresh but you can't use in time. Produce, bread, and leftovers are popular first shares!", "🌟")}
  `;

  return {
    subject: "Tips for your first FoodShare 🍎",
    html: buildEmail({
      title: "Ready to Share? 🍎",
      subtitle: "Tips for a successful first share",
      content,
      cta: { text: "Create Your First Share", url: "https://foodshare.club/share", emoji: "🍎" },
    }),
  };
}

// ============================================================================
// Template: Milestone Celebration
// ============================================================================

export interface MilestoneParams {
  name: string;
  milestoneName: string;
  milestoneDescription: string;
  milestoneEmoji?: string;
  percentile?: number;
  nextMilestone?: string;
}

export function milestoneTemplate(params: MilestoneParams): { subject: string; html: string } {
  const emoji = params.milestoneEmoji || "🏆";
  const percentile = params.percentile || 10;
  const nextMilestone = params.nextMilestone || "Keep sharing to unlock your next achievement!";

  const milestoneBox = `
    <div style="margin: 24px 0; padding: 32px; background: linear-gradient(135deg, ${BRAND.accentPurple} 0%, #A78BFA 100%); border-radius: 16px; text-align: center;">
      <p style="margin: 0; font-size: 64px;">${emoji}</p>
      <p style="margin: 16px 0 0; font-size: 24px; font-weight: 800; color: #ffffff;">${params.milestoneName}</p>
      <p style="margin: 8px 0 0; font-size: 16px; color: rgba(255,255,255,0.9);">${params.milestoneDescription}</p>
    </div>
  `;

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">Congratulations <strong>${params.name}</strong>! 🎊</p>
    ${milestoneBox}
    ${paragraph(`This achievement puts you in the top <strong style="color: ${BRAND.primaryColor};">${percentile}%</strong> of FoodShare members. Keep up the amazing work!`)}
    ${infoBox("Next Goal", nextMilestone, "🎯")}
  `;

  return {
    subject: `🎉 Achievement Unlocked: ${params.milestoneName}!`,
    html: buildEmail({
      title: "🎉 Achievement Unlocked!",
      subtitle: "You've reached an amazing milestone",
      content,
      cta: { text: "View All Achievements", url: "https://foodshare.club/achievements", emoji: "🏆" },
    }),
  };
}

// ============================================================================
// Template: Reengagement
// ============================================================================

export interface ReengagementParams {
  name: string;
  daysSinceLastVisit: number;
  newListingsNearby?: number;
  mealsSavedCommunity?: number;
  newMembersNearby?: number;
  totalMembers?: number;
  unsubscribeUrl: string;
}

export function reengagementTemplate(params: ReengagementParams): { subject: string; html: string } {
  const newListings = params.newListingsNearby ?? 0;
  const mealsSaved = params.mealsSavedCommunity ?? 0;
  const newMembers = params.newMembersNearby ?? 0;

  // Only show stats that are meaningful (> 0)
  const stats: StatItem[] = [];

  if (newListings > 0) {
    stats.push({
      value: newListings,
      label: newListings === 1 ? "New listing near you" : "New listings near you",
      color: BRAND.primaryColor,
      hideIfZero: true,
    });
  }

  if (mealsSaved > 0) {
    stats.push({
      value: mealsSaved,
      label: "Meals saved locally",
      color: BRAND.accentTeal,
      hideIfZero: true,
    });
  }

  if (newMembers > 0) {
    stats.push({
      value: newMembers,
      label: newMembers === 1 ? "New neighbor joined" : "New neighbors joined",
      color: BRAND.accentPurple,
      hideIfZero: true,
    });
  }

  const hasActivity = stats.length > 0;

  // Different messaging based on whether there's local activity
  let mainMessage = "";
  let statsSection = "";
  let closingMessage = "";

  if (hasActivity) {
    mainMessage = `It's been <strong>${params.daysSinceLastVisit} days</strong> since we've seen you, and your community has been busy!`;
    statsSection = statsBar(stats);
    closingMessage = `Maybe you've finished a good book recently, or have some extra groceries you won't use in time? Why not pop back and see what's happening?`;
  } else {
    // No local activity - focus on encouraging them to be a pioneer
    mainMessage = `It's been <strong>${params.daysSinceLastVisit} days</strong> since we've seen you. We've missed you!`;
    statsSection = `<div style="margin: 24px 0; padding: 20px; background: linear-gradient(135deg, ${BRAND.bgSecondary} 0%, #fff5f7 100%); border-radius: ${BRAND.cardRadius}; text-align: center;">
  <p style="margin: 0 0 8px; font-size: 24px;">💚</p>
  <p style="margin: 0 0 4px; font-size: 16px; font-weight: 700; color: ${BRAND.textPrimary};">Your neighborhood needs you!</p>
  <p style="margin: 0; font-size: 14px; color: ${BRAND.textSecondary}; line-height: 1.5;">Be the one to kickstart food sharing in your area. One listing could inspire your whole community.</p>
</div>`;
    closingMessage = `Got something you're not using? A book you've finished, some extra groceries, or that thing in the cupboard you keep meaning to sort out? Someone nearby might love it!`;
  }

  const content = `
    ${greeting(params.name)}
    ${paragraph(mainMessage)}
    ${statsSection}
    ${paragraph(closingMessage)}
    ${divider()}
    ${paragraph(`One person's spare is another person's treasure. Why not make someone's day? 💚`, "0")}
  `;

  return {
    subject: `Wanna make someone's day? 💚`,
    html: buildEmail({
      title: "We've Missed You! 💚",
      subtitle: hasActivity ? "Your neighbors have been busy" : "Come back and share something",
      content,
      cta: {
        text: hasActivity ? "See What's New" : "Share Something",
        url: hasActivity ? "https://foodshare.club/map" : "https://foodshare.club/share",
        emoji: hasActivity ? "🗺️" : "🍎",
      },
      footer: { showUnsubscribe: true, unsubscribeUrl: params.unsubscribeUrl, showAppBadges: true, signOffMessage: "Happy sharing!" },
    }),
  };
}

// ============================================================================
// Template: Feedback Alert (Admin)
// ============================================================================

export interface FeedbackAlertParams {
  feedbackId: string;
  feedbackType: string;
  feedbackEmoji?: string;
  subject: string;
  submitterName: string;
  submitterEmail: string;
  message: string;
  timestamp?: string;
}

export function feedbackAlertTemplate(params: FeedbackAlertParams): { subject: string; html: string } {
  const emoji = params.feedbackEmoji || "📩";
  const timestamp = params.timestamp || new Date().toISOString();

  const feedbackBox = `
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Type:</strong> ${emoji} ${params.feedbackType}</p>
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Subject:</strong> ${params.subject}</p>
    <p style="margin: 0 0 12px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">From:</strong> ${params.submitterName} (<a href="mailto:${params.submitterEmail}" style="color: ${BRAND.primaryColor};">${params.submitterEmail}</a>)</p>
    <p style="margin: 0 0 16px; font-size: 15px; color: ${BRAND.textSecondary};"><strong style="color: ${BRAND.textPrimary};">Submitted:</strong> ${timestamp}</p>
    <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;">
    <p style="margin: 0; font-size: 15px; line-height: 1.7; color: ${BRAND.textSecondary}; white-space: pre-wrap;">${params.message}</p>
  `;

  const content = `
    <p style="margin: 0 0 20px; font-size: 17px; line-height: 1.7; color: ${BRAND.textPrimary};">New feedback has been submitted:</p>
    ${highlightBox(feedbackBox)}
    <p style="margin: 0; font-size: 13px; color: ${BRAND.textLight};">Feedback ID: ${params.feedbackId}</p>
  `;

  return {
    subject: `${emoji} New Feedback: ${params.subject}`,
    html: buildEmail({
      title: "New Feedback Received",
      subtitle: `${params.feedbackType} feedback from ${params.submitterName}`,
      content,
      cta: { text: "View in Dashboard", url: "https://foodshare.club/admin/feedback", emoji: "📋" },
      footer: { minimal: true, showSocialLinks: false },
    }),
  };
}

// ============================================================================
// Export All Templates
// ============================================================================

export const templates = {
  welcome: welcomeTemplate,
  "email-verification": emailVerificationTemplate,
  "password-reset": passwordResetTemplate,
  "chat-notification": chatNotificationTemplate,
  "new-listing-nearby": newListingTemplate,
  "volunteer-welcome": volunteerWelcomeTemplate,
  "complete-profile": completeProfileTemplate,
  "first-share-tips": firstShareTipsTemplate,
  "milestone-celebration": milestoneTemplate,
  reengagement: reengagementTemplate,
  "feedback-alert": feedbackAlertTemplate,
};

export type TemplateSlug = keyof typeof templates;

// ============================================================================
// Render Template by Slug
// ============================================================================

export function renderTemplate(
  slug: string,
  variables: Record<string, unknown>
): { subject: string; html: string } | null {
  const templateFn = templates[slug as TemplateSlug];

  if (!templateFn) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return templateFn(variables as any);
}
