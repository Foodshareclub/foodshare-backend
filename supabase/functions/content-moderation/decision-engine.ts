/**
 * Content Moderation Decision Engine
 *
 * Makes final moderation decisions based on text and image analysis,
 * applies policies, and determines appropriate actions.
 */

import { TextAnalysisResult, TextCategory, Severity } from "./text-analyzer.ts";
import { ImageAnalysisResult, ImageCategory, ImageFlag } from "./image-analyzer.ts";

// Moderation decision
export type ModerationDecision =
  | "approve"
  | "approve_with_warning"
  | "require_review"
  | "auto_reject"
  | "shadowban";

// Moderation action
export type ModerationAction =
  | "none"
  | "sanitize"
  | "blur_image"
  | "remove_pii"
  | "flag_for_review"
  | "reject"
  | "suspend_user"
  | "notify_admins";

// Content type being moderated
export type ContentType =
  | "listing"
  | "message"
  | "review"
  | "forum_post"
  | "forum_comment"
  | "profile"
  | "report";

// Final moderation result
export interface ModerationResult {
  decision: ModerationDecision;
  actions: ModerationAction[];
  reason: string;
  details: ModerationDetails;
  metadata: {
    processingTimeMs: number;
    rulesTrigered: string[];
    contentType: ContentType;
    timestamp: string;
  };
}

// Detailed moderation information
export interface ModerationDetails {
  textAnalysis: TextAnalysisResult | null;
  imageAnalysis: ImageAnalysisResult[] | null;
  overallSeverity: Severity;
  confidence: number;
  sanitizedContent: SanitizedContent | null;
  userHistory: UserHistoryContext | null;
}

// Sanitized content output
export interface SanitizedContent {
  title?: string;
  description?: string;
  content?: string;
  imagesRemoved?: number;
  fieldsModified: string[];
}

// User history for repeat offender detection
export interface UserHistoryContext {
  userId: string;
  previousViolations: number;
  lastViolationAt: string | null;
  trustScore: number;
  isNewUser: boolean;
}

// Moderation policy configuration
export interface ModerationPolicy {
  contentType: ContentType;
  strictness: "low" | "medium" | "high";
  autoApproveThreshold: number;
  autoRejectThreshold: number;
  allowSanitization: boolean;
  notifyOnRejection: boolean;
  requireImageForListing: boolean;
}

// Default policies
const DEFAULT_POLICIES: Record<ContentType, ModerationPolicy> = {
  listing: {
    contentType: "listing",
    strictness: "medium",
    autoApproveThreshold: 0.9,
    autoRejectThreshold: 0.3,
    allowSanitization: true,
    notifyOnRejection: true,
    requireImageForListing: true,
  },
  message: {
    contentType: "message",
    strictness: "low",
    autoApproveThreshold: 0.85,
    autoRejectThreshold: 0.2,
    allowSanitization: true,
    notifyOnRejection: false,
    requireImageForListing: false,
  },
  review: {
    contentType: "review",
    strictness: "medium",
    autoApproveThreshold: 0.85,
    autoRejectThreshold: 0.25,
    allowSanitization: true,
    notifyOnRejection: true,
    requireImageForListing: false,
  },
  forum_post: {
    contentType: "forum_post",
    strictness: "medium",
    autoApproveThreshold: 0.85,
    autoRejectThreshold: 0.25,
    allowSanitization: true,
    notifyOnRejection: true,
    requireImageForListing: false,
  },
  forum_comment: {
    contentType: "forum_comment",
    strictness: "low",
    autoApproveThreshold: 0.9,
    autoRejectThreshold: 0.2,
    allowSanitization: true,
    notifyOnRejection: false,
    requireImageForListing: false,
  },
  profile: {
    contentType: "profile",
    strictness: "medium",
    autoApproveThreshold: 0.9,
    autoRejectThreshold: 0.3,
    allowSanitization: true,
    notifyOnRejection: true,
    requireImageForListing: false,
  },
  report: {
    contentType: "report",
    strictness: "low",
    autoApproveThreshold: 0.95,
    autoRejectThreshold: 0.1,
    allowSanitization: false,
    notifyOnRejection: false,
    requireImageForListing: false,
  },
};

/**
 * Make moderation decision based on analysis results
 */
