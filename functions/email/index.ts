/**
 * Unified Email Edge Function v1.0.0
 *
 * Single entry point for all email operations:
 * - action: "send"          - Send email with explicit provider
 * - action: "process-queue" - Process queued emails
 * - action: "route"         - Get provider recommendation
 * - action: "health"        - Monitor provider health
 *
 * Also handles database triggers (INSERT/DELETE) for welcome/goodbye emails
 */

import { getPermissiveCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import {
  getEmailService,
  EmailType,
  EmailProviderName,
  ProviderHealth,
  ProviderQuota,
  PROVIDER_LIMITS,
} from "../_shared/email/index.ts";
import { welcomeEmail, goodbyeEmail, feedbackAlertEmail } from "../_shared/email/templates.ts";

const VERSION = "1.0.0";
const VALID_PROVIDERS: EmailProviderName[] = ["resend", "brevo", "aws_ses", "mailersend"];

// ============================================================================
// Types
// ============================================================================

type EmailAction = "send" | "process-queue" | "route" | "health";

interface BasePayload {
  action?: EmailAction;
}

interface SendPayload extends BasePayload {
  action: "send";
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  provider: EmailProviderName;
}

interface ProcessQueuePayload extends BasePayload {
  action: "process-queue";
  batchSize?: number;
  concurrency?: number;
}

interface RoutePayload extends BasePayload {
  action: "route";
  emailType: EmailType;
  forceRefresh?: boolean;
}

interface HealthPayload extends BasePayload {
  action: "health";
  mode?: "ping" | "full" | "status";
}

interface TriggerPayload {
  record?: {
    email: string;
    nickname?: string;
    first_name?: string;
    second_name?: string;
  };
  old_record?: {
    email: string;
    nickname?: string;
    first_name?: string;
    second_name?: string;
  };
  type?: "INSERT" | "DELETE";
  provider?: EmailProviderName;
}

// ============================================================================
// Helpers
// ============================================================================

function isValidProvider(provider: unknown): provider is EmailProviderName {
  return typeof provider === "string" && VALID_PROVIDERS.includes(provider as EmailProviderName);
}

function getDisplayName(user: TriggerPayload["record"]): string {
  if (!user) return "there";
  const fullName = [user.first_name, user.second_name].filter(Boolean).join(" ");
  return fullName || user.nickname || user.email?.split("@")[0] || "there";
}

function createResponse(
  data: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
  requestId: string
): Response {
  return new Response(JSON.stringify({ ...data, requestId, version: VERSION }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      "X-Version": VERSION,
    },
  });
}

// ============================================================================
// Action Handlers
// ============================================================================

async function handleSend(
  payload: SendPayload,
  corsHeaders: Record<string, string>,
  requestId: string,
  startTime: number
): Promise<Response> {
  const emailService = getEmailService();

  if (!payload.provider) {
    return createResponse(
      {
        success: false,
        error: "Provider is required. Use: resend, brevo, or aws_ses",
        validProviders: VALID_PROVIDERS,
      },
      400,
      corsHeaders,
      requestId
    );
  }

  if (!isValidProvider(payload.provider)) {
    return createResponse(
      {
        success: false,
        error: `Invalid provider: ${payload.provider}`,
        validProviders: VALID_PROVIDERS,
      },
      400,
      corsHeaders,
      requestId
    );
  }

  const result = await emailService.sendEmailWithProvider(
    {
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      from: payload.from,
      fromName: payload.fromName,
      replyTo: payload.replyTo,
    },
    payload.provider
  );

  return createResponse(
    {
      success: result.success,
      message: result.success ? "Email sent successfully" : result.error,
      provider: result.provider,
      messageId: result.messageId,
      responseTime: Math.round(performance.now() - startTime),
    },
    result.success ? 200 : 500,
    corsHeaders,
    requestId
  );
}

