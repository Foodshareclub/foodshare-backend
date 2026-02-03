/**
 * Email Template API - Cross-Platform Email Template Service
 *
 * Endpoints:
 * - GET  /templates          - List all active templates
 * - GET  /templates/:slug    - Get single template by slug
 * - POST /render             - Render template with variables
 * - POST /send               - Render and send email
 * - GET  /health             - Health check
 *
 * This Edge Function provides unified access to email templates stored in the
 * database, enabling iOS, Android, and Web applications to share a single
 * source of truth for email content.
 */

import { getCorsHeadersWithMobile, handleMobileCorsPrelight } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { logger } from "../_shared/logger.ts";
import { cache } from "../_shared/cache.ts";

const VERSION = "1.0.0";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Types
// ============================================================================

interface TemplateVariable {
  name: string;
  type: "string" | "number" | "boolean" | "date" | "url";
  required: boolean;
  default?: unknown;
}

interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  category: string;
  subject: string;
  html_content: string;
  text_content: string | null;
  variables: TemplateVariable[];
  metadata: Record<string, unknown>;
  version: number;
  updated_at?: string;
}

interface RenderRequest {
  slug: string;
  variables: Record<string, unknown>;
  format?: "html" | "text" | "both";
}

interface SendRequest {
  slug: string;
  variables: Record<string, unknown>;
  to: string;
  from?: string;
  fromName?: string;
  replyTo?: string;
  emailType?: string;
}

interface RenderedEmail {
  subject: string;
  html?: string;
  text?: string;
}

// ============================================================================
// Template Rendering
// ============================================================================

/**
 * Render template with variable substitution
 * Supports both {{variable}} and {{ .Variable }} syntax
 */
function renderTemplate(template: string, variables: Record<string, unknown>): string {
  if (!template) return "";

  let result = template;

  // Replace {{variable}} syntax (Mustache-style)
  result = result.replace(/\{\{(\s*[\w.]+\s*)\}\}/g, (_, key) => {
    const trimmedKey = key.trim();
    const value = getNestedValue(variables, trimmedKey);
    return value !== undefined ? String(value) : "";
  });

  // Replace {{ .Variable }} syntax (Go-style)
  result = result.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
    return value !== undefined ? String(value) : "";
  });

  return result;
}

/**
 * Get nested value from object using dot notation
 * e.g., getNestedValue({user: {name: "John"}}, "user.name") => "John"
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Build final variables with defaults applied
 */
