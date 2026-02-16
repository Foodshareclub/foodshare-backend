/**
 * Notification Template Engine
 *
 * Loads notification templates from the database with in-memory caching,
 * and interpolates {{variable}} placeholders with provided values.
 *
 * @module api-v1-notifications/lib/template-engine
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../../_shared/logger.ts";

// =============================================================================
// Types
// =============================================================================

export interface NotificationTemplate {
  id: string;
  name: string;
  type: string;
  title_template: string;
  body_template: string;
  channels: string[];
  priority: string;
  is_active: boolean;
}

// =============================================================================
// In-Memory Cache
// =============================================================================

const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const templateCache = new Map<string, {
  template: NotificationTemplate;
  cachedAt: number;
}>();

// =============================================================================
// Template Interpolation
// =============================================================================

/**
 * Replace {{variable}} placeholders in a template string with provided values.
 * Missing variables are left as-is (e.g., `{{var}}`).
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_match, key) => {
    const trimmedKey = key.trim();
    const value = variables[trimmedKey];
    if (value !== undefined && value !== null) {
      return String(value);
    }
    // Leave unresolved variables as-is
    return `{{${trimmedKey}}}`;
  });
}

// =============================================================================
// Template Loading
// =============================================================================

/**
 * Load a notification template by name from the database, with in-memory caching.
 * Returns null if the template is not found or inactive.
 */
export async function loadTemplate(
  supabase: SupabaseClient,
  name: string,
): Promise<NotificationTemplate | null> {
  // Check cache
  const cached = templateCache.get(name);
  if (cached && (Date.now() - cached.cachedAt) < TEMPLATE_CACHE_TTL_MS) {
    return cached.template;
  }

  try {
    const { data, error } = await supabase
      .from("notification_templates")
      .select("id,name,type,title_template,body_template,channels,priority,is_active")
      .eq("name", name)
      .eq("is_active", true)
      .maybeSingle();

    if (error) {
      logger.error("Failed to load notification template", new Error(error.message), { name });
      return null;
    }

    if (!data) {
      return null;
    }

    const template = data as NotificationTemplate;

    // Cache the result
    templateCache.set(name, {
      template,
      cachedAt: Date.now(),
    });

    return template;
  } catch (error) {
    logger.error(
      "Error loading notification template",
      error instanceof Error ? error : new Error(String(error)),
      { name },
    );
    return null;
  }
}

/**
 * Clear the template cache (useful for testing or admin cache invalidation).
 */
export function clearTemplateCache(): void {
  templateCache.clear();
}
