/**
 * Analytics Ingest Edge Function
 *
 * Unified analytics event ingestion for Web, iOS, and Android.
 * Supports batch event ingestion, session tracking, and data export.
 *
 * Endpoints:
 *   POST /batch    - Ingest a batch of events
 *   POST /session  - Create/update a session
 *   GET  /summary  - Get analytics summary
 *   POST /export   - Export events to external provider
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-platform, x-app-version",
};

// =============================================================================
// Types
// =============================================================================

interface AnalyticsEvent {
  name: string;
  category: string;
  sessionId?: string;
  userId?: string;
  deviceId?: string;
  platform?: string;
  appVersion?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
}

interface BatchIngestRequest {
  events: AnalyticsEvent[];
  deviceId: string;
  platform: "ios" | "android" | "web";
  sessionId?: string;
  appVersion: string;
}

interface SessionRequest {
  sessionId: string;
  deviceId: string;
  userId?: string;
  platform: "ios" | "android" | "web";
  appVersion: string;
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string;
  sessionNumber?: number;
  entryScreen?: string;
  exitScreen?: string;
  eventCount?: number;
  screenViewCount?: number;
  properties?: Record<string, unknown>;
}

interface ExportRequest {
  startDate: string;
  endDate: string;
  platform?: string;
  category?: string;
  format?: "json" | "csv";
  provider?: "amplitude" | "mixpanel" | "segment" | "custom";
  webhookUrl?: string;
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
    const path = url.pathname.replace("/analytics-ingest", "");

    // Route handling
    if (req.method === "POST" && path === "/batch") {
      return await handleBatchIngest(req, supabase);
    }

    if (req.method === "POST" && path === "/session") {
      return await handleSessionUpsert(req, supabase);
    }

    if (req.method === "GET" && path === "/summary") {
      return await handleGetSummary(req, supabase);
    }

    if (req.method === "POST" && path === "/export") {
      return await handleExport(req, supabase);
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "analytics-ingest" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Analytics ingest error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =============================================================================
// Handlers
// =============================================================================

async function handleBatchIngest(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: BatchIngestRequest = await req.json();

  // Validate required fields
  if (!body.events || !Array.isArray(body.events)) {
    return new Response(
      JSON.stringify({ error: "Missing or invalid events array" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!body.deviceId || !body.platform || !body.appVersion) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: deviceId, platform, appVersion" }),
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

  // Normalize events
  const normalizedEvents = body.events.map((event) => ({
    name: event.name,
    category: event.category || "general",
    sessionId: event.sessionId || body.sessionId,
    userId: event.userId || null,
    deviceId: event.deviceId || body.deviceId,
    platform: event.platform || body.platform,
    appVersion: event.appVersion || body.appVersion,
    properties: normalizeProperties(event.properties || {}),
    timestamp: event.timestamp || new Date().toISOString(),
  }));

  // Call the RPC function to ingest batch
  const { data, error } = await supabase.rpc("ingest_analytics_batch", {
    p_events: normalizedEvents,
    p_device_id: body.deviceId,
    p_platform: body.platform,
  });

  if (error) {
    console.error("Batch ingest error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0] || { batch_id: null, events_processed: 0, success: false };

  return new Response(
    JSON.stringify({
      success: result.success,
      batchId: result.batch_id,
      eventsProcessed: result.events_processed,
      message: result.success
        ? `Successfully processed ${result.events_processed} events`
        : "Failed to process events",
    }),
    {
      status: result.success ? 201 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}

async function handleSessionUpsert(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: SessionRequest = await req.json();

  // Validate required fields
  if (!body.sessionId || !body.deviceId || !body.platform || !body.appVersion) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: sessionId, deviceId, platform, appVersion" }),
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

  // Call the RPC function to upsert session
  const { data, error } = await supabase.rpc("upsert_analytics_session", {
    p_session_id: body.sessionId,
    p_device_id: body.deviceId,
    p_user_id: body.userId || null,
    p_platform: body.platform,
    p_app_version: body.appVersion,
    p_started_at: body.startedAt || new Date().toISOString(),
    p_last_activity_at: body.lastActivityAt || new Date().toISOString(),
    p_ended_at: body.endedAt || null,
    p_session_number: body.sessionNumber || 1,
    p_entry_screen: body.entryScreen || null,
    p_exit_screen: body.exitScreen || null,
    p_event_count: body.eventCount || 0,
    p_screen_view_count: body.screenViewCount || 0,
    p_properties: body.properties || {},
  });

  if (error) {
    console.error("Session upsert error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      session: data,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleGetSummary(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const platform = url.searchParams.get("platform");

  if (!startDate || !endDate) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters: startDate, endDate" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Call the RPC function to get summary
  const { data, error } = await supabase.rpc("get_analytics_summary", {
    p_start_date: startDate,
    p_end_date: endDate,
    p_platform: platform || null,
  });

  if (error) {
    console.error("Get summary error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Calculate totals
  const totals = {
    totalEvents: 0,
    uniqueUsers: 0,
    uniqueSessions: 0,
  };

  if (data && Array.isArray(data)) {
    totals.totalEvents = data.reduce((sum, row) => sum + (row.event_count || 0), 0);
    totals.uniqueUsers = Math.max(...data.map((row) => row.unique_users || 0), 0);
    totals.uniqueSessions = Math.max(...data.map((row) => row.unique_sessions || 0), 0);
  }

  return new Response(
    JSON.stringify({
      period: { startDate, endDate },
      platform: platform || "all",
      totals,
      byCategory: data || [],
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleExport(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: ExportRequest = await req.json();

  if (!body.startDate || !body.endDate) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: startDate, endDate" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Build query
  let query = supabase
    .from("analytics_events")
    .select("*")
    .gte("event_timestamp", body.startDate)
    .lte("event_timestamp", body.endDate)
    .order("event_timestamp", { ascending: true })
    .limit(10000);

  if (body.platform) {
    query = query.eq("platform", body.platform);
  }

  if (body.category) {
    query = query.eq("category", body.category);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Export error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Format data based on provider
  const formattedData = formatForProvider(data || [], body.provider || "json");

  // If webhook URL provided, send data there
  if (body.webhookUrl) {
    try {
      await fetch(body.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formattedData),
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: `Exported ${data?.length || 0} events to webhook`,
          eventCount: data?.length || 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (webhookError) {
      console.error("Webhook error:", webhookError);
      return new Response(
        JSON.stringify({ error: "Failed to send to webhook", details: webhookError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  // Return data directly based on format
  if (body.format === "csv") {
    const csv = convertToCSV(data || []);
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="analytics_${body.startDate}_${body.endDate}.csv"`,
      },
    });
  }

  return new Response(
    JSON.stringify({
      eventCount: data?.length || 0,
      events: formattedData,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =============================================================================
// Utility Functions
// =============================================================================

function normalizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    // Convert camelCase to snake_case for consistency
    const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();

    // Stringify complex objects
    if (typeof value === "object" && value !== null) {
      normalized[snakeKey] = JSON.stringify(value);
    } else {
      normalized[snakeKey] = value;
    }
  }

  return normalized;
}

function formatForProvider(
  events: Array<Record<string, unknown>>,
  provider: string
): Array<Record<string, unknown>> {
  switch (provider) {
    case "amplitude":
      return events.map((event) => ({
        user_id: event.user_id,
        device_id: event.device_id,
        event_type: event.event_name,
        time: new Date(event.event_timestamp as string).getTime(),
        event_properties: event.properties,
        platform: event.platform,
        app_version: event.app_version,
        session_id: event.session_id,
      }));

    case "mixpanel":
      return events.map((event) => ({
        event: event.event_name,
        properties: {
          distinct_id: event.user_id || event.device_id,
          time: new Date(event.event_timestamp as string).getTime() / 1000,
          $device_id: event.device_id,
          $os: event.platform,
          $app_version: event.app_version,
          ...(event.properties as Record<string, unknown>),
        },
      }));

    case "segment":
      return events.map((event) => ({
        type: "track",
        event: event.event_name,
        userId: event.user_id,
        anonymousId: event.device_id,
        timestamp: event.event_timestamp,
        properties: event.properties,
        context: {
          app: { version: event.app_version },
          os: { name: event.platform },
        },
      }));

    default:
      return events;
  }
}

function convertToCSV(events: Array<Record<string, unknown>>): string {
  if (events.length === 0) return "";

  const headers = [
    "id",
    "event_name",
    "category",
    "session_id",
    "user_id",
    "device_id",
    "platform",
    "app_version",
    "event_timestamp",
    "properties",
  ];

  const rows = events.map((event) =>
    headers
      .map((header) => {
        const value = event[header];
        if (value === null || value === undefined) return "";
        if (typeof value === "object") return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
        return `"${String(value).replace(/"/g, '""')}"`;
      })
      .join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}