function buildFinalVariables(
  templateVars: TemplateVariable[],
  inputVars: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const v of templateVars) {
    if (v.name in inputVars) {
      result[v.name] = inputVars[v.name];
    } else if (v.default !== undefined) {
      result[v.name] = v.default;
    }
  }

  // Also include any extra variables not in schema (for flexibility)
  for (const [key, value] of Object.entries(inputVars)) {
    if (!(key in result)) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Validate required variables are present
 */
function validateRequiredVariables(
  templateVars: TemplateVariable[],
  inputVars: Record<string, unknown>
): string[] {
  const missing: string[] = [];

  for (const v of templateVars) {
    if (v.required && !(v.name in inputVars) && v.default === undefined) {
      missing.push(v.name);
    }
  }

  return missing;
}

// ============================================================================
// Cache Helpers
// ============================================================================

function getCacheKey(slug: string): string {
  return `email_template:${slug}`;
}

function getCachedTemplate(slug: string): EmailTemplate | null {
  return cache.get<EmailTemplate>(getCacheKey(slug));
}

function setCachedTemplate(slug: string, template: EmailTemplate): void {
  cache.set(getCacheKey(slug), template, CACHE_TTL_MS);
}

// ============================================================================
// Database Operations
// ============================================================================

async function fetchTemplateBySlug(slug: string): Promise<EmailTemplate | null> {
  // Check cache first
  const cached = getCachedTemplate(slug);
  if (cached) {
    logger.info("Template cache hit", { slug });
    return cached;
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("email_templates")
    .select("id, slug, name, category, subject, html_content, text_content, variables, metadata, version")
    .eq("slug", slug)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    logger.warn("Template not found", { slug, error: error?.message });
    return null;
  }

  // Cache the template
  setCachedTemplate(slug, data as EmailTemplate);

  return data as EmailTemplate;
}

async function fetchAllTemplates(category?: string): Promise<EmailTemplate[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from("email_templates")
    .select("id, slug, name, category, subject, variables, metadata, version, updated_at")
    .eq("is_active", true)
    .order("name");

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;

  if (error) {
    logger.error("Failed to fetch templates", error);
    throw new Error(`Failed to fetch templates: ${error.message}`);
  }

  return (data || []) as EmailTemplate[];
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleListTemplates(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const url = new URL(req.url);
  const category = url.searchParams.get("category") || undefined;

  const templates = await fetchAllTemplates(category);

  return new Response(
    JSON.stringify({
      success: true,
      templates,
      count: templates.length,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleGetTemplate(
  slug: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const template = await fetchTemplateBySlug(slug);

  if (!template) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Template not found",
        code: "TEMPLATE_NOT_FOUND",
      }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      template,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleRenderTemplate(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body: RenderRequest = await req.json();
  const { slug, variables = {}, format = "both" } = body;

  if (!slug) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required field: slug",
        code: "MISSING_SLUG",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Fetch template
  const template = await fetchTemplateBySlug(slug);

  if (!template) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Template not found",
        code: "TEMPLATE_NOT_FOUND",
      }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Validate required variables
  const templateVars = (template.variables || []) as TemplateVariable[];
  const missingVars = validateRequiredVariables(templateVars, variables);

  if (missingVars.length > 0) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required variables",
        code: "MISSING_VARIABLES",
        missing: missingVars,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Build final variables with defaults
  const finalVars = buildFinalVariables(templateVars, variables);

  // Render template
  const rendered: RenderedEmail = {
    subject: renderTemplate(template.subject, finalVars),
  };

  if (format === "html" || format === "both") {
    rendered.html = renderTemplate(template.html_content, finalVars);
  }

  if (format === "text" || format === "both") {
    rendered.text = renderTemplate(template.text_content || "", finalVars);
  }

  logger.info("Template rendered", { slug, variableCount: Object.keys(finalVars).length });

  return new Response(
    JSON.stringify({
      success: true,
      ...rendered,
      templateVersion: template.version,
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleSendEmail(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body: SendRequest = await req.json();
  const { slug, variables = {}, to, from, fromName, replyTo, emailType = "transactional" } = body;

  if (!slug || !to) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required fields: slug and to are required",
        code: "MISSING_FIELDS",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Fetch and render template
  const template = await fetchTemplateBySlug(slug);

  if (!template) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Template not found",
        code: "TEMPLATE_NOT_FOUND",
      }),
      {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Validate required variables
  const templateVars = (template.variables || []) as TemplateVariable[];
  const missingVars = validateRequiredVariables(templateVars, variables);

  if (missingVars.length > 0) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Missing required variables",
        code: "MISSING_VARIABLES",
        missing: missingVars,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Build and render
  const finalVars = buildFinalVariables(templateVars, variables);
  const subject = renderTemplate(template.subject, finalVars);
  const html = renderTemplate(template.html_content, finalVars);
  const text = renderTemplate(template.text_content || "", finalVars);

  // Send via email service
  const { getEmailService } = await import("../_shared/email/index.ts");
  const emailService = getEmailService();

  const result = await emailService.sendEmail(
    {
      to,
      from: from || "FoodShare <noreply@foodshare.club>",
      fromName: fromName,
      subject,
      html,
      text: text || undefined,
      replyTo,
    },
    emailType as "auth" | "chat" | "food_listing" | "feedback" | "review_reminder" | "newsletter" | "announcement" | "welcome" | "goodbye" | "notification"
  );

  logger.info("Email sent via template", {
    slug,
    to,
    success: result.success,
    provider: result.provider,
  });

  return new Response(
    JSON.stringify({
      success: result.success,
      messageId: result.messageId,
      provider: result.provider,
      error: result.error,
      templateVersion: template.version,
    }),
    {
      status: result.success ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

function handleHealthCheck(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      status: "healthy",
      version: VERSION,
      service: "api-v1-email-template",
      timestamp: new Date().toISOString(),
      cache: cache.getStats(),
    }),
    {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleMobileCorsPrelight(req);
  }

  const corsHeaders = getCorsHeadersWithMobile(req);
  const requestId = crypto.randomUUID();
  const startTime = performance.now();

  // Add request ID to headers
  const responseHeaders = {
    ...corsHeaders,
    "X-Request-Id": requestId,
  };

  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api-v1-email-template/, "");

    logger.info("Request received", {
      requestId,
      method: req.method,
      path,
    });

    // Route handling
    // GET /health
    if (req.method === "GET" && (path === "/health" || path === "")) {
      return handleHealthCheck(responseHeaders);
    }

    // GET /templates - List all templates
    if (req.method === "GET" && path === "/templates") {
      return await handleListTemplates(req, responseHeaders);
    }

    // GET /templates/:slug - Get single template
    if (req.method === "GET" && path.startsWith("/templates/")) {
      const slug = path.replace("/templates/", "");
      if (!slug) {
        return new Response(
          JSON.stringify({ success: false, error: "Template slug required" }),
          { status: 400, headers: { ...responseHeaders, "Content-Type": "application/json" } }
        );
      }
      return await handleGetTemplate(slug, responseHeaders);
    }

    // POST /render - Render template with variables
    if (req.method === "POST" && path === "/render") {
      return await handleRenderTemplate(req, responseHeaders);
    }

    // POST /send - Render and send email
    if (req.method === "POST" && path === "/send") {
      return await handleSendEmail(req, responseHeaders);
    }

    // 404 for unknown routes
    return new Response(
      JSON.stringify({
        success: false,
        error: "Not found",
        code: "NOT_FOUND",
        path,
      }),
      {
        status: 404,
        headers: { ...responseHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    const duration = performance.now() - startTime;
    logger.error("Request failed", error instanceof Error ? error : new Error(String(error)));

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
        code: "INTERNAL_ERROR",
        requestId,
      }),
      {
        status: 500,
        headers: {
          ...responseHeaders,
          "Content-Type": "application/json",
          "X-Response-Time": `${duration.toFixed(2)}ms`,
        },
      }
    );
  }
});
