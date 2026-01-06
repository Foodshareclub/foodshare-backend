/**
 * Notification Priority Calculator
 *
 * Calculates notification priority based on type, user preferences,
 * context, and historical engagement patterns.
 */

import { NotificationPayload, PriorityLevel, NotificationType } from "./index.ts";

// Priority configuration per notification type
interface PriorityConfig {
  basePriority: PriorityLevel;
  canEscalate: boolean;
  canDeescalate: boolean;
  urgencyDecayHours?: number;
}

const PRIORITY_CONFIG: Record<NotificationType, PriorityConfig> = {
  // Critical - always high priority
  account_security: {
    basePriority: "critical",
    canEscalate: false,
    canDeescalate: false,
  },
  moderation_warning: {
    basePriority: "high",
    canEscalate: false,
    canDeescalate: false,
  },

  // High priority by default
  new_message: {
    basePriority: "high",
    canEscalate: false,
    canDeescalate: true,
    urgencyDecayHours: 24,
  },
  arrangement_confirmed: {
    basePriority: "high",
    canEscalate: true,
    canDeescalate: false,
    urgencyDecayHours: 48,
  },
  arrangement_cancelled: {
    basePriority: "high",
    canEscalate: false,
    canDeescalate: false,
  },

  // Normal priority by default
  listing_favorited: {
    basePriority: "normal",
    canEscalate: true,
    canDeescalate: true,
  },
  listing_expired: {
    basePriority: "normal",
    canEscalate: true,
    canDeescalate: true,
    urgencyDecayHours: 6,
  },
  arrangement_completed: {
    basePriority: "normal",
    canEscalate: false,
    canDeescalate: true,
  },
  challenge_complete: {
    basePriority: "normal",
    canEscalate: true,
    canDeescalate: false,
  },
  review_received: {
    basePriority: "normal",
    canEscalate: true,
    canDeescalate: true,
  },

  // Low priority by default
  challenge_reminder: {
    basePriority: "low",
    canEscalate: true,
    canDeescalate: true,
  },
  review_reminder: {
    basePriority: "low",
    canEscalate: false,
    canDeescalate: true,
  },
  system_announcement: {
    basePriority: "low",
    canEscalate: true,
    canDeescalate: false,
  },
};

// Priority scores for calculation
const PRIORITY_SCORES: Record<PriorityLevel, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
};

// Factors that affect priority
interface PriorityFactors {
  isFirstInteraction: boolean;
  hasUnreadMessages: boolean;
  hasUpcomingArrangement: boolean;
  challengeEndsSoon: boolean;
  listingExpiresSoon: boolean;
  userActiveRecently: boolean;
  timeOfDay: "active" | "quiet" | "off";
  notificationFrequency: "low" | "moderate" | "high";
  userEngagement: "low" | "moderate" | "high";
}

/**
 * Calculate priority for a notification based on multiple factors.
 */
export function calculatePriority(
  payload: NotificationPayload,
  preferences: any,
  factors?: Partial<PriorityFactors>
): PriorityLevel {
  const config = PRIORITY_CONFIG[payload.type];
  let score = PRIORITY_SCORES[config.basePriority];

  // Apply escalation factors
  if (config.canEscalate) {
    score += calculateEscalationBonus(payload, factors);
  }

  // Apply de-escalation factors
  if (config.canDeescalate) {
    score -= calculateDeescalationPenalty(payload, preferences, factors);
  }

  // Apply urgency decay
  if (config.urgencyDecayHours && payload.data?.createdAt) {
    score = applyUrgencyDecay(score, payload.data.createdAt, config.urgencyDecayHours);
  }

  // Apply user preference modifiers
  score = applyUserPreferenceModifiers(score, payload.type, preferences);

  // Convert score back to priority level
  return scoreToPriority(score);
}