async function handleTrigger(
  payload: TriggerPayload,
  corsHeaders: Record<string, string>,
  requestId: string,
  startTime: number
): Promise<Response> {
  const emailService = getEmailService();
  const isDeleted = !!payload.old_record;
  const user = isDeleted ? payload.old_record : payload.record;

  if (!user?.email) {
    return createResponse(
      { success: false, error: "No email provided" },
      400,
      corsHeaders,
      requestId
    );
  }

  const provider: EmailProviderName = isValidProvider(payload.provider)
    ? payload.provider
    : "resend";

  const displayName = getDisplayName(user);
  const template = isDeleted
    ? goodbyeEmail({ name: displayName, email: user.email })
    : welcomeEmail({ name: displayName, email: user.email });

  const result = await emailService.sendEmailWithProvider(
    { to: user.email, subject: template.subject, html: template.html },
    provider
  );

  return createResponse(
    {
      success: result.success,
      message: result.success ? "Email sent successfully" : result.error,
      provider: result.provider,
      messageId: result.messageId,
      emailType: isDeleted ? "goodbye" : "welcome",
      responseTime: Math.round(performance.now() - startTime),
    },
    result.success ? 200 : 500,
    corsHeaders,
    requestId
  );
}

// ============================================================================
// Process Queue Handler
// ============================================================================

interface QueuedEmail {
  id: string;
  recipient_email: string;
  email_type: string;
  template_data: {
    subject?: string;
    html?: string;
    text?: string;
    from?: string;
    fromName?: string;
  };
  attempts: number;
  max_attempts: number;
  preferred_provider?: string;
}

interface ProcessResult {
  id: string;
  success: boolean;
  provider?: string;
  messageId?: string;
  error?: string;
  latencyMs: number;
}

// Resolve template by name if subject/html not provided directly
function resolveTemplate(
  templateName: string | undefined,
  templateData: Record<string, unknown>
): { subject: string; html: string } | null {
  if (!templateName) return null;

  switch (templateName) {
    case "feedback-alert":
      return feedbackAlertEmail(templateData as Parameters<typeof feedbackAlertEmail>[0]);
    case "welcome":
      return welcomeEmail(templateData as Parameters<typeof welcomeEmail>[0]);
    case "goodbye":
      return goodbyeEmail(templateData as Parameters<typeof goodbyeEmail>[0]);
    default:
      return null;
  }
}

async function processEmail(
  email: QueuedEmail,
  emailService: ReturnType<typeof getEmailService>
): Promise<ProcessResult> {
  const startTime = performance.now();

  // Try to resolve template if subject/html not directly provided
  let subject = email.template_data?.subject as string | undefined;
  let html = email.template_data?.html as string | undefined;

  if (!subject || !html) {
    const resolved = resolveTemplate(email.template_name, email.template_data || {});
    if (resolved) {
      subject = resolved.subject;
      html = resolved.html;
    }
  }

  if (!html || !subject) {
    return {
      id: email.id,
      success: false,
      error: "Missing required template data (subject or html)",
      latencyMs: 0,
    };
  }

  const emailType = (email.email_type || "notification") as EmailType;

  const result = await emailService.sendEmail(
    {
      to: email.recipient_email,
      subject,
      html,
      text: email.template_data?.text as string | undefined,
      from: email.template_data?.from as string | undefined,
      fromName: email.template_data?.fromName as string | undefined,
    },
    emailType
  );

  return {
    id: email.id,
    success: result.success,
    provider: result.provider,
    messageId: result.messageId,
    error: result.error,
    latencyMs: Math.round(performance.now() - startTime),
  };
}

async function handleProcessQueue(
  payload: ProcessQueuePayload,
  corsHeaders: Record<string, string>,
  requestId: string,
  startTime: number
): Promise<Response> {
  const supabase = getSupabaseClient();
  const emailService = getEmailService();
  const batchSize = payload.batchSize || 50;
  const concurrency = payload.concurrency || 5;

  const { data: emails, error } = await supabase.rpc("get_ready_emails", {
    p_limit: batchSize,
  });

  if (error) {
    return createResponse(
      { success: false, error: `Failed to fetch queue: ${error.message}` },
      500,
      corsHeaders,
      requestId
    );
  }

  if (!emails?.length) {
    return createResponse(
      {
        success: true,
        message: "No emails to process",
        processed: 0,
        durationMs: Math.round(performance.now() - startTime),
      },
      200,
      corsHeaders,
      requestId
    );
  }

  // Process in chunks
  const results: ProcessResult[] = [];
  for (let i = 0; i < emails.length; i += concurrency) {
    const chunk = emails.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((email: QueuedEmail) => processEmail(email, emailService))
    );
    results.push(...chunkResults);
  }

  // Update database
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (successful.length > 0) {
    await supabase
      .from("email_queue")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .in(
        "id",
        successful.map((r) => r.id)
      );

    const logs = successful
      .filter((r) => r.provider && r.messageId)
      .map((r) => ({
        provider: r.provider,
        provider_message_id: r.messageId,
        status: "sent",
        latency_ms: r.latencyMs,
      }));

    if (logs.length > 0) {
      await supabase.from("email_logs").insert(logs);
    }
  }

  for (const result of failed) {
    await supabase.rpc("retry_queued_email", {
      p_queue_id: result.id,
      p_error_message: result.error || "Unknown error",
    });
  }

  const byProvider: Record<string, { success: number; failed: number }> = {};
  for (const r of results) {
    const provider = r.provider || "unknown";
    if (!byProvider[provider]) byProvider[provider] = { success: 0, failed: 0 };
    if (r.success) byProvider[provider].success++;
    else byProvider[provider].failed++;
  }

  return createResponse(
    {
      success: true,
      message: "Queue processed",
      processed: results.length,
      successful: successful.length,
      failed: failed.length,
      avgLatencyMs:
        results.length > 0
          ? Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length)
          : 0,
      byProvider,
      durationMs: Math.round(performance.now() - startTime),
    },
    200,
    corsHeaders,
    requestId
  );
}

