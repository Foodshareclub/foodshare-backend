/**
 * Display Name Service Types
 *
 * Type definitions for the enterprise display name service.
 */

/**
 * Profile data used for display name extraction
 */
export interface ProfileNameData {
  displayName?: string | null;
  firstName?: string | null;
  secondName?: string | null;
  lastName?: string | null;
  nickname?: string | null;
  email?: string | null;
}

/**
 * Display name extraction options
 */
export interface ExtractOptions {
  /** Prefer first name only even when full name is available */
  preferFirstNameOnly?: boolean;
  /** Minimum length for a name to be considered valid */
  minNameLength?: number;
  /** Custom fallback text when no name can be extracted */
  fallback?: string;
  /** Attempt smart extraction from email username */
  extractFromEmail?: boolean;
}

/**
 * Display name result with metadata
 */
export interface DisplayNameResult {
  /** The extracted display name */
  name: string;
  /** Source of the name (displayName, firstName, nickname, email, fallback) */
  source: DisplayNameSource;
  /** Whether an admin override is active */
  hasOverride: boolean;
  /** Override expiration if set */
  overrideExpiresAt?: string;
  /** User ID */
  userId: string;
}

/**
 * Source of display name extraction
 */
export type DisplayNameSource =
  | "displayName"
  | "firstName"
  | "fullName"
  | "nickname"
  | "email"
  | "override"
  | "fallback";

/**
 * Admin override for display name
 */
export interface DisplayNameOverride {
  userId: string;
  displayName: string;
  reason: string;
  overriddenBy: string;
  expiresAt?: string;
  createdAt: string;
}

/**
 * Batch lookup request
 */
export interface BatchLookupRequest {
  userIds: string[];
}

/**
 * Batch lookup result
 */
export interface BatchLookupResult {
  results: Record<string, DisplayNameResult>;
  errors: Record<string, string>;
}

/**
 * Service metrics
 */
export interface DisplayNameMetrics {
  /** Total lookups performed */
  totalLookups: number;
  /** Cache hit count */
  cacheHits: number;
  /** Cache miss count */
  cacheMisses: number;
  /** Cache hit rate percentage */
  cacheHitRate: number;
  /** Database lookups performed */
  databaseLookups: number;
  /** Batch lookups performed */
  batchLookups: number;
  /** Admin overrides set */
  overridesSet: number;
  /** Errors encountered */
  errors: number;
  /** Average lookup time in ms */
  avgLookupTimeMs: number;
  /** Service uptime in ms */
  uptimeMs: number;
}

/**
 * Database profile row (snake_case)
 */
export interface DatabaseProfileRow {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  second_name?: string | null;
  nickname?: string | null;
  email?: string | null;
}

/**
 * Database override row (snake_case)
 */
export interface DatabaseOverrideRow {
  user_id: string;
  display_name: string;
  reason: string;
  overridden_by: string;
  expires_at?: string | null;
  created_at: string;
}

/**
 * RPC response for get_display_name_data
 */
export interface DisplayNameDataResponse {
  profile: DatabaseProfileRow | null;
  override: DatabaseOverrideRow | null;
}

/**
 * RPC response for batch lookup
 */
export interface BatchDisplayNameDataResponse {
  user_id: string;
  profile: DatabaseProfileRow | null;
  override: DatabaseOverrideRow | null;
}
