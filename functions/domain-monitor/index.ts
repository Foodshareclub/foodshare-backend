/**
 * Domain Security Monitor Edge Function
 *
 * Monitors FoodShare domains for security issues using:
 * - Google Safe Browsing API
 * - VirusTotal API
 * - SSL/connectivity checks
 * - SafeBrowse hijack detection
 * - Multi-region HTTP checks
 *
 * Sends Telegram alerts when issues are detected.
 *
 * Usage:
 * GET /domain-monitor
 * GET /domain-monitor?notify=true  // Force notification even if healthy
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../_shared/api-handler.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  version: "2.0.0",
  functionDisabled: true, // Set to false to re-enable
  domainsToMonitor: [
    "https://foodshare.club",
    "https://www.foodshare.club",
    "https://foodshare-dev.vercel.app",
  ],
  safeBrowsePatterns: ["safebrowse.io", "safebrowse.net", "warn.html"],
  checkHostNodes: {
    california: "us1.node.check-host.net",
    germany: "de4.node.check-host.net",
  },
};

// =============================================================================
// Request Schema
// =============================================================================

const monitorQuerySchema = z.object({
  notify: z.enum(["true", "false"]).optional(),
});

type MonitorQuery = z.infer<typeof monitorQuerySchema>;

// =============================================================================
// Types
// =============================================================================

interface MonitorResult {
  timestamp: string;
  dnsResolution: DNSResolutionResult[];
  googleSafeBrowsing: GoogleSafeBrowsingResult | null;
  virusTotal: VirusTotalResult[];
  sslChecks: SSLCheckResult[];
  safeBrowseHijackChecks: SafeBrowseCheckResult[];
  multiRegionChecks: MultiRegionCheckResult[];
  alerts: string[];
  status: "healthy" | "warning" | "critical";
}

interface GoogleSafeBrowsingResult {
  matches?: Array<{
    threatType: string;
    platformType: string;
    threat: { url: string };
  }>;
  error?: string;
}

interface VirusTotalResult {
  url: string;
  status: "clean" | "flagged" | "not_found" | "error";
  malicious?: number;
  suspicious?: number;
  error?: string;
}

interface SSLCheckResult {
  url: string;
  status: "valid" | "error";
  region?: string;
  error?: string;
}

interface MultiRegionCheckResult {
  url: string;
  regions: {
    name: string;
    location: string;
    status: "ok" | "error" | "timeout" | "pending";
    responseTime?: number;
    error?: string;
  }[];
}

interface SafeBrowseCheckResult {
  url: string;
  status: "clean" | "hijacked" | "error";
  redirectUrl?: string;
  error?: string;
}

interface DNSResolutionResult {
  domain: string;
  ips: string[];
  error?: string;
}

// =============================================================================
// API Check Functions
// =============================================================================

async function sendTelegramAlert(message: string): Promise<boolean> {
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") || Deno.env.get("BOT_TOKEN");
  const chatId = Deno.env.get("ADMIN_CHAT_ID") || "42281047";

  if (!botToken) {
    logger.error("TELEGRAM_BOT_TOKEN not configured");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });

    const result = await response.json();
    if (!result.ok) {
      logger.error("Telegram API error", { error: result.description });
    }
    return result.ok;
  } catch (error) {
    logger.error("Telegram send error", { error });
    return false;
  }
}

async function checkGoogleSafeBrowsing(urls: string[]): Promise<GoogleSafeBrowsingResult> {
  const apiKey = Deno.env.get("GOOGLE_SAFE_BROWSING_API_KEY");
  if (!apiKey) return { error: "GOOGLE_SAFE_BROWSING_API_KEY not configured" };

  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "foodshare-domain-monitor", clientVersion: "1.0.0" },
          threatInfo: {
            threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: urls.map((url) => ({ url })),
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return { error: `API error ${response.status}: ${errorText}` };
    }

    return await response.json();
  } catch (error) {
    return { error: `Request failed: ${error instanceof Error ? error.message : "Unknown"}` };
  }
}

async function checkVirusTotal(url: string): Promise<VirusTotalResult> {
  const apiKey = Deno.env.get("VIRUSTOTAL_API_KEY");
  if (!apiKey) return { url, status: "error", error: "VIRUSTOTAL_API_KEY not configured" };

  try {
    const urlId = btoa(url).replace(/=/g, "");

    const response = await fetch(`https://www.virustotal.com/api/v3/urls/${urlId}`, {
      headers: { "x-apikey": apiKey },
    });

    if (response.status === 404) {
      // Submit for scanning
      const formData = new FormData();
      formData.append("url", url);
      await fetch("https://www.virustotal.com/api/v3/urls", {
        method: "POST",
        headers: { "x-apikey": apiKey },
        body: formData,
      });
      return { url, status: "not_found" };
    }

    if (!response.ok) {
      return { url, status: "error", error: `API error ${response.status}` };
    }

    const data = await response.json();
    const stats = data?.data?.attributes?.last_analysis_stats;

    if (!stats) {
      return { url, status: "error", error: "No analysis stats in response" };
    }

    const isFlagged = stats.malicious > 0 || stats.suspicious > 0;
    return {
      url,
      status: isFlagged ? "flagged" : "clean",
      malicious: stats.malicious,
      suspicious: stats.suspicious,
    };
  } catch (error) {
    return { url, status: "error", error: error instanceof Error ? error.message : "Unknown" };
  }
}

async function checkSSL(url: string): Promise<SSLCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.ok || response.status === 301 || response.status === 302) {
      return { url, status: "valid", region: "Supabase Edge (AWS)" };
    }

    return { url, status: "error", region: "Supabase Edge (AWS)", error: `HTTP ${response.status}` };
  } catch (error) {
    return { url, status: "error", region: "Supabase Edge (AWS)", error: error instanceof Error ? error.message : "Unknown" };
  }
}

async function resolveDNS(domain: string): Promise<DNSResolutionResult> {
  try {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, {
      headers: { Accept: "application/dns-json" },
    });

    if (!response.ok) {
      return { domain, ips: [], error: `DNS lookup failed: ${response.status}` };
    }

    const data = await response.json();
    const ips = (data.Answer || [])
      .filter((record: { type: number }) => record.type === 1)
      .map((record: { data: string }) => record.data);

    return { domain, ips };
  } catch (error) {
    return { domain, ips: [], error: error instanceof Error ? error.message : "Unknown" };
  }
}

async function checkSafeBrowseHijack(url: string): Promise<SafeBrowseCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "FoodShare-Domain-Monitor/1.0" },
    });

    clearTimeout(timeoutId);

    const locationHeader = response.headers.get("location") || "";
    const locationLower = locationHeader.toLowerCase();

    for (const pattern of CONFIG.safeBrowsePatterns) {
      if (locationLower.includes(pattern)) {
        return { url, status: "hijacked", redirectUrl: locationHeader };
      }
    }

    if (response.status === 200) {
      const text = await response.text();
      const textLower = text.toLowerCase();

      for (const pattern of CONFIG.safeBrowsePatterns) {
        if (textLower.includes(pattern)) {
          return { url, status: "hijacked", redirectUrl: "SafeBrowse reference found in page content" };
        }
      }
    }

    return { url, status: "clean" };
  } catch (error) {
    const errorMsg = (error instanceof Error ? error.message : "").toLowerCase();

    if (["ssl", "tls", "certificate", "protocol", "handshake"].some((s) => errorMsg.includes(s))) {
      return { url, status: "hijacked", error: `SSL/TLS failure (possible hijack): ${error instanceof Error ? error.message : ""}` };
    }

    return { url, status: "error", error: error instanceof Error ? error.message : "Unknown" };
  }
}

async function checkMultiRegion(url: string): Promise<MultiRegionCheckResult> {
  const result: MultiRegionCheckResult = { url, regions: [] };

  try {
    const nodeList = [CONFIG.checkHostNodes.california, CONFIG.checkHostNodes.germany];
    const nodeParams = nodeList.map((n) => `node=${n}`).join("&");
    const checkUrl = `https://check-host.net/check-http?host=${encodeURIComponent(url)}&${nodeParams}`;

    const initResponse = await fetch(checkUrl, { headers: { Accept: "application/json" } });

    if (!initResponse.ok) {
      result.regions.push(
        { name: "california", location: "San Francisco, CA, USA", status: "error", error: "check-host.net API unavailable" },
        { name: "germany", location: "Frankfurt, Germany", status: "error", error: "check-host.net API unavailable" }
      );
      return result;
    }

    const initData = await initResponse.json();
    const requestId = initData.request_id;
    const nodeResults = initData.nodes || {};

    if (!requestId) throw new Error("No request_id in response");

    await new Promise((r) => setTimeout(r, 5000));

    const resultResponse = await fetch(`https://check-host.net/check-result/${requestId}`, {
      headers: { Accept: "application/json" },
    });

    if (!resultResponse.ok) throw new Error(`Failed to get results: ${resultResponse.status}`);

    const resultData = await resultResponse.json();

    for (const [nodeId, nodeInfo] of Object.entries(nodeResults)) {
      const nodeResult = resultData[nodeId];
      const info = nodeInfo as [string, string, string, string, string];
      const location = `${info[2]}, ${info[1]}`;

      let regionName = "other";
      if (nodeId === CONFIG.checkHostNodes.california) regionName = "california";
      else if (nodeId === CONFIG.checkHostNodes.germany) regionName = "germany";

      if (nodeResult === null) {
        result.regions.push({ name: regionName, location, status: "pending" });
      } else if (Array.isArray(nodeResult) && nodeResult[0]) {
        const checkResult = nodeResult[0];
        if (checkResult[0] === 1) {
          result.regions.push({ name: regionName, location, status: "ok", responseTime: checkResult[1] });
        } else {
          result.regions.push({ name: regionName, location, status: "error", error: checkResult[2] || "Connection failed" });
        }
      } else {
        result.regions.push({ name: regionName, location, status: "timeout" });
      }
    }
  } catch (error) {
    logger.error("Multi-region check error", { error });
    result.regions.push(
      { name: "california", location: "San Francisco, CA, USA", status: "error", error: error instanceof Error ? error.message : "Unknown" },
      { name: "germany", location: "Frankfurt, Germany", status: "error", error: error instanceof Error ? error.message : "Unknown" }
    );
  }

  return result;
}

// =============================================================================
// Main Monitor Function
// =============================================================================

async function monitorDomains(): Promise<MonitorResult> {
  const result: MonitorResult = {
    timestamp: new Date().toISOString(),
    dnsResolution: [],
    googleSafeBrowsing: null,
    virusTotal: [],
    sslChecks: [],
    safeBrowseHijackChecks: [],
    multiRegionChecks: [],
    alerts: [],
    status: "healthy",
  };

  // DNS Resolution
  logger.info("Resolving DNS...");
  for (const domain of ["foodshare.club", "www.foodshare.club"]) {
    result.dnsResolution.push(await resolveDNS(domain));
  }

  // Google Safe Browsing
  logger.info("Checking Google Safe Browsing...");
  result.googleSafeBrowsing = await checkGoogleSafeBrowsing(CONFIG.domainsToMonitor);

  if (result.googleSafeBrowsing.error) {
    logger.warn("Google Safe Browsing error", { error: result.googleSafeBrowsing.error });
  } else if (result.googleSafeBrowsing.matches?.length) {
    result.status = "critical";
    const flaggedUrls = result.googleSafeBrowsing.matches.map((m) => `${m.threat.url} (${m.threatType})`).join("\n");
    result.alerts.push(`Google Safe Browsing flagged:\n${flaggedUrls}`);
  }

  // VirusTotal
  logger.info("Checking VirusTotal...");
  for (const url of CONFIG.domainsToMonitor) {
    const vtResult = await checkVirusTotal(url);
    result.virusTotal.push(vtResult);

    if (vtResult.status === "flagged") {
      result.status = result.status === "critical" ? "critical" : "warning";
      result.alerts.push(`VirusTotal flagged ${url}: ${vtResult.malicious} malicious, ${vtResult.suspicious} suspicious`);
    }

    if (CONFIG.domainsToMonitor.indexOf(url) < CONFIG.domainsToMonitor.length - 1) {
      await new Promise((r) => setTimeout(r, 15000));
    }
  }

  // SSL Checks
  logger.info("Checking SSL/connectivity...");
  result.sslChecks = await Promise.all(CONFIG.domainsToMonitor.map((url) => checkSSL(url)));

  for (const sslResult of result.sslChecks) {
    if (sslResult.status === "error") {
      result.status = result.status === "healthy" ? "warning" : result.status;
      result.alerts.push(`SSL/connectivity issue for ${sslResult.url}: ${sslResult.error}`);
    }
  }

  // SafeBrowse Hijack Detection
  logger.info("Checking for SafeBrowse hijacking...");
  const customDomains = CONFIG.domainsToMonitor.filter((d) => !d.includes("vercel.app"));
  for (const url of customDomains) {
    const hijackResult = await checkSafeBrowseHijack(url);
    result.safeBrowseHijackChecks.push(hijackResult);

    if (hijackResult.status === "hijacked") {
      result.status = "critical";
      result.alerts.push(`🚨 SafeBrowse HIJACK detected for ${url}!\nRedirect: ${hijackResult.redirectUrl || hijackResult.error}`);
    }
  }

  // Multi-Region Checks
  logger.info("Checking from multiple regions...");
  for (const url of customDomains) {
    const multiResult = await checkMultiRegion(url);
    result.multiRegionChecks.push(multiResult);

    for (const region of multiResult.regions) {
      if (region.status === "error" || region.status === "timeout") {
        result.status = result.status === "healthy" ? "warning" : result.status;
        result.alerts.push(`Regional issue for ${url} from ${region.location}: ${region.error || region.status}`);
      }
    }
  }

  // Send alerts
  if (result.alerts.length > 0) {
    const statusEmoji = result.status === "critical" ? "🚨" : result.status === "warning" ? "⚠️" : "✅";
    const message = `${statusEmoji} <b>FoodShare Domain Monitor</b>\n\nStatus: <b>${result.status.toUpperCase()}</b>\nTime: ${result.timestamp}\n\n<b>Alerts:</b>\n${result.alerts.map((a) => `• ${a}`).join("\n")}\n\n<i>Check: https://transparencyreport.google.com/safe-browsing/search?url=foodshare.club</i>`;
    await sendTelegramAlert(message);
  }

  return result;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleDomainMonitor(
  ctx: HandlerContext<undefined, MonitorQuery>
): Promise<Response> {
  const { query, ctx: requestCtx } = ctx;

  // Check if function is disabled
  if (CONFIG.functionDisabled) {
    return ok({
      status: "disabled",
      message: "Domain monitor is currently disabled. Set FUNCTION_DISABLED = false to re-enable.",
      timestamp: new Date().toISOString(),
    }, ctx);
  }

  logger.info("Starting domain monitoring", {
    requestId: requestCtx?.requestId,
  });

  const result = await monitorDomains();

  // Send summary notification if requested
  const forceNotify = query?.notify === "true";
  if (forceNotify && result.alerts.length === 0) {
    let regionSummary = "";
    for (const check of result.multiRegionChecks) {
      const domain = check.url.replace("https://", "");
      for (const region of check.regions) {
        const ms = region.responseTime ? Math.round(region.responseTime * 1000) : "N/A";
        const status = region.status === "ok" ? "✓" : "✗";
        regionSummary += `${status} ${domain} → ${region.name}: ${ms}ms\n`;
      }
    }

    let hijackSummary = "";
    for (const check of result.safeBrowseHijackChecks) {
      const domain = check.url.replace("https://", "");
      const status = check.status === "clean" ? "✓" : "✗ HIJACKED";
      hijackSummary += `${status} ${domain}\n`;
    }

    let dnsSummary = "";
    for (const dns of result.dnsResolution) {
      dnsSummary += `${dns.domain}: ${dns.ips.join(", ") || dns.error || "N/A"}\n`;
    }

    await sendTelegramAlert(
      `✅ <b>FoodShare Domain Monitor</b>\n\n<b>Status:</b> All domains healthy\n<b>Time:</b> ${result.timestamp}\n\n<b>DNS Resolution:</b>\n<code>${dnsSummary}</code>\n<b>SafeBrowse Hijack Check:</b>\n<code>${hijackSummary}</code>\n<b>Multi-Region Checks:</b>\n<code>${regionSummary}</code>\n<b>SSL:</b> ${result.sslChecks.filter((s) => s.status === "valid").length}/${result.sslChecks.length} valid\n<b>Safe Browsing:</b> ${result.googleSafeBrowsing?.matches ? "⚠️ Flagged" : "Clean"}`
    );
  }

  return ok(result, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "domain-monitor",
  version: CONFIG.version,
  requireAuth: false, // Cron job - service-level
  routes: {
    GET: {
      querySchema: monitorQuerySchema,
      handler: handleDomainMonitor,
    },
    POST: {
      handler: handleDomainMonitor,
    },
  },
});