// ============================================================================
// Route Handler
// ============================================================================

interface HealthCacheEntry {
  data: ProviderHealth[];
  dbQuotas: Map<EmailProviderName, { sent: number; limit: number }>;
  expires: number;
}

let healthCache: HealthCacheEntry | null = null;
const CACHE_TTL = 60_000;

async function getDbQuotas(): Promise<Map<EmailProviderName, { sent: number; limit: number }>> {
  const quotas = new Map<EmailProviderName, { sent: number; limit: number }>();

  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("get_all_provider_health");

    if (error || !data?.length) {
      for (const [provider, limits] of Object.entries(PROVIDER_LIMITS)) {
        quotas.set(provider as EmailProviderName, { sent: 0, limit: limits.daily });
      }
      return quotas;
    }

    for (const row of data) {
      quotas.set(row.provider as EmailProviderName, {
        sent: row.emails_sent ?? 0,
        limit: PROVIDER_LIMITS[row.provider as EmailProviderName]?.daily ?? 100,
      });
    }
  } catch {
    for (const [provider, limits] of Object.entries(PROVIDER_LIMITS)) {
      quotas.set(provider as EmailProviderName, { sent: 0, limit: limits.daily });
    }
  }

  return quotas;
}

async function getHealthData(forceRefresh: boolean = false): Promise<{
  health: ProviderHealth[];
  dbQuotas: Map<EmailProviderName, { sent: number; limit: number }>;
  cached: boolean;
}> {
  if (!forceRefresh && healthCache && healthCache.expires > Date.now()) {
    return { health: healthCache.data, dbQuotas: healthCache.dbQuotas, cached: true };
  }

  const emailService = getEmailService();
  const [health, dbQuotas] = await Promise.all([
    emailService.checkAllHealth(forceRefresh),
    getDbQuotas(),
  ]);

  healthCache = { data: health, dbQuotas, expires: Date.now() + CACHE_TTL };
  return { health, dbQuotas, cached: false };
}

function selectProvider(
  emailType: EmailType,
  health: ProviderHealth[],
  dbQuotas: Map<EmailProviderName, { sent: number; limit: number }>
): { provider: EmailProviderName; reason: string; alternates: EmailProviderName[] } {
  const priorityOrder: EmailProviderName[] = ["resend", "brevo", "mailersend", "aws_ses"];
  const healthMap = new Map(health.map((h) => [h.provider, h]));

  let selected: EmailProviderName | null = null;
  let reason = "";
  const alternates: EmailProviderName[] = [];

  for (const provider of priorityOrder) {
    const h = healthMap.get(provider);
    const quota = dbQuotas.get(provider);

    if (!h || !h.configured) continue;
    if (h.status === "error") continue;

    const quotaRemaining = quota ? quota.limit - quota.sent : PROVIDER_LIMITS[provider].daily;
    if (quotaRemaining <= 0) continue;
    if (h.healthScore < 20) continue;

    if (!selected) {
      selected = provider;
      reason = `Health: ${h.healthScore}/100, Quota: ${quotaRemaining}/${quota?.limit || PROVIDER_LIMITS[provider].daily}, Latency: ${h.latencyMs}ms`;
    } else {
      alternates.push(provider);
    }
  }

  if (!selected) {
    selected = priorityOrder[0];
    reason = "Fallback - all providers degraded or unavailable";
  }

  return { provider: selected, reason, alternates };
}

