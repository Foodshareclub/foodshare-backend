/**
 * Display Name Module
 *
 * Enterprise-grade display name extraction and management.
 *
 * Usage:
 * ```typescript
 * import { getDisplayNameService, extractDisplayName } from "../_shared/display-name/index.ts";
 *
 * // Pure utility (no caching, no database)
 * const name = extractDisplayName({ firstName: "John", email: "john@example.com" });
 *
 * // Service with caching and database
 * const service = getDisplayNameService(supabase);
 * const result = await service.getDisplayName(userId);
 * console.log(result.name, result.source);
 *
 * // Batch lookup
 * const batch = await service.getDisplayNameBatch(userIds);
 *
 * // Admin override
 * await service.setAdminOverride(userId, "New Name", "User requested", adminId);
 * ```
 */

// Re-export pure utility functions from original module
export {
  extractDisplayName,
  formatGreeting,
  isNameFallback,
  mapDatabaseProfile,
} from "../display-name.ts";

export type {
  ProfileNameData,
  ExtractOptions,
} from "../display-name.ts";

// Export types
export type {
  DisplayNameResult,
  DisplayNameSource,
  DisplayNameMetrics,
  DisplayNameOverride,
  BatchLookupRequest,
  BatchLookupResult,
  DatabaseProfileRow,
  DatabaseOverrideRow,
} from "./types.ts";

// Export errors
export {
  UserNotFoundError,
  BatchSizeExceededError,
  OverrideExistsError,
  OverrideNotFoundError,
  InvalidDisplayNameError,
  DisplayNameServiceUnavailableError,
} from "./errors.ts";

// Export service
export {
  DisplayNameService,
  getDisplayNameService,
  resetDisplayNameService,
} from "./display-name-service.ts";
