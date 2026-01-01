/**
 * Admin Email API
 *
 * Edge Function for admin email management operations.
 * Provides email queue management, provider control, and suppression list.
 *
 * Routes:
 * Queue:
 * - POST /queue/:id/retry - Retry failed email
 * - DELETE /queue/:id - Delete queued email
 * - POST /queue/send - Send manual email
 *
 * Providers:
 * - POST /providers/:provider/reset-quota - Reset provider quota
 * - PUT /providers/:provider/availability - Update provider availability
 * - POST /providers/:provider/reset-circuit-breaker - Reset circuit breaker
 *
 * Suppression:
 * - POST /suppression - Add to suppression list
 * - DELETE /suppression/:email - Remove from suppression list
 */

import { createAPIHandler, ok, noContent, type HandlerContext } from "../_shared/api-handler.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Schemas
// =============================================================================

const emailProviderSchema = z.enum(["resend", "brevo", "mailersend", "ses"]);

const sendManualEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(100000),
  emailType: z.enum(["transactional", "marketing", "notification", "system"]),
  provider: emailProviderSchema.optional(),
});

const updateAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
});

const addSuppressionSchema = z.object({
  email: z.string().email(),
  reason: z.enum(["bounce", "complaint", "unsubscribe", "manual"]),
  notes: z.string().max(500).optional(),
});

const resetQuotaSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type EmailProvider = z.infer<typeof emailProviderSchema>;

// =============================================================================
// Admin Auth Helper
// =============================================================================

async function requireAdmin(ctx: HandlerContext): Promise<string> {
  if (!ctx.userId) {
    throw new ForbiddenError("Authentication required");
  }

  const { data: userRoles, error } = await ctx.supabase
    .from("user_roles")
    .select("roles!inner(name)")
    .eq("profile_id", ctx.userId);

  if (error) {
    logger.error("Failed to check admin role", { error: error.message });
    throw new ForbiddenError("Failed to verify admin access");
  }

  const roles = (userRoles || []).map(
    (r) => (r.roles as unknown as { name: string }).name
  );
  const isAdmin = roles.includes("admin") || roles.includes("superadmin");

  if (!isAdmin) {
    throw new ForbiddenError("Admin access required");
  }

  return ctx.userId;
}

// =============================================================================
// Handlers
// =============================================================================

async function handleRequest(ctx: HandlerContext): Promise<Response> {
  await requireAdmin(ctx);
  const url = new URL(ctx.request.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  const functionIndex = pathParts.findIndex((p) => p === "api-v1-admin-email");
  const subPath = pathParts.slice(functionIndex + 1);

  const category = subPath[0];

  switch (category) {
    case "queue":
      return handleQueueOperations(ctx, subPath.slice(1));
    case "providers":
      return handleProviderOperations(ctx, subPath.slice(1));
    case "suppression":
      return handleSuppressionOperations(ctx, subPath.slice(1));
    default:
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
      });
  }
}

// =============================================================================
// Queue Operations
// =============================================================================

