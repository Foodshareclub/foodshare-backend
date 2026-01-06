/**
 * Text Content Analyzer
 *
 * Analyzes text content for policy violations including:
 * - Profanity and hate speech
 * - Personal information (PII)
 * - Spam patterns
 * - Contact information (for safety)
 * - Prohibited content
 */

// Severity levels
export type Severity = "none" | "low" | "medium" | "high" | "critical";

// Text analysis categories
export type TextCategory =
  | "profanity"
  | "hate_speech"
  | "harassment"
  | "spam"
  | "pii"
  | "contact_info"
  | "prohibited"
  | "safe";

// Text analysis result
export interface TextAnalysisResult {
  isClean: boolean;
  category: TextCategory;
  severity: Severity;
  confidence: number;
  flags: TextFlag[];
  sanitizedText: string | null;
  details: {
    originalLength: number;
    matchedPatterns: string[];
    recommendations: string[];
  };
}

// Individual text flag
export interface TextFlag {
  type: TextCategory;
  severity: Severity;
  position: { start: number; end: number } | null;
  matched: string;
  reason: string;
}

// Profanity patterns (simplified - in production use a proper list)
const PROFANITY_PATTERNS = [
  /\b(f+u+c+k+|sh+i+t+|a+s+s+h+o+l+e+|b+i+t+c+h+|d+a+m+n+)\b/gi,
  /\b(c+u+n+t+|d+i+c+k+|p+r+i+c+k+|w+h+o+r+e+)\b/gi,
];

// Hate speech patterns
const HATE_SPEECH_PATTERNS = [
  /\b(k+i+l+l+\s+(all|them|yourself))\b/gi,
  /\b(racist|sexist)\s+(slur|term)/gi,
  /\b(death\s+to)\b/gi,
];

// PII patterns
const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
  ssn: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  address: /\b\d+\s+[A-Za-z]+\s+(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd)\b/gi,
};

// Contact info patterns (for safety - users shouldn't share contact in public listings)
const CONTACT_INFO_PATTERNS = {
  socialMedia: /@[a-zA-Z0-9_]{3,30}/g,
  website: /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/\S*)?/gi,
  messenger: /\b(whatsapp|telegram|signal|discord|snapchat|instagram|facebook|tiktok)\s*:?\s*@?[a-zA-Z0-9_]+/gi,
};

// Spam patterns
const SPAM_PATTERNS = [
  /(.)\1{5,}/g, // Repeated characters: aaaaaaaa
  /((.{2,})\2{3,})/g, // Repeated words/phrases
  /\b(free|winner|prize|lottery|claim|urgent|limited time)\b/gi,
  /\b(click here|subscribe now|act now|buy now)\b/gi,
  /!{3,}|\?{3,}/g, // Excessive punctuation
  /[A-Z]{10,}/g, // Excessive caps
];

// Prohibited content patterns
const PROHIBITED_PATTERNS = [
  /\b(drug|narcotic|cocaine|heroin|meth|marijuana|weed|cannabis)\b/gi,
  /\b(weapon|gun|firearm|ammunition|explosive)\b/gi,
  /\b(alcohol|beer|wine|liquor|vodka|whiskey)\b/gi,
  /\b(tobacco|cigarette|vape|nicotine)\b/gi,
];

/**
 * Analyze text content for policy violations
 */
export function analyzeText(text: string): TextAnalysisResult {
  const flags: TextFlag[] = [];
  let sanitizedText = text;

  // Check for profanity
  for (const pattern of PROFANITY_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "profanity",
        severity: "medium",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: match[0],
        reason: "Profane language detected",
      });
      sanitizedText = sanitizedText.replace(match[0], "*".repeat(match[0].length));
    }
  }

  // Check for hate speech
  for (const pattern of HATE_SPEECH_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "hate_speech",
        severity: "critical",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: match[0],
        reason: "Hate speech or violent content detected",
      });
    }
  }

  // Check for PII
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "pii",
        severity: "high",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: `[${type}]`,
        reason: `Personal information (${type}) detected`,
      });
      // Partially mask PII in sanitized text
      sanitizedText = sanitizedText.replace(match[0], maskPII(match[0], type));
    }
  }

  // Check for contact info
  for (const [type, pattern] of Object.entries(CONTACT_INFO_PATTERNS)) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "contact_info",
        severity: "low",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: match[0],
        reason: `Contact information (${type}) detected - use in-app messaging instead`,
      });
    }
  }

  // Check for spam patterns
  for (const pattern of SPAM_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "spam",
        severity: "low",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: match[0],
        reason: "Spam-like content detected",
      });
    }
  }

  // Check for prohibited content
  for (const pattern of PROHIBITED_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      flags.push({
        type: "prohibited",
        severity: "high",
        position: match.index !== undefined
          ? { start: match.index, end: match.index + match[0].length }
          : null,
        matched: match[0],
        reason: "Prohibited item mentioned - food sharing only",
      });
    }
  }

  // Determine overall result
  const isClean = flags.length === 0;
  const highestSeverity = getHighestSeverity(flags);
  const primaryCategory = getPrimaryCategory(flags);

  return {
    isClean,
    category: primaryCategory,
    severity: highestSeverity,
    confidence: calculateConfidence(flags, text),
    flags,
    sanitizedText: flags.length > 0 ? sanitizedText : null,
    details: {
      originalLength: text.length,
      matchedPatterns: [...new Set(flags.map((f) => f.type))],
      recommendations: generateRecommendations(flags),
    },
  };
}

