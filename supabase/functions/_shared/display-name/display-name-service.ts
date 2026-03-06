/**
 * Display Name Service
 *
 * Enterprise-grade singleton service for display name management.
 * Features:
 * - In-memory caching with TTL
 * - Database fallback with admin overrides
 * - Batch lookups for efficiency
 * - Metrics collection
 * - Backwards compatible with pure utility functions
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { cache, CACHE_KEYS, CACHE_TTLS, cacheThrough } from "../cache.ts";
import { logger } from "../logger.ts";
import {
  extractDisplayName,
  type ExtractOptions,
  mapDatabaseProfile,
  type ProfileNameData,
} from "../display-name.ts";
import { BatchSizeExceededError, InvalidDisplayNameError, UserNotFoundError } from "./errors.ts";
import type {
  BatchLookupResult,
  DatabaseOverrideRow,
  DatabaseProfileRow,
  DisplayNameMetrics,
  DisplayNameOverride,
  DisplayNameResult,
  DisplayNameSource,
} from "./types.ts";

// =============================================================================
// Constants
// =============================================================================

const MAX_BATCH_SIZE = 100;
const SERVICE_VERSION = "1.0.0";

// =============================================================================
// Metrics
// =============================================================================

interface ServiceMetrics {
  totalLookups: number;
  cacheHits: number;
  cacheMisses: number;
  databaseLookups: number;
  batchLookups: number;
  overridesSet: number;
  errors: number;
  totalLookupTimeMs: number;
  startedAt: number;
}

const metrics: ServiceMetrics = {
  totalLookups: 0,
  cacheHits: 0,
  cacheMisses: 0,
  databaseLookups: 0,
  batchLookups: 0,
  overridesSet: 0,
  errors: 0,
  totalLookupTimeMs: 0,
  startedAt: Date.now(),
};

// =============================================================================
// Display Name Service Class
// =============================================================================

export class DisplayNameService {
  private supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Get display name for a user with caching
   */
  async getDisplayName(
    userId: string,
    options?: ExtractOptions,
  ): Promise<DisplayNameResult> {
    const startTime = performance.now();
    metrics.totalLookups++;

    try {
      // Check cache first
      const cacheKey = CACHE_KEYS.displayName(userId);
      const cached = cache.get<DisplayNameResult>(cacheKey);

      if (cached) {
        metrics.cacheHits++;
        return cached;
      }

      metrics.cacheMisses++;

      // Check for admin override first
      const override = await this.getOverride(userId);

      if (override && this.isOverrideActive(override)) {
        const result: DisplayNameResult = {
          name: override.displayName,
          source: "override",
          hasOverride: true,
          overrideExpiresAt: override.expiresAt,
          userId,
        };
        cache.set(cacheKey, result, CACHE_TTLS.displayName);
        return result;
      }

      // Fetch profile from database
      metrics.databaseLookups++;
      const profile = await this.fetchProfileData(userId);

      if (!profile) {
        throw new UserNotFoundError(userId);
      }

      // Extract display name using pure function
      const profileData = mapDatabaseProfile(profile as unknown as Record<string, unknown>);
      const name = extractDisplayName(profileData, options);

      // Determine source
      const source = this.determineSource(profileData, name, options);

      const result: DisplayNameResult = {
        name,
        source,
        hasOverride: false,
        userId,
      };

      // Cache the result
      cache.set(cacheKey, result, CACHE_TTLS.displayName);

      return result;
    } catch (error) {
      metrics.errors++;
      logger.error(
        "Failed to get display name",
        error instanceof Error ? error : new Error(String(error)),
        {
          userId,
        },
      );
      throw error;
    } finally {
      const elapsed = performance.now() - startTime;
      metrics.totalLookupTimeMs += elapsed;
    }
  }

  /**
   * Batch lookup for multiple users (max 100)
   */
  async getDisplayNameBatch(
    userIds: string[],
    options?: ExtractOptions,
  ): Promise<BatchLookupResult> {
    if (userIds.length > MAX_BATCH_SIZE) {
      throw new BatchSizeExceededError(userIds.length, MAX_BATCH_SIZE);
    }

    if (userIds.length === 0) {
      return { results: {}, errors: {} };
    }

    metrics.batchLookups++;
    const startTime = performance.now();

    const results: Record<string, DisplayNameResult> = {};
    const errors: Record<string, string> = {};
    const uncachedIds: string[] = [];

    // Check cache first for all users
    for (const userId of userIds) {
      const cacheKey = CACHE_KEYS.displayName(userId);
      const cached = cache.get<DisplayNameResult>(cacheKey);

      if (cached) {
        metrics.cacheHits++;
        results[userId] = cached;
      } else {
        uncachedIds.push(userId);
      }
    }

    // Fetch uncached users in batch
    if (uncachedIds.length > 0) {
      metrics.cacheMisses += uncachedIds.length;

      try {
        // Try RPC batch function first
        const { data: batchData, error: batchError } = await this.supabase.rpc(
          "get_display_name_data_batch",
          { p_user_ids: uncachedIds },
        );

        if (batchError) {
          // Fallback to individual queries
          logger.warn("Batch RPC failed, falling back to individual queries", {
            error: batchError.message,
          });
          await this.fallbackBatchLookup(uncachedIds, results, errors, options);
        } else if (batchData) {
          // Process batch results
          for (const item of batchData) {
            try {
              const result = this.processUserData(
                item.user_id,
                item.profile,
                item.override,
                options,
              );
              results[item.user_id] = result;
              cache.set(
                CACHE_KEYS.displayName(item.user_id),
                result,
                CACHE_TTLS.displayName,
              );
            } catch (err) {
              errors[item.user_id] = err instanceof Error ? err.message : String(err);
            }
          }
        }
      } catch (_error) {
        // Fallback to individual queries
        await this.fallbackBatchLookup(uncachedIds, results, errors, options);
      }
    }

    metrics.totalLookupTimeMs += performance.now() - startTime;

    return { results, errors };
  }

  /**
   * Pure extraction function (backwards compatible)
   * Does not use caching or database - just extracts from provided profile data
   */
  extract(profile: ProfileNameData, options?: ExtractOptions): string {
    return extractDisplayName(profile, options);
  }

  /**
   * Set admin override for a user's display name
   */
  async setAdminOverride(
    userId: string,
    displayName: string,
    reason: string,
    adminUserId: string,
    expiresAt?: string,
  ): Promise<DisplayNameOverride> {
    // Validate display name
    if (!displayName || displayName.trim().length < 2) {
      throw new InvalidDisplayNameError("Display name must be at least 2 characters");
    }

    if (displayName.length > 100) {
      throw new InvalidDisplayNameError("Display name must be at most 100 characters");
    }

    const trimmedName = displayName.trim();

    const { data, error } = await this.supabase
      .from("display_name_overrides")
      .upsert(
        {
          user_id: userId,
          display_name: trimmedName,
          reason,
          overridden_by: adminUserId,
          expires_at: expiresAt || null,
        },
        { onConflict: "user_id" },
      )
      .select()
      .single();

    if (error) {
      logger.error("Failed to set display name override", new Error(error.message), {
        userId,
        adminUserId,
      });
      throw error;
    }

    metrics.overridesSet++;

    // Invalidate cache
    this.invalidateCache(userId);

    logger.info("Display name override set", {
      userId,
      displayName: trimmedName,
      adminUserId,
    });

    return {
      userId: data.user_id,
      displayName: data.display_name,
      reason: data.reason,
      overriddenBy: data.overridden_by,
      expiresAt: data.expires_at,
      createdAt: data.created_at,
    };
  }

  /**
   * Remove admin override for a user
   */
  async removeAdminOverride(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("display_name_overrides")
      .delete()
      .eq("user_id", userId);

    if (error) {
      logger.error("Failed to remove display name override", new Error(error.message), {
        userId,
      });
      throw error;
    }

    // Invalidate cache
    this.invalidateCache(userId);

    logger.info("Display name override removed", { userId });
  }

  /**
   * Get service metrics
   */
  getMetrics(): DisplayNameMetrics {
    const avgLookupTimeMs = metrics.totalLookups > 0
      ? metrics.totalLookupTimeMs / metrics.totalLookups
      : 0;

    const totalCacheAttempts = metrics.cacheHits + metrics.cacheMisses;
    const cacheHitRate = totalCacheAttempts > 0
      ? (metrics.cacheHits / totalCacheAttempts) * 100
      : 0;

    return {
      totalLookups: metrics.totalLookups,
      cacheHits: metrics.cacheHits,
      cacheMisses: metrics.cacheMisses,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      databaseLookups: metrics.databaseLookups,
      batchLookups: metrics.batchLookups,
      overridesSet: metrics.overridesSet,
      errors: metrics.errors,
      avgLookupTimeMs: Math.round(avgLookupTimeMs * 100) / 100,
      uptimeMs: Date.now() - metrics.startedAt,
    };
  }

  /**
   * Get service version
   */
  getVersion(): string {
    return SERVICE_VERSION;
  }

  /**
   * Invalidate cache for a user
   */
  invalidateCache(userId: string): void {
    cache.delete(CACHE_KEYS.displayName(userId));
    cache.delete(CACHE_KEYS.displayNameOverride(userId));
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private async fetchProfileData(userId: string): Promise<DatabaseProfileRow | null> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, display_name, first_name, second_name, nickname, email")
      .eq("id", userId)
      .is("deleted_at", null)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return null;
      }
      throw error;
    }

    return data;
  }

  private async getOverride(userId: string): Promise<DisplayNameOverride | null> {
    const cacheKey = CACHE_KEYS.displayNameOverride(userId);

    return cacheThrough(
      cacheKey,
      async () => {
        const { data, error } = await this.supabase
          .from("display_name_overrides")
          .select("*")
          .eq("user_id", userId)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            return null;
          }
          throw error;
        }

        return {
          userId: data.user_id,
          displayName: data.display_name,
          reason: data.reason,
          overriddenBy: data.overridden_by,
          expiresAt: data.expires_at,
          createdAt: data.created_at,
        };
      },
      { ttl: CACHE_TTLS.displayName },
    );
  }

  private isOverrideActive(override: DisplayNameOverride): boolean {
    if (!override.expiresAt) {
      return true;
    }
    return new Date(override.expiresAt) > new Date();
  }

  private determineSource(
    profile: ProfileNameData,
    extractedName: string,
    options?: ExtractOptions,
  ): DisplayNameSource {
    const fallback = options?.fallback ?? "there";

    if (extractedName === fallback) {
      return "fallback";
    }

    // Check in priority order
    if (
      profile.displayName &&
      extractedName.toLowerCase().includes(profile.displayName.toLowerCase().split(" ")[0])
    ) {
      return "displayName";
    }

    if (profile.firstName && extractedName.toLowerCase() === profile.firstName.toLowerCase()) {
      return "firstName";
    }

    if (profile.firstName && profile.secondName) {
      const fullName = `${profile.firstName} ${profile.secondName}`.trim();
      if (extractedName.toLowerCase() === fullName.toLowerCase()) {
        return "fullName";
      }
    }

    if (
      profile.nickname &&
      extractedName.toLowerCase().includes(profile.nickname.toLowerCase().split(" ")[0])
    ) {
      return "nickname";
    }

    if (profile.email) {
      return "email";
    }

    return "fallback";
  }

  private processUserData(
    userId: string,
    profile: DatabaseProfileRow | null,
    override: DatabaseOverrideRow | null,
    options?: ExtractOptions,
  ): DisplayNameResult {
    // Check override first
    if (override) {
      const overrideData: DisplayNameOverride = {
        userId: override.user_id,
        displayName: override.display_name,
        reason: override.reason,
        overriddenBy: override.overridden_by,
        expiresAt: override.expires_at || undefined,
        createdAt: override.created_at,
      };

      if (this.isOverrideActive(overrideData)) {
        return {
          name: override.display_name,
          source: "override",
          hasOverride: true,
          overrideExpiresAt: override.expires_at || undefined,
          userId,
        };
      }
    }

    if (!profile) {
      throw new UserNotFoundError(userId);
    }

    const profileData = mapDatabaseProfile(profile as unknown as Record<string, unknown>);
    const name = extractDisplayName(profileData, options);
    const source = this.determineSource(profileData, name, options);

    return {
      name,
      source,
      hasOverride: false,
      userId,
    };
  }

  private async fallbackBatchLookup(
    userIds: string[],
    results: Record<string, DisplayNameResult>,
    errors: Record<string, string>,
    options?: ExtractOptions,
  ): Promise<void> {
    metrics.databaseLookups += userIds.length;

    // Fetch profiles in batch
    const { data: profiles, error: profileError } = await this.supabase
      .from("profiles")
      .select("id, display_name, first_name, second_name, nickname, email")
      .in("id", userIds)
      .is("deleted_at", null);

    if (profileError) {
      for (const userId of userIds) {
        errors[userId] = profileError.message;
      }
      return;
    }

    // Fetch overrides in batch
    const { data: overrides } = await this.supabase
      .from("display_name_overrides")
      .select("*")
      .in("user_id", userIds);

    const overrideMap = new Map(
      (overrides || []).map((o) => [o.user_id, o]),
    );

    const profileMap = new Map(
      (profiles || []).map((p) => [p.id, p]),
    );

    for (const userId of userIds) {
      try {
        const profile = profileMap.get(userId) || null;
        const override = overrideMap.get(userId) || null;

        const result = this.processUserData(userId, profile, override, options);
        results[userId] = result;
        cache.set(CACHE_KEYS.displayName(userId), result, CACHE_TTLS.displayName);
      } catch (err) {
        errors[userId] = err instanceof Error ? err.message : String(err);
      }
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let serviceInstance: DisplayNameService | null = null;

/**
 * Get singleton instance of DisplayNameService
 */
export function getDisplayNameService(supabase: SupabaseClient): DisplayNameService {
  if (!serviceInstance) {
    serviceInstance = new DisplayNameService(supabase);
  }
  return serviceInstance;
}

/**
 * Reset singleton instance (for testing)
 */
export function resetDisplayNameService(): void {
  serviceInstance = null;
}
