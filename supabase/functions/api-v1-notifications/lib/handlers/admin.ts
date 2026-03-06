/**
 * Admin Handlers for Notification API
 *
 * Admin-only operations including:
 * - Email provider stats sync from external APIs
 * - Provider health status
 * - Quota management
 *
 * @module api-v1-notifications/handlers/admin
 */

import { logger } from "../../../_shared/logger.ts";
import { getEmailService } from "../../../_shared/email/index.ts";
import type { NotificationContext } from "../types.ts";

const REQUEST_TIMEOUT_MS = 15000;

// ============================================================================
// Types
// ============================================================================

interface ProviderStats {
  provider: string;
  health: {
    status: string;
    healthScore: number;
    latencyMs: number;
    message: string;
  };
  quota: {
    daily: {
      sent: number;
      limit: number;
      remaining: number;
      percentUsed: number;
    };
    monthly?: {
      sent: number;
      limit: number;
      remaining: number;
      percentUsed: number;
    };
  };
  stats?: {
    delivered?: number;
    opened?: number;
    clicked?: number;
    bounced?: number;
    complained?: number;
  };
  syncedAt: string;
}

interface SyncResult {
  success: boolean;
  providers: ProviderStats[];
  errors: Array<{ provider: string; error: string }>;
  duration: number;
}

// ============================================================================
// Fetch Helpers
// ============================================================================

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Provider-Specific Stats Fetchers
// ============================================================================

async function fetchBrevoStats(): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return {};

  try {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const [statsRes, accountRes] = await Promise.all([
      fetchWithTimeout(
        `https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=${startDate}&endDate=${endDate}`,
        { method: "GET", headers: { "api-key": apiKey, Accept: "application/json" } },
      ),
      fetchWithTimeout("https://api.brevo.com/v3/account", {
        method: "GET",
        headers: { "api-key": apiKey, Accept: "application/json" },
      }),
    ]);

    const stats = statsRes.ok ? await statsRes.json() : {};
    const account = accountRes.ok ? await accountRes.json() : {};

    return {
      requests: stats.requests ?? 0,
      delivered: stats.delivered ?? 0,
      opened: stats.uniqueOpens ?? stats.opens ?? 0,
      clicked: stats.uniqueClicks ?? stats.clicks ?? 0,
      hardBounces: stats.hardBounces ?? 0,
      softBounces: stats.softBounces ?? 0,
      blocked: stats.blocked ?? 0,
      complaints: stats.spamReports ?? 0,
      credits: account.plan?.[0]?.credits ?? 0,
    };
  } catch (error) {
    logger.warn("Failed to fetch Brevo stats", { error: String(error) });
    return {};
  }
}