export function makeDecision(
  contentType: ContentType,
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null,
  userHistory: UserHistoryContext | null,
  policy?: Partial<ModerationPolicy>
): ModerationResult {
  const startTime = Date.now();
  const fullPolicy = { ...DEFAULT_POLICIES[contentType], ...policy };

  const actions: ModerationAction[] = [];
  const rulesTriggered: string[] = [];

  // Calculate overall severity and confidence
  const overallSeverity = calculateOverallSeverity(textAnalysis, imageAnalysis);
  const confidence = calculateConfidence(textAnalysis, imageAnalysis);

  // Check for immediate rejections
  if (shouldAutoReject(textAnalysis, imageAnalysis, fullPolicy)) {
    rulesTriggered.push("auto_reject_critical");

    // Check if user should be suspended
    if (shouldSuspendUser(overallSeverity, userHistory)) {
      actions.push("suspend_user");
      rulesTriggered.push("repeat_offender");
    }

    actions.push("reject", "notify_admins");

    return buildResult(
      "auto_reject",
      actions,
      "Content violates community guidelines",
      textAnalysis,
      imageAnalysis,
      overallSeverity,
      confidence,
      contentType,
      rulesTriggered,
      null,
      userHistory,
      startTime
    );
  }

  // Check for shadowban (severe repeat offenders)
  if (shouldShadowban(userHistory, overallSeverity)) {
    rulesTriggered.push("shadowban_triggered");
    actions.push("reject");

    return buildResult(
      "shadowban",
      actions,
      "Content flagged for review",
      textAnalysis,
      imageAnalysis,
      overallSeverity,
      confidence,
      contentType,
      rulesTriggered,
      null,
      userHistory,
      startTime
    );
  }

  // Check if sanitization can help
  let sanitizedContent: SanitizedContent | null = null;
  if (fullPolicy.allowSanitization && canSanitize(textAnalysis)) {
    sanitizedContent = applySanitization(textAnalysis);
    actions.push("sanitize");
    rulesTriggered.push("content_sanitized");
  }

  // Remove PII if found
  if (textAnalysis && textAnalysis.flags.some((f) => f.type === "pii")) {
    actions.push("remove_pii");
    rulesTriggered.push("pii_removed");
  }

  // Check images
  if (imageAnalysis && imageAnalysis.length > 0) {
    const problematicImages = imageAnalysis.filter((img) => !img.isAcceptable);
    if (problematicImages.length > 0) {
      if (problematicImages.some((img) => img.category === "nsfw")) {
        actions.push("blur_image");
        rulesTriggered.push("nsfw_image_detected");
      }
    }
  }

  // Calculate final score
  const score = calculateFinalScore(
    textAnalysis,
    imageAnalysis,
    sanitizedContent,
    userHistory
  );

  // Make decision based on score and policy
  let decision: ModerationDecision;
  let reason: string;

  if (score >= fullPolicy.autoApproveThreshold) {
    decision = "approve";
    reason = "Content meets community guidelines";
  } else if (score >= fullPolicy.autoRejectThreshold) {
    if (actions.length > 0) {
      decision = "approve_with_warning";
      reason = "Content approved with modifications";
    } else {
      decision = "require_review";
      reason = "Content requires manual review";
      actions.push("flag_for_review");
      rulesTriggered.push("manual_review_required");
    }
  } else {
    decision = "require_review";
    reason = "Content flagged for review due to low confidence";
    actions.push("flag_for_review");
    rulesTriggered.push("low_confidence_review");
  }

  // Add none action if no actions taken
  if (actions.length === 0) {
    actions.push("none");
  }

  return buildResult(
    decision,
    actions,
    reason,
    textAnalysis,
    imageAnalysis,
    overallSeverity,
    confidence,
    contentType,
    rulesTriggered,
    sanitizedContent,
    userHistory,
    startTime
  );
}

/**
 * Check if content should be auto-rejected
 */
function shouldAutoReject(
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null,
  _policy: ModerationPolicy
): boolean {
  // Critical text violations
  if (textAnalysis) {
    if (textAnalysis.category === "hate_speech") return true;
    if (textAnalysis.severity === "critical") return true;
    if (textAnalysis.flags.some((f) => f.type === "hate_speech")) return true;
  }

  // Critical image violations
  if (imageAnalysis) {
    for (const img of imageAnalysis) {
      if (img.category === "nsfw" && img.confidence > 0.8) return true;
      if (img.category === "violence" && img.confidence > 0.8) return true;
      if (img.flags.some((f) => f.severity === "critical")) return true;
    }
  }

  return false;
}

/**
 * Check if user should be suspended
 */
function shouldSuspendUser(
  severity: Severity,
  userHistory: UserHistoryContext | null
): boolean {
  if (!userHistory) return false;

  // Critical violation + previous violations
  if (severity === "critical" && userHistory.previousViolations >= 1) {
    return true;
  }

  // Multiple violations in short time
  if (userHistory.previousViolations >= 3 && userHistory.trustScore < 0.3) {
    return true;
  }

  return false;
}

/**
 * Check if user should be shadowbanned
 */
function shouldShadowban(
  userHistory: UserHistoryContext | null,
  severity: Severity
): boolean {
  if (!userHistory) return false;

  // Very low trust score with continued violations
  if (userHistory.trustScore < 0.1 && severity !== "none") {
    return true;
  }

  // Many violations
  if (userHistory.previousViolations >= 5) {
    return true;
  }

  return false;
}

