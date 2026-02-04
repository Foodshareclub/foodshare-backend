/**
 * Health Module - Edge Function Registry
 *
 * Centralized configuration for all edge functions monitored by health checks.
 * Functions are categorized by criticality for intelligent alerting.
 */

import { FunctionConfig } from "./types.ts";

// =============================================================================
// Critical Functions - Core Infrastructure
// =============================================================================

/**
 * Critical functions that must be operational for the system to function.
 * Failures in these trigger immediate alerts.
 */
export const CRITICAL_FUNCTIONS: FunctionConfig[] = [
  // Core Infrastructure
  { name: "bff", critical: true, requiresAuth: false, expectedStatus: [200, 400, 401] },
  { name: "feature-flags", critical: true, requiresAuth: false },
  { name: "geolocate-user", critical: true, requiresAuth: false },
  { name: "send-push-notification", critical: true, requiresAuth: false, skipInQuickCheck: true },
  { name: "check-login-rate", critical: true, requiresAuth: false, testPayload: { phone: "+1234567890", action: "check" } },
  // Unified Attestation API (consolidates verify-attestation, verify-android-attestation)
  { name: "api-v1-attestation", critical: true, requiresAuth: false, expectedStatus: [200, 400] },
  // Unified Notification System (consolidates ALL notifications: email, push, preferences, digests, triggers)
  { name: "api-v1-notifications", critical: true, requiresAuth: false },
];

// =============================================================================
// API Functions - REST Endpoints
// =============================================================================

/**
 * API endpoints - important but not critical.
 * Multiple failures may indicate broader issues.
 */
export const API_FUNCTIONS: FunctionConfig[] = [
  // Public APIs
  { name: "api-v1-products", critical: false, requiresAuth: false },
  { name: "api-v1-metrics", critical: false, requiresAuth: false },

  // Authenticated APIs
  { name: "api-v1-chat", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "api-v1-engagement", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "api-v1-food-chat", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "api-v1-profile", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "api-v1-reviews", critical: false, requiresAuth: true, expectedStatus: [200, 401] },

  // Unified Admin API (consolidates listings, users, email)
  { name: "api-v1-admin", critical: false, requiresAuth: false, expectedStatus: [200, 401, 403], skipInQuickCheck: true },

  // Unified Validation API (consolidates validate-listing, validate-profile, validate-review)
  { name: "api-v1-validation", critical: false, requiresAuth: false },

  // Unified Geocoding API (consolidates update-coordinates, update-post-coordinates)
  { name: "api-v1-geocoding", critical: false, requiresAuth: false },

  // Unified Listings API (consolidates create-listing, update-listing)
  { name: "api-v1-listings", critical: false, requiresAuth: false },
];

// =============================================================================
// Data Operation Functions
// =============================================================================

/**
 * Functions handling data operations (CRUD, sync, validation).
 */
export const DATA_FUNCTIONS: FunctionConfig[] = [
  // User Operations
  { name: "delete-user", critical: false, requiresAuth: true, expectedStatus: [200, 401], skipInQuickCheck: true },
  { name: "atomic-favorites", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "batch-operations", critical: false, requiresAuth: true, expectedStatus: [200, 401] },

  // Sync & Analytics
  { name: "sync", critical: false, requiresAuth: true, expectedStatus: [200, 401] },
  { name: "sync-analytics", critical: false, requiresAuth: false },
  { name: "track-event", critical: false, requiresAuth: false },

  // Location Services
  { name: "match-users", critical: false, requiresAuth: false },
];

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Utility and support functions - lower priority.
 */
export const UTILITY_FUNCTIONS: FunctionConfig[] = [
  // Cache & Performance
  { name: "cache-operation", critical: false, requiresAuth: false, testPayload: { operation: "exists", key: "health_ping" } },
  { name: "check-upstash-services", critical: false, requiresAuth: false },

  // Localization
  { name: "locale", critical: false, requiresAuth: false },
  { name: "localization", critical: false, requiresAuth: false },

  // Security & Utilities
  { name: "get-certificate-pins", critical: false, requiresAuth: false },
  { name: "get-my-chat-id", critical: false, requiresAuth: false },
  { name: "hf-inference", critical: false, requiresAuth: false, skipInQuickCheck: true },
  { name: "search-functions", critical: false, requiresAuth: false },

  // Image Processing
  { name: "resize-tinify-upload-image", critical: false, requiresAuth: false, skipInQuickCheck: true },
  { name: "upload-challenge-image", critical: false, requiresAuth: true, expectedStatus: [200, 401], skipInQuickCheck: true },
  { name: "cors-proxy-images", critical: false, requiresAuth: false },

  // Monitoring & Automation
  { name: "check-alerts", critical: false, requiresAuth: false },
  { name: "domain-monitor", critical: false, requiresAuth: false },
  { name: "process-automation-queue", critical: false, requiresAuth: false, skipInQuickCheck: true },
  { name: "process-email-queue", critical: false, requiresAuth: false, skipInQuickCheck: true },
  { name: "sentry-telegram-webhook", critical: false, requiresAuth: false },

  // Bots (webhooks, not directly callable)
  { name: "telegram-bot-foodshare", critical: false, requiresAuth: false, skipInQuickCheck: true },
  { name: "whatsapp-bot-foodshare", critical: false, requiresAuth: false, skipInQuickCheck: true },
];

// =============================================================================
// Merged Registry
// =============================================================================

/**
 * Complete registry of all edge functions
 */
export const EDGE_FUNCTIONS: FunctionConfig[] = [
  ...CRITICAL_FUNCTIONS,
  ...API_FUNCTIONS,
  ...DATA_FUNCTIONS,
  ...UTILITY_FUNCTIONS,
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get configuration for a specific function by name
 */
export function getFunctionConfig(name: string): FunctionConfig | undefined {
  return EDGE_FUNCTIONS.find((f) => f.name === name);
}

/**
 * Get all critical functions
 */
export function getCriticalFunctions(): FunctionConfig[] {
  return EDGE_FUNCTIONS.filter((f) => f.critical);
}

/**
 * Get functions for quick check mode (excludes slow/optional functions)
 */
export function getQuickCheckFunctions(): FunctionConfig[] {
  return EDGE_FUNCTIONS.filter((f) => !f.skipInQuickCheck);
}

/**
 * Get all function names
 */
export function getAllFunctionNames(): string[] {
  return EDGE_FUNCTIONS.map((f) => f.name);
}

/**
 * Check if a function exists in the registry
 */
export function isFunctionRegistered(name: string): boolean {
  return EDGE_FUNCTIONS.some((f) => f.name === name);
}
