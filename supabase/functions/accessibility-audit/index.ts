/**
 * Accessibility Audit Edge Function
 *
 * Unified accessibility auditing for Web, iOS, and Android.
 * Stores audit results, tracks regressions, and provides compliance reports.
 *
 * Endpoints:
 *   POST /submit   - Submit an accessibility audit result
 *   GET  /summary  - Get accessibility summary for a screen
 *   GET  /alerts   - Get unacknowledged regression alerts
 *   POST /acknowledge - Acknowledge a regression alert
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-platform",
};

// =============================================================================
// Types
// =============================================================================

interface AccessibilityIssue {
  elementId: string;
  rule: string;
  severity: "critical" | "major" | "minor";
  wcagCriteria: string;
  message: string;
  suggestion: string;
  affectedProperty?: string;
}

interface SubmitAuditRequest {
  screenName: string;
  platform: "ios" | "android" | "web";
  appVersion: string;
  wcagLevel?: "A" | "AA" | "AAA";
  passed: boolean;
  score: number;
  auditedElementCount: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  issues: AccessibilityIssue[];
  deviceInfo?: Record<string, unknown>;
  buildNumber?: string;
  commitHash?: string;
}

interface AuditSummary {
  screenName: string;
  platform: string;
  wcagLevel: string;
  totalAudits: number;
  passRate: number;
  avgScore: number;
  lastScore: number;
  trend: "improving" | "stable" | "declining";
  criticalIssues: number;
}

interface RegressionAlert {
  id: string;
  screenName: string;
  platform: string;
  previousScore: number;
  currentScore: number;
  scoreDelta: number;
  previousCriticalCount: number;
  currentCriticalCount: number;
  acknowledged: boolean;
  createdAt: string;
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.replace("/accessibility-audit", "");

    // Route handling
    if (req.method === "POST" && path === "/submit") {
      return await handleSubmitAudit(req, supabase);
    }

    if (req.method === "GET" && path === "/summary") {
      return await handleGetSummary(req, supabase);
    }

    if (req.method === "GET" && path === "/alerts") {
      return await handleGetAlerts(req, supabase);
    }

    if (req.method === "POST" && path === "/acknowledge") {
      return await handleAcknowledgeAlert(req, supabase);
    }

    if (req.method === "GET" && path === "/report") {
      return await handleGetReport(req, supabase);
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "accessibility-audit" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Accessibility audit error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =============================================================================
// Handlers
// =============================================================================

async function handleSubmitAudit(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: SubmitAuditRequest = await req.json();

  // Validate required fields
  if (!body.screenName || !body.platform || !body.appVersion) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: screenName, platform, appVersion" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Validate platform
  if (!["ios", "android", "web"].includes(body.platform)) {
    return new Response(
      JSON.stringify({ error: "Invalid platform. Must be ios, android, or web" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Call the RPC function to submit audit
  const { data, error } = await supabase.rpc("submit_accessibility_audit", {
    p_screen_name: body.screenName,
    p_platform: body.platform,
    p_app_version: body.appVersion,
    p_wcag_level: body.wcagLevel ?? "AA",
    p_passed: body.passed,
    p_score: body.score,
    p_audited_element_count: body.auditedElementCount,
    p_critical_count: body.criticalCount,
    p_major_count: body.majorCount,
    p_minor_count: body.minorCount,
    p_issues: body.issues,
    p_device_info: body.deviceInfo ?? {},
    p_build_number: body.buildNumber ?? null,
    p_commit_hash: body.commitHash ?? null,
  });

  if (error) {
    console.error("Submit audit error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      auditId: data,
      message: body.passed
        ? `Audit passed with score ${body.score}`
        : `Audit found ${body.criticalCount} critical, ${body.majorCount} major, ${body.minorCount} minor issues`,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetSummary(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const screenName = url.searchParams.get("screenName");
  const platform = url.searchParams.get("platform");
  const days = parseInt(url.searchParams.get("days") ?? "30");

  if (!screenName) {
    return new Response(
      JSON.stringify({ error: "Missing required parameter: screenName" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("get_accessibility_summary", {
    p_screen_name: screenName,
    p_platform: platform,
    p_days: days,
  });

  if (error) {
    console.error("Get summary error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      screenName,
      platform: platform ?? "all",
      days,
      summaries: data as AuditSummary[],
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetAlerts(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const limit = parseInt(url.searchParams.get("limit") ?? "50");
  const includeAcknowledged = url.searchParams.get("includeAcknowledged") === "true";

  let query = supabase
    .from("accessibility_regression_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (platform) {
    query = query.eq("platform", platform);
  }

  if (!includeAcknowledged) {
    query = query.eq("acknowledged", false);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Get alerts error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      alerts: data as RegressionAlert[],
      count: data?.length ?? 0,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleAcknowledgeAlert(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body = await req.json();
  const { alertId } = body;

  if (!alertId) {
    return new Response(
      JSON.stringify({ error: "Missing required field: alertId" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get the authenticated user
  const authHeader = req.headers.get("Authorization");
  let userId = null;

  if (authHeader) {
    const { data: { user } } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    userId = user?.id;
  }

  const { error } = await supabase
    .from("accessibility_regression_alerts")
    .update({
      acknowledged: true,
      acknowledged_by: userId,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", alertId);

  if (error) {
    console.error("Acknowledge alert error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, alertId }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetReport(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const days = parseInt(url.searchParams.get("days") ?? "30");

  // Get overall summary
  const { data: summaryData, error: summaryError } = await supabase
    .from("accessibility_audit_summary")
    .select("*");

  if (summaryError) {
    console.error("Get report error:", summaryError);
    return new Response(
      JSON.stringify({ error: summaryError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get recent issues
  let issuesQuery = supabase
    .from("accessibility_issues")
    .select("screen_name, platform, wcag_level, critical_count, major_count, minor_count, passed, score, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (platform) {
    issuesQuery = issuesQuery.eq("platform", platform);
  }

  const { data: issuesData, error: issuesError } = await issuesQuery;

  if (issuesError) {
    console.error("Get issues error:", issuesError);
  }

  // Calculate statistics
  const totalAudits = issuesData?.length ?? 0;
  const passedAudits = issuesData?.filter(i => i.passed).length ?? 0;
  const totalCritical = issuesData?.reduce((sum, i) => sum + i.critical_count, 0) ?? 0;
  const totalMajor = issuesData?.reduce((sum, i) => sum + i.major_count, 0) ?? 0;
  const totalMinor = issuesData?.reduce((sum, i) => sum + i.minor_count, 0) ?? 0;
  const avgScore = totalAudits > 0
    ? (issuesData?.reduce((sum, i) => sum + i.score, 0) ?? 0) / totalAudits
    : 0;

  // Get unacknowledged alerts count
  const { count: alertCount } = await supabase
    .from("accessibility_regression_alerts")
    .select("*", { count: "exact", head: true })
    .eq("acknowledged", false);

  return new Response(
    JSON.stringify({
      report: {
        generatedAt: new Date().toISOString(),
        platform: platform ?? "all",
        periodDays: days,
        statistics: {
          totalAudits,
          passedAudits,
          passRate: totalAudits > 0 ? ((passedAudits / totalAudits) * 100).toFixed(2) : 0,
          averageScore: avgScore.toFixed(2),
          totalCriticalIssues: totalCritical,
          totalMajorIssues: totalMajor,
          totalMinorIssues: totalMinor,
          unacknowledgedAlerts: alertCount ?? 0,
        },
        screenSummaries: summaryData,
        wcagCompliance: {
          A: calculateComplianceRate(issuesData, "A"),
          AA: calculateComplianceRate(issuesData, "AA"),
          AAA: calculateComplianceRate(issuesData, "AAA"),
        },
      },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

function calculateComplianceRate(
  issues: Array<{ wcag_level: string; passed: boolean }> | null,
  level: string
): number {
  if (!issues) return 0;
  const levelIssues = issues.filter(i => i.wcag_level === level);
  if (levelIssues.length === 0) return 0;
  const passed = levelIssues.filter(i => i.passed).length;
  return parseFloat(((passed / levelIssues.length) * 100).toFixed(2));
}
