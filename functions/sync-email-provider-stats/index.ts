/**
 * Sync Email Provider Stats
 *
 * Fetches real-time statistics from all email providers' APIs
 * and syncs them to the database for the Email CRM dashboard.
 *
 * Routes:
 * - GET  /health         - Health check
 * - POST /sync           - Sync all providers
 * - POST /sync/:provider - Sync specific provider
 * - GET  /status         - Get current provider status
 *
 * Providers supported:
 * - Resend: Domains, emails list
 * - Brevo: Account credits, SMTP statistics
 * - MailerSend: Analytics, activity
 * - AWS SES: GetSendQuota, GetSendStatistics
 *
 * Can be triggered via cron (recommended: every 5 minutes)
 *
 * @module sync-email-provider-stats
 * @version 1.0.0
 */

import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { getEmailService } from "../_shared/email/index.ts";

const VERSION = "1.0.0";
const SERVICE = "sync-email-provider-stats";
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
// Provider-Specific Stats Fetchers
// ============================================================================

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch Brevo SMTP statistics
 */
async function fetchBrevoStats(): Promise<{
  requests?: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  hardBounces?: number;
  softBounces?: number;
  blocked?: number;
  complaints?: number;
  credits?: number;
}> {
  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) return {};

  try {
    // Fetch aggregated report for last 7 days
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const [statsRes, accountRes] = await Promise.all([
      fetchWithTimeout(
        `https://api.brevo.com/v3/smtp/statistics/aggregatedReport?startDate=${startDate}&endDate=${endDate}`,
        {
          method: "GET",
          headers: { "api-key": apiKey, Accept: "application/json" },
        }
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

/**
 * Fetch MailerSend analytics
 */
async function fetchMailerSendStats(): Promise<{
  sent?: number;
  delivered?: number;
  opened?: number;
  clicked?: number;
  hardBounced?: number;
  softBounced?: number;
  complained?: number;
}> {
  const apiKey = Deno.env.get("MAILERSEND_API_KEY");
  if (!apiKey) return {};

  try {
    // Fetch analytics for last 7 days
    const dateFrom = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    const dateTo = Math.floor(Date.now() / 1000);

    const response = await fetchWithTimeout(
      `https://api.mailersend.com/v1/analytics?date_from=${dateFrom}&date_to=${dateTo}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
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

/**
 * Fetch AWS SES send statistics
 */
async function fetchAWSSESStats(): Promise<{
  deliveryAttempts?: number;
  bounces?: number;
  complaints?: number;
  rejects?: number;
  sent24h?: number;
  max24h?: number;
}> {
  const region = Deno.env.get("AWS_REGION") || Deno.env.get("AWS_SES_REGION");
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID") || Deno.env.get("AWS_SES_ACCESS_KEY_ID");
  const secretAccessKey =
    Deno.env.get("AWS_SECRET_ACCESS_KEY") || Deno.env.get("AWS_SES_SECRET_ACCESS_KEY");

  if (!region || !accessKeyId || !secretAccessKey) return {};

  try {
    // Use the email service's AWS SES provider which has signing logic
    const emailService = getEmailService();
    const sesProvider = emailService.getProvider("aws_ses");

    if (!sesProvider || !sesProvider.isConfigured()) return {};

    const quota = await sesProvider.getQuota();

    return {
      sent24h: quota.daily?.sent ?? 0,
      max24h: quota.daily?.limit ?? 0,
    };
  } catch (error) {
    logger.warn("Failed to fetch AWS SES stats", { error: String(error) });
    return {};
  }
}

/**
 * Fetch Resend email count (limited API - just domain health)
 */
async function fetchResendStats(): Promise<{
  domains?: number;
  domainStatus?: string;
}> {
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

/**
 * Sync stats for a single provider
 */
async function syncProvider(providerName: string): Promise<ProviderStats> {
  const emailService = getEmailService();
  const provider = emailService.getProvider(providerName as "resend" | "brevo" | "aws_ses" | "mailersend");

  if (!provider) {
    throw new Error(`Provider ${providerName} not found`);
  }

  // Get health and quota from provider
  const [health, quota] = await Promise.all([provider.checkHealth(), provider.getQuota()]);

  // Get provider-specific stats
  let externalStats: Record<string, unknown> = {};
  switch (providerName) {
    case "brevo":
      externalStats = await fetchBrevoStats();
      break;
    case "mailersend":
      externalStats = await fetchMailerSendStats();
      break;
    case "aws_ses":
      externalStats = await fetchAWSSESStats();
      break;
    case "resend":
      externalStats = await fetchResendStats();
      break;
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
      bounced:
        ((externalStats.hardBounces as number) ?? 0) +
          ((externalStats.softBounces as number) ?? 0) +
          ((externalStats.bounces as number) ?? 0) || undefined,
      complained: (externalStats.complaints as number) ?? (externalStats.complained as number) ?? undefined,
    },
    syncedAt: new Date().toISOString(),
  };
}

/**
 * Sync all providers and store in database
 */
async function syncAllProviders(supabase: ReturnType<typeof getSupabaseClient>): Promise<SyncResult> {
  const startTime = performance.now();
  const providers = ["resend", "brevo", "mailersend", "aws_ses"];
  const results: ProviderStats[] = [];
  const errors: Array<{ provider: string; error: string }> = [];

  // Sync all providers in parallel
  const syncPromises = providers.map(async (providerName) => {
    try {
      const stats = await syncProvider(providerName);
      results.push(stats);

      // Store in database
      await storeProviderStats(supabase, stats);

      logger.info(`Synced provider stats`, {
        provider: providerName,
        healthScore: stats.health.healthScore,
        dailySent: stats.quota.daily.sent,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push({ provider: providerName, error: errorMsg });
      logger.error(`Failed to sync provider`, new Error(errorMsg), { provider: providerName });
    }
  });

  await Promise.all(syncPromises);

  return {
    success: errors.length === 0,
    providers: results,
    errors,
    duration: Math.round(performance.now() - startTime),
  };
}

/**
 * Store provider stats in database
 */
async function storeProviderStats(
  supabase: ReturnType<typeof getSupabaseClient>,
  stats: ProviderStats
): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Upsert to email_provider_stats table
  const { error } = await supabase.from("email_provider_stats").upsert(
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
    { onConflict: "provider,date" }
  );

  if (error) {
    logger.warn("Failed to store provider stats", { provider: stats.provider, error: error.message });
  }

  // Also update email_provider_health_metrics if it exists
  try {
    await supabase.from("email_provider_health_metrics").upsert(
      {
        provider: stats.provider,
        health_score: stats.health.healthScore,
        total_requests: stats.stats?.delivered ?? 0,
        successful_requests: stats.stats?.delivered ?? 0,
        failed_requests: stats.stats?.bounced ?? 0,
        average_latency_ms: stats.health.latencyMs,
        last_updated: new Date().toISOString(),
      },
      { onConflict: "provider" }
    );
  } catch {
    // Table might not exist, ignore
  }
}

// ============================================================================
// HTTP Handler
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const startTime = performance.now();
  const requestId = crypto.randomUUID();
  const corsHeaders = getCorsHeaders(req);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/sync-email-provider-stats\/?/, "").replace(/^\/+/, "");
  const segments = path.split("/").filter(Boolean);

  try {
    // Health check
    if (segments[0] === "health" || segments.length === 0) {
      return new Response(
        JSON.stringify({
          status: "healthy",
          version: VERSION,
          service: SERVICE,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = getSupabaseClient();

    // GET /status - Get current provider status without syncing
    if (segments[0] === "status" && req.method === "GET") {
      const emailService = getEmailService();
      const status = await emailService.getStatus();

      return new Response(
        JSON.stringify({
          success: true,
          requestId,
          ...status,
          timestamp: new Date().toISOString(),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // POST /sync - Sync all providers
    if (segments[0] === "sync" && req.method === "POST") {
      // Check for specific provider
      const providerName = segments[1];

      if (providerName) {
        // Sync single provider
        try {
          const stats = await syncProvider(providerName);
          await storeProviderStats(supabase, stats);

          return new Response(
            JSON.stringify({
              success: true,
              requestId,
              provider: stats,
              duration: Math.round(performance.now() - startTime),
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } catch (error) {
          return new Response(
            JSON.stringify({
              success: false,
              requestId,
              error: error instanceof Error ? error.message : String(error),
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      // Sync all providers
      const result = await syncAllProviders(supabase);

      logger.info("Email provider stats sync completed", {
        requestId,
        success: result.success,
        providersCount: result.providers.length,
        errorsCount: result.errors.length,
        durationMs: result.duration,
      });

      return new Response(
        JSON.stringify({
          success: result.success,
          requestId,
          ...result,
        }),
        {
          status: result.success ? 200 : 207,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Not found
    return new Response(
      JSON.stringify({
        success: false,
        error: "Not found",
        availableRoutes: [
          "GET  /health",
          "GET  /status",
          "POST /sync",
          "POST /sync/:provider",
        ],
      }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Sync failed", err, { requestId });

    return new Response(
      JSON.stringify({
        success: false,
        error: err.message,
        requestId,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