function calculateEscalationBonus(
  payload: NotificationPayload,
  factors?: Partial<PriorityFactors>
): number {
  let bonus = 0;

  // First interaction from a new user
  if (factors?.isFirstInteraction) {
    bonus += 15;
  }

  // Upcoming arrangement (time-sensitive)
  if (factors?.hasUpcomingArrangement) {
    bonus += 20;
  }

  // Challenge ending soon
  if (factors?.challengeEndsSoon) {
    bonus += 10;
  }

  // Listing expiring soon
  if (factors?.listingExpiresSoon) {
    bonus += 15;
  }

  // Type-specific bonuses
  if (payload.type === "listing_favorited" && payload.data?.favoriteCount) {
    const count = parseInt(payload.data.favoriteCount);
    if (count >= 10) bonus += 15;
    else if (count >= 5) bonus += 10;
  }

  if (payload.type === "challenge_complete") {
    bonus += 10; // Celebrations should feel immediate
  }

  return Math.min(bonus, 30); // Cap escalation
}

function calculateDeescalationPenalty(
  payload: NotificationPayload,
  preferences: any,
  factors?: Partial<PriorityFactors>
): number {
  let penalty = 0;

  // User hasn't been active recently
  if (!factors?.userActiveRecently) {
    penalty += 10;
  }

  // High notification frequency (avoid spam feel)
  if (factors?.notificationFrequency === "high") {
    penalty += 15;
  }

  // Low user engagement
  if (factors?.userEngagement === "low") {
    penalty += 10;
  }

  // Quiet time of day
  if (factors?.timeOfDay === "quiet") {
    penalty += 10;
  }

  // Off hours
  if (factors?.timeOfDay === "off") {
    penalty += 20;
  }

  // Already has unread notifications of same type
  if (preferences.hasUnreadOfType?.[payload.type]) {
    penalty += 15;
  }

  return Math.min(penalty, 40); // Cap de-escalation
}

function applyUrgencyDecay(
  score: number,
  createdAt: string,
  decayHours: number
): number {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const hoursElapsed = (now - created) / (1000 * 60 * 60);

  if (hoursElapsed <= 0) return score;

  // Exponential decay
  const decayFactor = Math.exp(-hoursElapsed / decayHours);
  const decayAmount = 25 * (1 - decayFactor);

  return Math.max(score - decayAmount, PRIORITY_SCORES.low);
}

function applyUserPreferenceModifiers(
  score: number,
  type: NotificationType,
  preferences: any
): number {
  // Check if user has specific priority preference for this type
  const typePref = preferences.type_priorities?.[type];

  if (typePref === "high") {
    score += 15;
  } else if (typePref === "low") {
    score -= 15;
  } else if (typePref === "muted") {
    score = PRIORITY_SCORES.low - 10;
  }

  // Check if user prefers consolidated notifications
  if (preferences.prefer_consolidated) {
    score -= 10;
  }

  // Check if user prefers immediate notifications
  if (preferences.prefer_immediate) {
    score += 10;
  }

  return Math.max(PRIORITY_SCORES.low - 10, Math.min(score, PRIORITY_SCORES.critical));
}

function scoreToPriority(score: number): PriorityLevel {
  if (score >= 90) return "critical";
  if (score >= 65) return "high";
  if (score >= 40) return "normal";
  return "low";
}

/**
 * Calculate optimal send time based on user patterns.
 */