async function handleQueueOperations(
  ctx: HandlerContext,
  subPath: string[]
): Promise<Response> {
  // POST /queue/send - Send manual email
  if (subPath[0] === "send" && ctx.request.method === "POST") {
    return handleSendManualEmail(ctx);
  }

  const queueId = subPath[0];
  const action = subPath[1];

  if (!queueId) {
    throw new ValidationError("Queue ID required");
  }

  // POST /queue/:id/retry - Retry failed email
  if (action === "retry" && ctx.request.method === "POST") {
    return handleRetryEmail(ctx, queueId);
  }

  // DELETE /queue/:id - Delete queued email
  if (!action && ctx.request.method === "DELETE") {
    return handleDeleteQueuedEmail(ctx, queueId);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleRetryEmail(
  ctx: HandlerContext,
  queueId: string
): Promise<Response> {
  const { error } = await ctx.supabase
    .from("email_queue")
    .update({
      status: "queued",
      next_retry_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", queueId);

  if (error) {
    throw new Error(error.message);
  }

  return ok({ queueId, retried: true }, ctx);
}

async function handleDeleteQueuedEmail(
  ctx: HandlerContext,
  queueId: string
): Promise<Response> {
  const { error } = await ctx.supabase
    .from("email_queue")
    .delete()
    .eq("id", queueId);

  if (error) {
    throw new Error(error.message);
  }

  return noContent(ctx);
}

async function handleSendManualEmail(ctx: HandlerContext): Promise<Response> {
  const input = sendManualEmailSchema.parse(ctx.body);

  const { data, error } = await ctx.supabase
    .from("email_queue")
    .insert({
      recipient_email: input.to,
      email_type: input.emailType,
      template_name: "manual_admin_email",
      template_data: {
        subject: input.subject,
        html: input.html,
        from: "admin@foodshare.club",
      },
      status: "queued",
      next_retry_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return ok({ messageId: data.id, queued: true }, ctx);
}

// =============================================================================
// Provider Operations
// =============================================================================

async function handleProviderOperations(
  ctx: HandlerContext,
  subPath: string[]
): Promise<Response> {
  const providerName = subPath[0];
  const action = subPath[1];

  if (!providerName) {
    throw new ValidationError("Provider name required");
  }

  const provider = emailProviderSchema.parse(providerName);

  switch (action) {
    case "reset-quota":
      if (ctx.request.method === "POST") {
        return handleResetProviderQuota(ctx, provider);
      }
      break;
    case "availability":
      if (ctx.request.method === "PUT") {
        return handleUpdateProviderAvailability(ctx, provider);
      }
      break;
    case "reset-circuit-breaker":
      if (ctx.request.method === "POST") {
        return handleResetCircuitBreaker(ctx, provider);
      }
      break;
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleResetProviderQuota(
  ctx: HandlerContext,
  provider: EmailProvider
): Promise<Response> {
  const input = resetQuotaSchema.parse(ctx.body || {});
  const targetDate = input.date || new Date().toISOString().split("T")[0];

  const { error } = await ctx.supabase
    .from("email_provider_quota")
    .update({ emails_sent: 0 })
    .eq("provider", provider)
    .eq("date", targetDate);

  if (error) {
    throw new Error(error.message);
  }

  return ok({ provider, date: targetDate, quotaReset: true }, ctx);
}

async function handleUpdateProviderAvailability(
  ctx: HandlerContext,
  provider: EmailProvider
): Promise<Response> {
  const input = updateAvailabilitySchema.parse(ctx.body);

  const { error } = await ctx.supabase.from("email_circuit_breaker").upsert(
    {
      provider,
      state: input.isAvailable ? "closed" : "open",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider" }
  );

  if (error) {
    throw new Error(error.message);
  }

  return ok({ provider, isAvailable: input.isAvailable }, ctx);
}

async function handleResetCircuitBreaker(
  ctx: HandlerContext,
  provider: EmailProvider
): Promise<Response> {
  const { error } = await ctx.supabase
    .from("email_circuit_breaker")
    .update({
      state: "closed",
      failures: 0,
      consecutive_successes: 0,
      last_failure_time: null,
      updated_at: new Date().toISOString(),
    })
    .eq("provider", provider);

  if (error) {
    throw new Error(error.message);
  }

  return ok({ provider, circuitBreakerReset: true }, ctx);
}

// =============================================================================
// Suppression Operations
// =============================================================================

async function handleSuppressionOperations(
  ctx: HandlerContext,
  subPath: string[]
): Promise<Response> {
  // POST /suppression - Add to suppression list
  if (!subPath[0] && ctx.request.method === "POST") {
    return handleAddToSuppressionList(ctx);
  }

  // DELETE /suppression/:email - Remove from suppression list
  const email = decodeURIComponent(subPath[0] || "");
  if (email && ctx.request.method === "DELETE") {
    return handleRemoveFromSuppressionList(ctx, email);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...ctx.corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleAddToSuppressionList(ctx: HandlerContext): Promise<Response> {
  const input = addSuppressionSchema.parse(ctx.body);

  const { error } = await ctx.supabase.from("email_suppression_list").insert({
    email: input.email.toLowerCase(),
    reason: input.reason,
    notes: input.notes,
    added_at: new Date().toISOString(),
  });

  if (error) {
    // Handle duplicate key error gracefully
    if (error.code === "23505") {
      return ok({ email: input.email, alreadySuppressed: true }, ctx);
    }
    throw new Error(error.message);
  }

  return ok({ email: input.email, added: true }, ctx);
}

async function handleRemoveFromSuppressionList(
  ctx: HandlerContext,
  email: string
): Promise<Response> {
  const { error } = await ctx.supabase
    .from("email_suppression_list")
    .delete()
    .eq("email", email.toLowerCase());

  if (error) {
    throw new Error(error.message);
  }

  return ok({ email, removed: true }, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "admin-email-api",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: { handler: handleRequest },
    POST: { handler: handleRequest },
    PUT: { handler: handleRequest },
    DELETE: { handler: handleRequest },
  },
});
