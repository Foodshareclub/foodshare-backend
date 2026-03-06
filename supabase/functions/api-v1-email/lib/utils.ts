/**
 * Shared utilities for api-v1-email
 *
 * Auth helpers, HTML escaping, types, and service-role client accessor.
 */

import { getSupabaseClient } from "../../_shared/supabase.ts";
import { ForbiddenError } from "../../_shared/errors.ts";

// =============================================================================
// Configuration
// =============================================================================

export const VERSION = "1.0.0";

// =============================================================================
// Types
// =============================================================================

export interface AutomationQueueItem {
  id: string;
  enrollment_id: string;
  flow_id: string;
  profile_id: string;
  step_index: number;
  scheduled_for: string;
  status: string;
  attempts: number;
  email_data: {
    subject?: string;
    html?: string;
    text?: string;
    template_slug?: string;
    to?: string;
  };
}

export interface QueuedEmail {
  id: string;
  user_id: string;
  campaign_id: string | null;
  email_type: string;
  template_slug: string | null;
  user_email: string;
  user_first_name: string | null;
  retry_count: number;
  metadata: Record<string, unknown>;
}

export interface ProcessResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors?: string[];
}

// =============================================================================
// Service Role Client
// =============================================================================

export function getServiceRoleClient() {
  return getSupabaseClient();
}

// =============================================================================
// Cron/Service Auth
// =============================================================================

export function verifyServiceAuth(request: Request): boolean {
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = request.headers.get("X-Cron-Secret");
  if (authHeader && cronSecret && authHeader === cronSecret) return true;

  const bearerToken = request.headers.get("Authorization")?.replace("Bearer ", "");
  if (bearerToken && cronSecret && bearerToken === cronSecret) return true;
  if (bearerToken === serviceRoleKey) return true;

  if (request.headers.get("x-supabase-cron") === "true") return true;

  return false;
}

export function requireServiceAuth(request: Request): void {
  if (!verifyServiceAuth(request)) {
    throw new ForbiddenError("Service or cron authentication required");
  }
}

// =============================================================================
// HTML Helpers
// =============================================================================

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