/**
 * Quick check if text contains any violations
 */
export function quickCheck(text: string): { clean: boolean; severity: Severity } {
  // Quick patterns for fast rejection
  const quickPatterns = [
    ...PROFANITY_PATTERNS,
    ...HATE_SPEECH_PATTERNS,
    ...PROHIBITED_PATTERNS,
  ];

  for (const pattern of quickPatterns) {
    if (pattern.test(text)) {
      return { clean: false, severity: "medium" };
    }
  }

  return { clean: true, severity: "none" };
}

/**
 * Sanitize text by removing/masking violations
 */
export function sanitizeText(text: string): string {
  let sanitized = text;

  // Remove profanity
  for (const pattern of PROFANITY_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => "*".repeat(match.length));
  }

  // Mask PII
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    sanitized = sanitized.replace(pattern, (match) => maskPII(match, type));
  }

  // Clean up excessive punctuation/caps
  sanitized = sanitized.replace(/(.)\1{4,}/g, "$1$1$1"); // Max 3 repeated chars
  sanitized = sanitized.replace(/!{2,}/g, "!").replace(/\?{2,}/g, "?");

  return sanitized;
}

/**
 * Check text length and complexity
 */
export function analyzeComplexity(text: string): {
  wordCount: number;
  charCount: number;
  averageWordLength: number;
  isValid: boolean;
  issues: string[];
} {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const charCount = text.length;
  const averageWordLength = wordCount > 0
    ? words.reduce((sum, w) => sum + w.length, 0) / wordCount
    : 0;

  const issues: string[] = [];

  if (charCount < 3) {
    issues.push("Text too short");
  }
  if (charCount > 5000) {
    issues.push("Text too long (max 5000 characters)");
  }
  if (wordCount > 0 && averageWordLength > 20) {
    issues.push("Unusual word patterns detected");
  }

  return {
    wordCount,
    charCount,
    averageWordLength,
    isValid: issues.length === 0,
    issues,
  };
}

// Helper functions

function maskPII(value: string, type: string): string {
  switch (type) {
    case "email":
      return value.replace(/(.{2})(.*)(@.*)/, "$1***$3");
    case "phone":
      return value.replace(/(\d{3})(\d+)(\d{2})/, "$1-***-**$3");
    case "ssn":
      return "***-**-****";
    case "creditCard":
      return "**** **** **** " + value.slice(-4);
    default:
      return "[REDACTED]";
  }
}

function getHighestSeverity(flags: TextFlag[]): Severity {
  const severityOrder: Severity[] = ["none", "low", "medium", "high", "critical"];

  let highest: Severity = "none";
  for (const flag of flags) {
    if (severityOrder.indexOf(flag.severity) > severityOrder.indexOf(highest)) {
      highest = flag.severity;
    }
  }

  return highest;
}

function getPrimaryCategory(flags: TextFlag[]): TextCategory {
  if (flags.length === 0) return "safe";

  // Priority order
  const categoryPriority: TextCategory[] = [
    "hate_speech",
    "prohibited",
    "pii",
    "harassment",
    "profanity",
    "contact_info",
    "spam",
  ];

  for (const category of categoryPriority) {
    if (flags.some((f) => f.type === category)) {
      return category;
    }
  }

  return flags[0].type;
}

function calculateConfidence(flags: TextFlag[], text: string): number {
  if (flags.length === 0) return 1.0;

  // Base confidence on pattern matches
  let confidence = 0.5;

  // More matches = higher confidence
  confidence += Math.min(0.3, flags.length * 0.05);

  // Severity affects confidence
  const severity = getHighestSeverity(flags);
  const severityBoost: Record<Severity, number> = {
    none: 0,
    low: 0.05,
    medium: 0.1,
    high: 0.15,
    critical: 0.2,
  };
  confidence += severityBoost[severity];

  return Math.min(1.0, confidence);
}

function generateRecommendations(flags: TextFlag[]): string[] {
  const recommendations: string[] = [];
  const categories = new Set(flags.map((f) => f.type));

  if (categories.has("profanity")) {
    recommendations.push("Please use appropriate language");
  }
  if (categories.has("hate_speech")) {
    recommendations.push("Hateful content is not allowed");
  }
  if (categories.has("pii")) {
    recommendations.push("Avoid sharing personal information publicly");
  }
  if (categories.has("contact_info")) {
    recommendations.push("Use in-app messaging instead of sharing contact details");
  }
  if (categories.has("prohibited")) {
    recommendations.push("Only food items can be shared on this platform");
  }
  if (categories.has("spam")) {
    recommendations.push("Please provide genuine content");
  }

  return recommendations;
}

export { PROFANITY_PATTERNS, PII_PATTERNS, PROHIBITED_PATTERNS };