/**
 * Check if content can be sanitized
 */
function canSanitize(textAnalysis: TextAnalysisResult | null): boolean {
  if (!textAnalysis) return false;
  if (textAnalysis.severity === "critical") return false;
  if (textAnalysis.category === "hate_speech") return false;

  // Can sanitize if there's sanitized text available
  return textAnalysis.sanitizedText !== null;
}

/**
 * Apply sanitization to content
 */
function applySanitization(textAnalysis: TextAnalysisResult | null): SanitizedContent | null {
  if (!textAnalysis || !textAnalysis.sanitizedText) return null;

  return {
    content: textAnalysis.sanitizedText,
    fieldsModified: textAnalysis.details.matchedPatterns,
  };
}

/**
 * Calculate overall severity
 */
function calculateOverallSeverity(
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null
): Severity {
  const severityOrder: Severity[] = ["none", "low", "medium", "high", "critical"];
  let highest: Severity = "none";

  if (textAnalysis) {
    if (severityOrder.indexOf(textAnalysis.severity) > severityOrder.indexOf(highest)) {
      highest = textAnalysis.severity;
    }
  }

  if (imageAnalysis) {
    for (const img of imageAnalysis) {
      for (const flag of img.flags) {
        const flagSeverity = flag.severity as Severity;
        if (severityOrder.indexOf(flagSeverity) > severityOrder.indexOf(highest)) {
          highest = flagSeverity;
        }
      }
    }
  }

  return highest;
}

/**
 * Calculate confidence score
 */
function calculateConfidence(
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null
): number {
  const scores: number[] = [];

  if (textAnalysis) {
    scores.push(textAnalysis.confidence);
  }

  if (imageAnalysis) {
    for (const img of imageAnalysis) {
      scores.push(img.confidence);
    }
  }

  if (scores.length === 0) return 1.0;

  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * Calculate final score for decision
 */
function calculateFinalScore(
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null,
  sanitizedContent: SanitizedContent | null,
  userHistory: UserHistoryContext | null
): number {
  let score = 1.0;

  // Text penalties
  if (textAnalysis && !textAnalysis.isClean) {
    const severityPenalty: Record<Severity, number> = {
      none: 0,
      low: 0.1,
      medium: 0.3,
      high: 0.5,
      critical: 0.9,
    };
    score -= severityPenalty[textAnalysis.severity];
  }

  // Image penalties
  if (imageAnalysis) {
    for (const img of imageAnalysis) {
      if (!img.isAcceptable) {
        score -= 0.2;
      }
    }
  }

  // Sanitization bonus (shows we can fix it)
  if (sanitizedContent) {
    score += 0.1;
  }

  // User trust bonus/penalty
  if (userHistory) {
    if (userHistory.trustScore > 0.8) {
      score += 0.1;
    } else if (userHistory.trustScore < 0.3) {
      score -= 0.2;
    }
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Build final result
 */
function buildResult(
  decision: ModerationDecision,
  actions: ModerationAction[],
  reason: string,
  textAnalysis: TextAnalysisResult | null,
  imageAnalysis: ImageAnalysisResult[] | null,
  overallSeverity: Severity,
  confidence: number,
  contentType: ContentType,
  rulesTriggered: string[],
  sanitizedContent: SanitizedContent | null,
  userHistory: UserHistoryContext | null,
  startTime: number
): ModerationResult {
  return {
    decision,
    actions,
    reason,
    details: {
      textAnalysis,
      imageAnalysis,
      overallSeverity,
      confidence,
      sanitizedContent,
      userHistory,
    },
    metadata: {
      processingTimeMs: Date.now() - startTime,
      rulesTrigered: rulesTriggered,
      contentType,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Get policy for content type
 */
export function getPolicy(
  contentType: ContentType,
  overrides?: Partial<ModerationPolicy>
): ModerationPolicy {
  return { ...DEFAULT_POLICIES[contentType], ...overrides };
}

/**
 * Check if decision requires human review
 */
export function requiresHumanReview(result: ModerationResult): boolean {
  return result.decision === "require_review" ||
    result.actions.includes("flag_for_review");
}

/**
 * Get user-facing message for decision
 */
export function getDecisionMessage(result: ModerationResult): string {
  switch (result.decision) {
    case "approve":
      return "Your content has been published.";
    case "approve_with_warning":
      return "Your content has been published with some modifications.";
    case "require_review":
      return "Your content is being reviewed and will be published shortly.";
    case "auto_reject":
      return "Your content could not be published as it violates our community guidelines.";
    case "shadowban":
      return "Your content has been submitted for review.";
    default:
      return "Your content is being processed.";
  }
}

export { DEFAULT_POLICIES };