async function fetchMailerSendStats(): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("MAILERSEND_API_KEY");
  if (!apiKey) return {};

  try {
    const dateFrom = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const dateTo = Math.floor(Date.now() / 1000);

    const response = await fetchWithTimeout(
      `https://api.mailersend.com/v1/analytics?date_from=${dateFrom}&date_to=${dateTo}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      },
    );

    if (!response.ok) return {};

    const data = await response.json();
    const stats = data.data?.[0]?.stats || {};

    return {
      sent: stats.sent ?? 0,
      delivered: stats.delivered ?? 0,
      opened: stats.opened ?? 0,
      clicked: stats.clicked ?? 0,
      hardBounced: stats.hard_bounced ?? 0,
      softBounced: stats.soft_bounced ?? 0,
      complained: stats.spam_complaints ?? 0,
    };
  } catch (error) {
    logger.warn("Failed to fetch MailerSend stats", { error: String(error) });
    return {};
  }
}

async function fetchResendStats(): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return {};

  try {
    const response = await fetchWithTimeout("https://api.resend.com/domains", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) return {};

    const data = await response.json();
    const domains = data.data || [];

    return {
      domains: domains.length,
      domainStatus: domains[0]?.status || "unknown",
    };
  } catch (error) {
    logger.warn("Failed to fetch Resend stats", { error: String(error) });
    return {};
  }
}

// ============================================================================
// Core Sync Logic
// ============================================================================

async function syncProvider(providerName: string): Promise<ProviderStats> {
  const emailService = getEmailService();
  const provider = emailService.getProvider(
    providerName as "resend" | "brevo" | "aws_ses" | "mailersend",
  );

  if (!provider) {
    throw new Error(`Provider ${providerName} not found`);
  }

  const [health, quota] = await Promise.all([provider.checkHealth(), provider.getQuota()]);

  let externalStats: Record<string, unknown> = {};
  switch (providerName) {
    case "brevo":
      externalStats = await fetchBrevoStats();
      break;
    case "mailersend":
      externalStats = await fetchMailerSendStats();
      break;
    case "resend":
      externalStats = await fetchResendStats();
      break;
    case "aws_ses": {
      // AWS SES stats come from the quota call
      externalStats = {
        sent24h: quota.daily?.sent ?? 0,
        max24h: quota.daily?.limit ?? 0,
      };
      break;
    }
  }

  return {
    provider: providerName,
    health: {
      status: health.status,
      healthScore: health.healthScore,
      latencyMs: health.latencyMs,
      message: health.message || "",
    },
    quota: {
      daily: quota.daily || { sent: 0, limit: 0, remaining: 0, percentUsed: 0 },
      monthly: quota.monthly,
    },
    stats: {
      delivered: (externalStats.delivered as number) ?? undefined,
      opened: (externalStats.opened as number) ?? undefined,
      clicked: (externalStats.clicked as number) ?? undefined,
      bounced: ((externalStats.hardBounces as number) ?? 0) +
          ((externalStats.softBounces as number) ?? 0) +
          ((externalStats.bounces as number) ?? 0) || undefined,
      complained: (externalStats.complaints as number) ?? (externalStats.complained as number) ??
        undefined,
    },
    syncedAt: new Date().toISOString(),
  };
}

async function storeProviderStats(
  context: NotificationContext,
  stats: ProviderStats,
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Upsert to email_provider_stats table
  const { error } = await context.supabase.from("email_provider_stats").upsert(
    {
      provider: stats.provider,
      date: today,
      requests_total: stats.stats?.delivered ?? 0,
      requests_success: stats.stats?.delivered ?? 0,
      requests_failed: stats.stats?.bounced ?? 0,
      emails_sent: stats.quota.daily.sent,
      emails_delivered: stats.stats?.delivered ?? 0,
      emails_opened: stats.stats?.opened ?? 0,
      emails_clicked: stats.stats?.clicked ?? 0,
      emails_bounced: stats.stats?.bounced ?? 0,
      emails_complained: stats.stats?.complained ?? 0,
      avg_latency_ms: stats.health.latencyMs,
      total_latency_ms: stats.health.latencyMs,
      daily_quota_limit: stats.quota.daily.limit,
      monthly_quota_limit: stats.quota.monthly?.limit ?? 15000,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,date" },
  );

  if (error) {
    logger.warn("Failed to store provider stats", {
      provider: stats.provider,
      error: error.message,
    });
  }

  // Also update email_provider_health_metrics
  // Note: We use GREATEST to preserve internal tracking if higher than provider API stats
  // (provider APIs have reporting delays)
  try {
    const { data: existing } = await context.supabase
      .from("email_provider_health_metrics")
      .select("daily_quota_used, monthly_quota_used, total_requests, successful_requests")
      .eq("provider", stats.provider)
      .single();

    await context.supabase.from("email_provider_health_metrics").upsert(
      {
        provider: stats.provider,
        health_score: stats.health.healthScore,
        // Preserve internal tracking if higher than provider stats
        total_requests: Math.max(existing?.total_requests ?? 0, stats.stats?.delivered ?? 0),
        successful_requests: Math.max(
          existing?.successful_requests ?? 0,
          stats.stats?.delivered ?? 0,
        ),
        failed_requests: stats.stats?.bounced ?? 0,
        average_latency_ms: stats.health.latencyMs,
        // Use MAX of internal tracking and provider API
        daily_quota_used: Math.max(existing?.daily_quota_used ?? 0, stats.quota.daily.sent),
        daily_quota_limit: stats.quota.daily.limit,
        monthly_quota_used: Math.max(
          existing?.monthly_quota_used ?? 0,
          stats.quota.monthly?.sent ?? 0,
        ),
        monthly_quota_limit: stats.quota.monthly?.limit ?? 15000,
        emails_delivered: stats.stats?.delivered ?? 0,
        emails_opened: stats.stats?.opened ?? 0,
        emails_clicked: stats.stats?.clicked ?? 0,
        emails_bounced: stats.stats?.bounced ?? 0,
        emails_complained: stats.stats?.complained ?? 0,
        last_synced_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
      { onConflict: "provider" },
    );
  } catch {
    // Table might not exist yet
  }
}

// ============================================================================
// Admin Route Handlers
// ============================================================================

/**
 * GET /admin/providers/status
 * Get current provider status without syncing
 */
export async function handleAdminProviderStatus(
  _context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const emailService = getEmailService();
    const status = await emailService.getStatus();

    return {
      success: true,
      data: {
        ...status,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * POST /admin/providers/sync
 * Sync all providers' stats from external APIs
 */
export async function handleAdminProviderSync(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: SyncResult; error?: string }> {
  const startTime = performance.now();
  const providers = ["resend", "brevo", "mailersend", "aws_ses"];
  const results: ProviderStats[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  const { provider: specificProvider } = (body as { provider?: string }) || {};

  const providersToSync = specificProvider ? [specificProvider] : providers;

  // Sync providers in parallel
  const syncPromises = providersToSync.map(async (providerName) => {
    try {
      const stats = await syncProvider(providerName);
      results.push(stats);
      await storeProviderStats(context, stats);

      logger.info("Synced provider stats", {
        requestId: context.requestId,
        provider: providerName,
        healthScore: stats.health.healthScore,
        dailySent: stats.quota.daily.sent,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: providerName, error: errorMsg });
      logger.error("Failed to sync provider", new Error(errorMsg), {
        requestId: context.requestId,
        provider: providerName,
      });
    }
  });

  await Promise.all(syncPromises);

  const result: SyncResult = {
    success: errors.length === 0,
    providers: results,
    errors,
    duration: Math.round(performance.now() - startTime),
  };

  return { success: true, data: result };
}

/**
 * GET /admin/providers/health
 * Get provider health from database
 */
export async function handleAdminProviderHealth(
  context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const { data, error } = await context.supabase
      .from("email_provider_health_metrics")
      .select("*")
      .order("last_updated", { ascending: false });

    if (error) {
      return { success: false, error: error.message };
    }

    // Transform to expected format
    const providers = (data || []).map((m) => ({
      provider: m.provider,
      healthScore: m.health_score || 100,
      successRate: m.total_requests > 0
        ? Math.round((m.successful_requests / m.total_requests) * 1000) / 10
        : 100,
      avgLatencyMs: m.average_latency_ms || 0,
      totalRequests: m.total_requests || 0,
      status: m.health_score >= 80 ? "healthy" : m.health_score >= 50 ? "degraded" : "down",
      lastSynced: m.last_synced_at,
      quota: {
        daily: {
          used: m.daily_quota_used || 0,
          limit: m.daily_quota_limit || 500,
        },
        monthly: {
          used: m.monthly_quota_used || 0,
          limit: m.monthly_quota_limit || 15000,
        },
      },
    }));

    // Return defaults if no data
    if (providers.length === 0) {
      return {
        success: true,
        data: {
          providers: [
            { provider: "resend", healthScore: 100, status: "idle", totalRequests: 0 },
            { provider: "brevo", healthScore: 100, status: "idle", totalRequests: 0 },
            { provider: "mailersend", healthScore: 100, status: "idle", totalRequests: 0 },
            { provider: "aws_ses", healthScore: 100, status: "idle", totalRequests: 0 },
          ],
        },
      };
    }

    return { success: true, data: { providers } };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * GET /admin/stats
 * Get email dashboard statistics
 */
export async function handleAdminStats(
  context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    // Try the enhanced stats function first
    const { data, error } = await context.supabase.rpc("get_email_dashboard_stats_v2");

    if (error) {
      // Fallback to basic stats
      const today = new Date().toISOString().split("T")[0];
      const { data: statsData } = await context.supabase
        .from("email_provider_stats")
        .select("*")
        .eq("date", today);

      return {
        success: true,
        data: {
          providers: statsData || [],
          generatedAt: new Date().toISOString(),
        },
      };
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * POST /admin/test-email
 * Send a test email via specified provider
 */
export async function handleAdminTestEmail(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { provider, recipient } = (body as { provider?: string; recipient?: string }) || {};

  if (!recipient) {
    return { success: false, error: "recipient is required" };
  }

  const providerName = provider || "resend";
  const emailService = getEmailService();

  try {
    const result = await emailService.sendEmailWithProvider(
      {
        to: recipient,
        subject: `Test Email from ${providerName.toUpperCase()}`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>Test Email</h2>
            <p>This is a test email sent via <strong>${providerName}</strong> provider.</p>
            <p>Sent at: ${new Date().toISOString()}</p>
            <p>Request ID: ${context.requestId}</p>
          </div>
        `,
      },
      providerName as "resend" | "brevo" | "mailersend" | "aws_ses",
    );

    // Record the send in health metrics
    if (result.success) {
      await context.supabase.rpc("record_email_send", {
        p_provider: providerName,
        p_success: true,
        p_latency_ms: result.latencyMs || 100,
        p_message_id: result.messageId || null,
      });
    }

    return {
      success: result.success,
      error: result.error,
      data: {
        provider: providerName,
        recipient,
        messageId: result.messageId,
        latencyMs: result.latencyMs,
        sentAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

/**
 * Router for admin routes
 */
export async function handleAdminRoute(
  segments: string[],
  method: string,
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: unknown; error?: string; status?: number }> {
  // /admin/providers/status - GET
  if (segments[1] === "providers" && segments[2] === "status" && method === "GET") {
    return handleAdminProviderStatus(context);
  }

  // /admin/providers/sync - POST
  if (segments[1] === "providers" && segments[2] === "sync" && method === "POST") {
    return handleAdminProviderSync(body, context);
  }

  // /admin/providers/health - GET
  if (segments[1] === "providers" && segments[2] === "health" && method === "GET") {
    return handleAdminProviderHealth(context);
  }

  // /admin/stats - GET
  if (segments[1] === "stats" && method === "GET") {
    return handleAdminStats(context);
  }

  // /admin/test-email - POST
  if (segments[1] === "test-email" && method === "POST") {
    return handleAdminTestEmail(body, context);
  }

  return {
    success: false,
    error: "Admin route not found",
    status: 404,
  };
}