async function handleRoute(
  payload: RoutePayload,
  corsHeaders: Record<string, string>,
  requestId: string,
  startTime: number
): Promise<Response> {
  const validTypes: EmailType[] = [
    "auth",
    "chat",
    "food_listing",
    "feedback",
    "review_reminder",
    "newsletter",
    "announcement",
    "welcome",
    "goodbye",
    "notification",
  ];

  if (!payload.emailType || !validTypes.includes(payload.emailType)) {
    return createResponse(
      { success: false, error: "Invalid emailType", validTypes },
      400,
      corsHeaders,
      requestId
    );
  }

  const { health, dbQuotas, cached } = await getHealthData(payload.forceRefresh);
  const { provider, reason, alternates } = selectProvider(payload.emailType, health, dbQuotas);

  return createResponse(
    {
      success: true,
      recommendation: { provider, reason, alternates, health },
      cached,
      durationMs: Math.round(performance.now() - startTime),
    },
    200,
    corsHeaders,
    requestId
  );
}

// ============================================================================
// Health Handler
// ============================================================================

const HEALTH_CRITICAL = 30;
const HEALTH_WARNING = 50;
const LATENCY_WARNING_MS = 2000;
const SUCCESS_RATE_WARNING = 0.7;
const RETENTION_DAYS = 90;

const recentAlerts = new Map<string, number>();
const ALERT_COOLDOWN_MS = 3600_000;

function shouldAlert(alertKey: string): boolean {
  const lastAlert = recentAlerts.get(alertKey);
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) return false;
  recentAlerts.set(alertKey, Date.now());
  return true;
}

interface HealthMetric {
  provider: string;
  healthScore: number;
  successRate: number;
  avgLatencyMs: number;
  totalRequests: number;
  consecutiveFailures: number;
  circuitState: string;
}

