/**
 * Link Service Edge Function
 *
 * URL shortening and deep link resolution for Web, iOS, and Android.
 * Supports link creation, resolution, analytics, and OG meta generation.
 *
 * Endpoints:
 *   POST /create    - Create a short link
 *   GET  /resolve   - Resolve a short code to target URL
 *   GET  /analytics - Get analytics for a link
 *   GET  /my-links  - Get user's short links
 *   GET  /og/:code  - Get OG meta tags for social sharing
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-id, x-platform",
};

// =============================================================================
// Types
// =============================================================================

interface CreateLinkRequest {
  targetUrl: string;
  routeType: string;
  entityId?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  customCode?: string;
  expiresAt?: string;
  maxClicks?: number;
}

interface ResolveParams {
  code: string;
  platform?: string;
  deviceId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

// =============================================================================
// Main Handler
// =============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const url = new URL(req.url);
    const path = url.pathname.replace("/link-service", "");

    // Route handling
    if (req.method === "POST" && path === "/create") {
      return await handleCreate(req, supabase);
    }

    if (req.method === "GET" && path === "/resolve") {
      return await handleResolve(req, supabase);
    }

    if (req.method === "GET" && path === "/analytics") {
      return await handleAnalytics(req, supabase);
    }

    if (req.method === "GET" && path === "/my-links") {
      return await handleMyLinks(req, supabase);
    }

    if (req.method === "GET" && path.startsWith("/og/")) {
      const code = path.replace("/og/", "");
      return await handleOGMeta(code, supabase);
    }

    // Redirect endpoint for short URLs
    if (req.method === "GET" && path.startsWith("/l/")) {
      const code = path.replace("/l/", "");
      return await handleRedirect(req, code, supabase);
    }

    if (req.method === "GET" && path === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "link-service" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Link service error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =============================================================================
// Handlers
// =============================================================================

async function handleCreate(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const body: CreateLinkRequest = await req.json();
  const platform = req.headers.get("x-platform") || "web";

  if (!body.targetUrl || !body.routeType) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: targetUrl, routeType" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("create_short_link", {
    p_target_url: body.targetUrl,
    p_route_type: body.routeType,
    p_entity_id: body.entityId || null,
    p_title: body.title || null,
    p_description: body.description || null,
    p_image_url: body.imageUrl || null,
    p_custom_code: body.customCode || null,
    p_expires_at: body.expiresAt || null,
    p_max_clicks: body.maxClicks || null,
    p_platform: platform,
  });

  if (error) {
    console.error("Create link error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0];

  return new Response(
    JSON.stringify({
      success: true,
      linkId: result?.link_id,
      code: result?.code,
      shortUrl: result?.short_url,
    }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleResolve(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response(
      JSON.stringify({ error: "Missing required parameter: code" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const params: ResolveParams = {
    code,
    platform: url.searchParams.get("platform") || req.headers.get("x-platform") || "web",
    deviceId: url.searchParams.get("deviceId") || req.headers.get("x-device-id") || undefined,
    utmSource: url.searchParams.get("utm_source") || undefined,
    utmMedium: url.searchParams.get("utm_medium") || undefined,
    utmCampaign: url.searchParams.get("utm_campaign") || undefined,
  };

  const ipHash = await hashIP(req.headers.get("x-forwarded-for") || "");

  const { data, error } = await supabase.rpc("resolve_short_link", {
    p_code: params.code,
    p_platform: params.platform,
    p_device_id: params.deviceId || null,
    p_user_agent: req.headers.get("user-agent") || null,
    p_referrer: req.headers.get("referer") || null,
    p_ip_hash: ipHash,
    p_utm_source: params.utmSource || null,
    p_utm_medium: params.utmMedium || null,
    p_utm_campaign: params.utmCampaign || null,
  });

  if (error) {
    console.error("Resolve link error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!data || data.length === 0) {
    return new Response(
      JSON.stringify({ error: "Link not found or expired" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const link = data[0];

  return new Response(
    JSON.stringify({
      targetUrl: link.target_url,
      routeType: link.route_type,
      entityId: link.entity_id,
      title: link.title,
      description: link.description,
      imageUrl: link.image_url,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleRedirect(
  req: Request,
  code: string,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const ipHash = await hashIP(req.headers.get("x-forwarded-for") || "");

  const { data, error } = await supabase.rpc("resolve_short_link", {
    p_code: code,
    p_platform: detectPlatform(req.headers.get("user-agent") || ""),
    p_device_id: null,
    p_user_agent: req.headers.get("user-agent") || null,
    p_referrer: req.headers.get("referer") || null,
    p_ip_hash: ipHash,
    p_utm_source: url.searchParams.get("utm_source") || null,
    p_utm_medium: url.searchParams.get("utm_medium") || null,
    p_utm_campaign: url.searchParams.get("utm_campaign") || null,
  });

  if (error || !data || data.length === 0) {
    return new Response(
      JSON.stringify({ error: "Link not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const link = data[0];

  // Redirect to target URL
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders,
      Location: link.target_url,
    },
  });
}

async function handleAnalytics(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const linkId = url.searchParams.get("linkId");
  const days = parseInt(url.searchParams.get("days") ?? "30");

  if (!linkId) {
    return new Response(
      JSON.stringify({ error: "Missing required parameter: linkId" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("get_link_analytics", {
    p_link_id: linkId,
    p_days: days,
  });

  if (error) {
    console.error("Analytics error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const result = data?.[0] || {};

  return new Response(
    JSON.stringify({
      linkId,
      period: { days },
      totalClicks: result.total_clicks || 0,
      uniqueClicks: result.unique_clicks || 0,
      clicksByPlatform: result.clicks_by_platform || {},
      clicksByDay: result.clicks_by_day || [],
      topReferrers: result.top_referrers || [],
      topUtmSources: result.top_utm_sources || [],
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleMyLinks(
  req: Request,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50");
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  // Get auth token
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Authorization required" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Set auth for the request
  const { data: { user } } = await supabase.auth.getUser(
    authHeader.replace("Bearer ", "")
  );

  if (!user) {
    return new Response(
      JSON.stringify({ error: "Invalid token" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data, error } = await supabase.rpc("get_my_short_links", {
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    console.error("Get links error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      links: data || [],
      pagination: { limit, offset, count: data?.length || 0 },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handleOGMeta(
  code: string,
  supabase: ReturnType<typeof createClient>
): Promise<Response> {
  // Get link without tracking
  const { data, error } = await supabase
    .from("short_links")
    .select("title, description, image_url, target_url, route_type, entity_id")
    .eq("code", code)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    return new Response(
      JSON.stringify({ error: "Link not found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Generate OG HTML for crawlers
  const ogTitle = data.title || "Foodshare";
  const ogDescription = data.description || "Share food, reduce waste, build community";
  const ogImage = data.image_url || "https://foodshare.app/og-image.png";
  const ogUrl = `https://foodshare.app/l/${code}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:url" content="${escapeHtml(ogUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Foodshare">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}">
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <meta http-equiv="refresh" content="0;url=${escapeHtml(data.target_url)}">
</head>
<body>
  <p>Redirecting to <a href="${escapeHtml(data.target_url)}">${escapeHtml(ogTitle)}</a>...</p>
</body>
</html>
`;

  return new Response(html, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

// =============================================================================
// Utilities
// =============================================================================

async function hashIP(ip: string): Promise<string> {
  if (!ip) return "";

  const encoder = new TextEncoder();
  const data = encoder.encode(ip + Deno.env.get("IP_SALT") || "foodshare");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

function detectPlatform(userAgent: string): string {
  const ua = userAgent.toLowerCase();

  if (ua.includes("foodshare") && ua.includes("ios")) return "ios";
  if (ua.includes("foodshare") && ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  if (ua.includes("android")) return "android";

  return "web";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