export function calculateOptimalSendTime(
  preferences: any,
  activityPatterns?: any
): { shouldSendNow: boolean; optimalTime?: string; reason: string } {
  const now = new Date();
  const currentHour = now.getHours();

  // Check quiet hours
  if (preferences.quiet_hours_enabled) {
    const [startHour] = (preferences.quiet_hours_start ?? "22:00").split(":").map(Number);
    const [endHour] = (preferences.quiet_hours_end ?? "08:00").split(":").map(Number);

    let inQuietHours: boolean;
    if (startHour > endHour) {
      inQuietHours = currentHour >= startHour || currentHour < endHour;
    } else {
      inQuietHours = currentHour >= startHour && currentHour < endHour;
    }

    if (inQuietHours) {
      const optimalTime = new Date();
      optimalTime.setHours(endHour, 0, 0, 0);
      if (optimalTime <= now) {
        optimalTime.setDate(optimalTime.getDate() + 1);
      }

      return {
        shouldSendNow: false,
        optimalTime: optimalTime.toISOString(),
        reason: "quiet_hours",
      };
    }
  }

  // Check activity patterns if available
  if (activityPatterns?.preferredHours) {
    const preferredHours = activityPatterns.preferredHours as number[];
    const isPreferredHour = preferredHours.includes(currentHour);

    if (!isPreferredHour && preferredHours.length > 0) {
      // Find next preferred hour
      const nextPreferred = preferredHours.find((h) => h > currentHour) ?? preferredHours[0];
      const optimalTime = new Date();
      optimalTime.setHours(nextPreferred, 0, 0, 0);
      if (nextPreferred <= currentHour) {
        optimalTime.setDate(optimalTime.getDate() + 1);
      }

      // Only delay if it's within reasonable time
      const delayHours = (optimalTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (delayHours <= 4) {
        return {
          shouldSendNow: false,
          optimalTime: optimalTime.toISOString(),
          reason: "optimal_engagement_time",
        };
      }
    }
  }

  return {
    shouldSendNow: true,
    reason: "current_time_acceptable",
  };
}

/**
 * Determine if notifications should be consolidated.
 */
export function shouldConsolidate(
  pendingNotifications: NotificationPayload[],
  newNotification: NotificationPayload,
  preferences: any
): { shouldConsolidate: boolean; groupKey?: string; reason: string } {
  // Don't consolidate critical or security notifications
  if (
    newNotification.type === "account_security" ||
    newNotification.type === "moderation_warning"
  ) {
    return { shouldConsolidate: false, reason: "critical_notification" };
  }

  // Check user preference
  if (!preferences.prefer_consolidated) {
    return { shouldConsolidate: false, reason: "user_prefers_individual" };
  }

  // Find similar pending notifications
  const similarNotifications = pendingNotifications.filter(
    (n) => n.type === newNotification.type && n.userId === newNotification.userId
  );

  if (similarNotifications.length >= 2) {
    // Generate group key for consolidation
    const groupKey = `${newNotification.userId}:${newNotification.type}:${Date.now()}`;

    return {
      shouldConsolidate: true,
      groupKey,
      reason: `consolidating_${similarNotifications.length + 1}_notifications`,
    };
  }

  return { shouldConsolidate: false, reason: "not_enough_similar" };
}

/**
 * Generate consolidated notification from multiple notifications.
 */
export function generateConsolidatedNotification(
  notifications: NotificationPayload[],
  type: NotificationType
): NotificationPayload {
  const count = notifications.length;
  const userId = notifications[0].userId;

  // Generate appropriate title and body based on type
  const consolidated = getConsolidatedContent(type, count, notifications);

  return {
    id: crypto.randomUUID(),
    type,
    userId,
    title: consolidated.title,
    body: consolidated.body,
    data: {
      isConsolidated: "true",
      count: String(count),
      notificationIds: notifications.map((n) => n.id).filter(Boolean).join(","),
    },
  };
}

function getConsolidatedContent(
  type: NotificationType,
  count: number,
  notifications: NotificationPayload[]
): { title: string; body: string } {
  switch (type) {
    case "new_message":
      return {
        title: `${count} new messages`,
        body: `You have ${count} unread messages from multiple conversations`,
      };

    case "listing_favorited":
      return {
        title: `${count} new favorites`,
        body: `Your listings were saved ${count} times`,
      };

    case "challenge_reminder":
      return {
        title: `${count} challenge updates`,
        body: `You have ${count} challenges waiting for your attention`,
      };

    case "review_received":
      return {
        title: `${count} new reviews`,
        body: `You received ${count} new reviews`,
      };

    default:
      return {
        title: `${count} notifications`,
        body: `You have ${count} new ${type.replace(/_/g, " ")} notifications`,
      };
  }
}

export {
  PriorityConfig,
  PriorityFactors,
  PRIORITY_CONFIG,
  PRIORITY_SCORES,
};