async function getHealthMetrics(
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<HealthMetric[]> {
  try {
    const { data, error } = await supabase
      .from("email_provider_health_metrics")
      .select("*")
      .order("provider");

    if (error) throw error;

    return (data || []).map((m: Record<string, unknown>) => ({
      provider: m.provider as string,
      healthScore: (m.health_score as number) ?? 100,
      successRate:
        (m.total_requests as number) > 0
          ? Math.round(((m.successful_requests as number) / (m.total_requests as number)) * 1000) /
            10
          : 100,
      avgLatencyMs: Math.round((m.average_latency_ms as number) ?? 0),
      totalRequests: (m.total_requests as number) ?? 0,
      consecutiveFailures: (m.consecutive_failures as number) ?? 0,
      circuitState: (m.circuit_state as string) ?? "closed",
    }));
  } catch {
    return [];
  }
}

function generateAlerts(providers: ProviderHealth[], metrics: HealthMetric[]): string[] {
  const alerts: string[] = [];

  for (const p of providers) {
    if (p.status === "error" && p.configured && shouldAlert(`error_${p.provider}`)) {
      alerts.push(`ERROR: ${p.provider} is down - ${p.message}`);
    }
    if (p.healthScore <= HEALTH_CRITICAL && p.configured && shouldAlert(`critical_${p.provider}`)) {
      alerts.push(`CRITICAL: ${p.provider} health=${p.healthScore}/100`);
    } else if (
      p.healthScore <= HEALTH_WARNING &&
      p.configured &&
      shouldAlert(`warning_${p.provider}`)
    ) {
      alerts.push(`WARNING: ${p.provider} health=${p.healthScore}/100`);
    }
    if (p.latencyMs > LATENCY_WARNING_MS && p.configured && shouldAlert(`latency_${p.provider}`)) {
      alerts.push(`WARNING: ${p.provider} latency=${p.latencyMs}ms`);
    }
  }

  for (const m of metrics) {
    if (
      m.totalRequests > 10 &&
      m.successRate < SUCCESS_RATE_WARNING * 100 &&
      shouldAlert(`success_${m.provider}`)
    ) {
      alerts.push(`WARNING: ${m.provider} success_rate=${m.successRate}%`);
    }
    if (m.circuitState === "open" && shouldAlert(`circuit_${m.provider}`)) {
      alerts.push(`ALERT: ${m.provider} circuit breaker OPEN`);
    }
  }

  return alerts;
}

async function handleHealth(
  payload: HealthPayload,
  corsHeaders: Record<string, string>,
  requestId: string,
  startTime: number
): Promise<Response> {
  const supabase = getSupabaseClient();
  const emailService = getEmailService();
  const mode = payload.mode || "full";

  const providers = await emailService.checkAllHealth(true);

  // Get quotas from both API and database
  const [liveQuotas, dbQuotasRaw] = await Promise.all([
    // Get live quotas from provider APIs (AWS SES has real quota API)
    Promise.all(
      (["resend", "brevo", "mailersend", "aws_ses"] as EmailProviderName[]).map(async (name) => {
        const provider = emailService.getProvider(name);
        if (provider?.getQuota) return provider.getQuota();
        return null;
      })
    ),
    // Get tracked usage from database
    (async () => {
      try {
        const { data, error } = await supabase.rpc("get_global_quota_status");
        if (error || !data?.length) {
          return Object.entries(PROVIDER_LIMITS).map(([provider, limits]) => ({
            provider: provider as EmailProviderName,
            daily: { sent: 0, limit: limits.daily, remaining: limits.daily, percentUsed: 0 },
            monthly: { sent: 0, limit: limits.monthly, remaining: limits.monthly, percentUsed: 0 },
          }));
        }
        return data.map((q: Record<string, unknown>) => ({
          provider: q.provider as EmailProviderName,
          daily: {
            sent: (q.daily_sent as number) || 0,
            limit: (q.daily_limit as number) || 100,
            remaining: (q.daily_remaining as number) || 0,
            percentUsed: Math.round((q.daily_percent_used as number) || 0),
          },
          monthly: {
            sent: (q.monthly_sent as number) || 0,
            limit: (q.monthly_limit as number) || 3000,
            remaining: (q.monthly_remaining as number) || 0,
            percentUsed: Math.round((q.monthly_percent_used as number) || 0),
          },
        }));
      } catch {
        return [];
      }
    })(),
  ]);

  // Merge live API quotas with database tracking
  // Priority: AWS SES uses live API data, others use DB tracking with API limits
  const quotas = dbQuotasRaw.map((dbQuota: ProviderQuota) => {
    const liveQuota = liveQuotas.find((q) => q?.provider === dbQuota.provider);

    // For AWS SES, use live quota from API (it has real-time data)
    if (dbQuota.provider === "aws_ses" && liveQuota && liveQuota.daily.limit > 0) {
      return {
        provider: dbQuota.provider,
        daily: {
          sent: Math.round(liveQuota.daily.limit - liveQuota.daily.remaining),
          limit: Math.round(liveQuota.daily.limit),
          remaining: Math.round(liveQuota.daily.remaining),
          percentUsed: liveQuota.daily.percentUsed,
        },
        monthly: dbQuota.monthly, // AWS doesn't have monthly limit in same way
        source: "api" as const,
      };
    }

    // For Resend/Brevo, use DB tracking with known limits
    return {
      ...dbQuota,
      source: "database" as const,
    };
  });

  // Calculate intelligent summary
  const configuredQuotas = quotas.filter((q) =>
    providers.find((p) => p.provider === q.provider && p.configured)
  );

  const summary = {
    totalProviders: providers.length,
    healthyProviders: providers.filter((p) => p.status === "ok" || p.status === "degraded").length,
    configuredProviders: providers.filter((p) => p.configured).length,
    // Daily capacity
    daily: {
      totalSent: configuredQuotas.reduce((sum, q) => sum + q.daily.sent, 0),
      totalLimit: configuredQuotas.reduce((sum, q) => sum + q.daily.limit, 0),
      totalRemaining: configuredQuotas.reduce((sum, q) => sum + q.daily.remaining, 0),
      percentUsed:
        configuredQuotas.length > 0
          ? Math.round(
              (configuredQuotas.reduce((sum, q) => sum + q.daily.sent, 0) /
                configuredQuotas.reduce((sum, q) => sum + q.daily.limit, 0)) *
                100
            )
          : 0,
    },
    // Monthly capacity
    monthly: {
      totalSent: configuredQuotas.reduce((sum, q) => sum + (q.monthly?.sent || 0), 0),
      totalLimit: configuredQuotas.reduce((sum, q) => sum + (q.monthly?.limit || 0), 0),
      totalRemaining: configuredQuotas.reduce((sum, q) => sum + (q.monthly?.remaining || 0), 0),
      percentUsed:
        configuredQuotas.length > 0
          ? Math.round(
              (configuredQuotas.reduce((sum, q) => sum + (q.monthly?.sent || 0), 0) /
                configuredQuotas.reduce((sum, q) => sum + (q.monthly?.limit || 0), 0)) *
                100
            )
          : 0,
    },
    // Recommendation
    bestProvider:
      providers
        .filter((p) => p.configured && p.status !== "error")
        .sort((a, b) => b.healthScore - a.healthScore)[0]?.provider || null,
  };

  if (mode === "ping") {
    return createResponse(
      {
        success: true,
        timestamp: new Date().toISOString(),
        providers: providers.map((p) => ({
          provider: p.provider,
          status: p.status,
          healthScore: p.healthScore,
          latencyMs: p.latencyMs,
          configured: p.configured,
        })),
        quotas: quotas.map((q) => ({
          provider: q.provider,
          daily: q.daily,
          monthly: q.monthly,
        })),
        summary,
        durationMs: Math.round(performance.now() - startTime),
      },
      200,
      corsHeaders,
      requestId
    );
  }

  if (mode === "status") {
    const serviceStatus = await emailService.getStatus();
    return createResponse(
      {
        success: true,
        timestamp: new Date().toISOString(),
        providers,
        quotas,
        summary,
        circuits: serviceStatus.circuits,
        config: serviceStatus.config,
        debugInfo: emailService.getDebugInfo(),
        durationMs: Math.round(performance.now() - startTime),
      },
      200,
      corsHeaders,
      requestId
    );
  }

  // Full monitoring
  const healthMetrics = await getHealthMetrics(supabase);
  const alerts = generateAlerts(providers, healthMetrics);

  // Take snapshot
  let snapshotsTaken = 0;
  try {
    const { error } = await supabase.rpc("snapshot_provider_health");
    if (!error) snapshotsTaken = 3;
  } catch {
    /* ignore */
  }

  // Cleanup old data at 2 AM UTC
  const now = new Date();
  if (now.getUTCHours() === 2) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
      await supabase
        .from("email_provider_health_history")
        .delete()
        .lt("created_at", cutoff.toISOString())
        .limit(1000);
    } catch {
      /* ignore */
    }
  }

  if (alerts.length > 0) {
    logger.warn("Email health alerts detected", { alerts, alertCount: alerts.length });
  }

  return createResponse(
    {
      success: true,
      timestamp: new Date().toISOString(),
      providers,
      quotas,
      summary,
      healthMetrics,
      alerts,
      snapshotsTaken,
      durationMs: Math.round(performance.now() - startTime),
    },
    200,
    corsHeaders,
    requestId
  );
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const corsHeaders = getPermissiveCorsHeaders();
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  try {
    const payload = await req.json();

    // Route by action
    const action = payload.action as EmailAction | undefined;

    switch (action) {
      case "send":
        return handleSend(payload as SendPayload, corsHeaders, requestId, startTime);

      case "process-queue":
        return handleProcessQueue(
          payload as ProcessQueuePayload,
          corsHeaders,
          requestId,
          startTime
        );

      case "route":
        return handleRoute(payload as RoutePayload, corsHeaders, requestId, startTime);

      case "health":
        return handleHealth(payload as HealthPayload, corsHeaders, requestId, startTime);

      default:
        // Check if it's a direct send request (has to, subject, html)
        if (payload.to && payload.subject && payload.html) {
          return handleSend(
            { ...payload, action: "send" } as SendPayload,
            corsHeaders,
            requestId,
            startTime
          );
        }

        // Check if it's a database trigger (has record or old_record)
        if (payload.record || payload.old_record) {
          return handleTrigger(payload as TriggerPayload, corsHeaders, requestId, startTime);
        }

        // Unknown payload
        return createResponse(
          {
            success: false,
            error: "Invalid request. Specify action: send, process-queue, route, or health",
            validActions: ["send", "process-queue", "route", "health"],
          },
          400,
          corsHeaders,
          requestId
        );
    }
  } catch (error) {
    logger.error("Email function error", error as Error);

    return createResponse(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        responseTime: Math.round(performance.now() - startTime),
      },
      500,
      corsHeaders,
      requestId
    );
  }
});
