/**
 * Domain Security Monitor
 *
 * Monitors FoodShare domains for security issues using:
 * - Google Safe Browsing API
 * - VirusTotal API
 *
 * Sends Telegram alerts when issues are detected.
 *
 * Trigger: Cron job (every 6 hours) or manual invocation
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";

// ============================================
// FUNCTION DISABLED - Set to false to re-enable
// ============================================
const FUNCTION_DISABLED = true;

// Configuration
const DOMAINS_TO_MONITOR = [
  "https://foodshare.club",
  "https://www.foodshare.club",
  "https://foodshare-dev.vercel.app",
];

const GOOGLE_SAFE_BROWSING_API_KEY = Deno.env.get("GOOGLE_SAFE_BROWSING_API_KEY");
const VIRUSTOTAL_API_KEY = Deno.env.get("VIRUSTOTAL_API_KEY");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || Deno.env.get("BOT_TOKEN");
const ADMIN_CHAT_ID = Deno.env.get("ADMIN_CHAT_ID") || "42281047";

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

// Check-host.net node IDs for specific regions
const CHECK_HOST_NODES = {
  california: "us1.node.check-host.net", // Los Angeles, CA
  germany: "de4.node.check-host.net", // Frankfurt, Germany
};

// Known problematic patterns
const SAFEBROWSE_PATTERNS = ["safebrowse.io", "safebrowse.net", "warn.html"];

/**
 * Send Telegram notification
 */
async function sendTelegramAlert(message: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN not configured");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    const result = await response.json();
    if (!result.ok) {
      console.error("Telegram API error:", result);
    }
    return result.ok;
  } catch (error) {
    console.error("Telegram send error:", error);
    return false;
  }
}

/**
 * Check URLs against Google Safe Browsing API
 */
async function checkGoogleSafeBrowsing(urls: string[]): Promise<GoogleSafeBrowsingResult> {
  if (!GOOGLE_SAFE_BROWSING_API_KEY) {
    return { error: "GOOGLE_SAFE_BROWSING_API_KEY not configured" };
  }

  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${GOOGLE_SAFE_BROWSING_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: {
            clientId: "foodshare-domain-monitor",
            clientVersion: "1.0.0",
          },
          threatInfo: {
            threatTypes: [
              "MALWARE",
              "SOCIAL_ENGINEERING",
              "UNWANTED_SOFTWARE",
              "POTENTIALLY_HARMFUL_APPLICATION",
            ],
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
    return { error: `Request failed: ${error.message}` };
  }
}

/**
 * Check URL against VirusTotal API
 */
async function checkVirusTotal(url: string): Promise<VirusTotalResult> {
  if (!VIRUSTOTAL_API_KEY) {
    return { url, status: "error", error: "VIRUSTOTAL_API_KEY not configured" };
  }

  try {
    // URL ID is base64 encoded URL without padding
    const urlId = btoa(url).replace(/=/g, "");

    const response = await fetch(`https://www.virustotal.com/api/v3/urls/${urlId}`, {
      headers: { "x-apikey": VIRUSTOTAL_API_KEY },
    });

    if (response.status === 404) {
      // URL not in database - submit for scanning
      const formData = new FormData();
      formData.append("url", url);

      await fetch("https://www.virustotal.com/api/v3/urls", {
        method: "POST",
        headers: { "x-apikey": VIRUSTOTAL_API_KEY },
        body: formData,
      });

      return { url, status: "not_found" };
    }

    if (!response.ok) {
      return {
        url,
        status: "error",
        error: `API error ${response.status}`,
      };
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
    return { url, status: "error", error: error.message };
  }
}

/**
 * Quick SSL/connectivity check (from Supabase region)
 */
async function checkSSL(url: string): Promise<SSLCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok || response.status === 301 || response.status === 302) {
      return { url, status: "valid", region: "Supabase Edge (AWS)" };
    }

    return {
      url,
      status: "error",
      region: "Supabase Edge (AWS)",
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return { url, status: "error", region: "Supabase Edge (AWS)", error: error.message };
  }
}

/**
 * Resolve DNS for a domain to track which IPs we're hitting
 * This helps diagnose issues where specific Vercel edge IPs are problematic
 */
async function resolveDNS(domain: string): Promise<DNSResolutionResult> {
  try {
    // Use dns-over-https for reliable DNS resolution
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain}&type=A`, {
      headers: { Accept: "application/dns-json" },
    });

    if (!response.ok) {
      return { domain, ips: [], error: `DNS lookup failed: ${response.status}` };
    }

    const data = await response.json();
    const ips = (data.Answer || [])
      .filter((record: { type: number }) => record.type === 1) // A records
      .map((record: { data: string }) => record.data);

    return { domain, ips };
  } catch (error) {
    return { domain, ips: [], error: error.message };
  }
}

/**
 * Check for SafeBrowse hijacking by testing resolved IPs directly
 * Uses an external TCP check service to test raw port 443 responses
 *
 * This catches the scenario where port 443 returns HTTP 302 to safebrowse.io
 * instead of performing TLS handshake (as happened Dec 4, 2025)
 */
async function checkSafeBrowseHijack(url: string): Promise<SafeBrowseCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Make request with redirect: "manual" to see if there's a safebrowse redirect
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "FoodShare-Domain-Monitor/1.0",
      },
    });

    clearTimeout(timeoutId);

    // Check Location header for SafeBrowse patterns
    const locationHeader = response.headers.get("location") || "";
    const locationLower = locationHeader.toLowerCase();

    for (const pattern of SAFEBROWSE_PATTERNS) {
      if (locationLower.includes(pattern)) {
        return {
          url,
          status: "hijacked",
          redirectUrl: locationHeader,
        };
      }
    }

    // For 200 responses, also check body content
    if (response.status === 200) {
      const text = await response.text();
      const textLower = text.toLowerCase();

      for (const pattern of SAFEBROWSE_PATTERNS) {
        if (textLower.includes(pattern)) {
          return {
            url,
            status: "hijacked",
            redirectUrl: `SafeBrowse reference found in page content`,
          };
        }
      }
    }

    return { url, status: "clean" };
  } catch (error) {
    const errorMsg = error.message.toLowerCase();

    // SSL/TLS errors might indicate hijacking (HTTP on port 443)
    if (
      errorMsg.includes("ssl") ||
      errorMsg.includes("tls") ||
      errorMsg.includes("certificate") ||
      errorMsg.includes("protocol") ||
      errorMsg.includes("handshake")
    ) {
      return {
        url,
        status: "hijacked",
        error: `SSL/TLS failure (possible hijack): ${error.message}`,
      };
    }

    // Network errors are just errors, not hijacks
    return { url, status: "error", error: error.message };
  }
}

/**
 * Check specific IPs for SafeBrowse hijacking using check-host.net TCP check
 * This tests the actual edge node behavior, not just the HTTPS connection
 * @internal Reserved for future use in advanced hijack detection
 */
async function _checkIPsForHijack(
  domain: string,
  ips: string[]
): Promise<{ ip: string; hijacked: boolean; error?: string }[]> {
  const results: { ip: string; hijacked: boolean; error?: string }[] = [];

  for (const ip of ips) {
    try {
      // Use check-host.net TCP check to port 443
      const checkUrl = `https://check-host.net/check-tcp?host=${ip}:443`;
      const initResponse = await fetch(checkUrl, {
        headers: { Accept: "application/json" },
      });

      if (!initResponse.ok) {
        results.push({ ip, hijacked: false, error: "check-host.net unavailable" });
        continue;
      }

      const initData = await initResponse.json();
      const requestId = initData.request_id;

      if (!requestId) {
        results.push({ ip, hijacked: false, error: "No request_id" });
        continue;
      }

      // Wait for results
      await new Promise((r) => setTimeout(r, 3000));

      const resultResponse = await fetch(`https://check-host.net/check-result/${requestId}`, {
        headers: { Accept: "application/json" },
      });

      if (!resultResponse.ok) {
        results.push({ ip, hijacked: false, error: "Failed to get results" });
        continue;
      }

      // TCP check doesn't directly tell us about SafeBrowse, but connectivity helps
      results.push({ ip, hijacked: false });
    } catch (error) {
      results.push({ ip, hijacked: false, error: error.message });
    }
  }

  return results;
}

/**
 * Multi-region HTTP check using check-host.net API
 * Checks from California (US West) and Germany (EU)
 */
async function checkMultiRegion(url: string): Promise<MultiRegionCheckResult> {
  const result: MultiRegionCheckResult = {
    url,
    regions: [],
  };

  try {
    // Step 1: Initiate the check - request specific nodes (California + Germany)
    // Note: API requires separate &node= params for each node
    const nodeList = [CHECK_HOST_NODES.california, CHECK_HOST_NODES.germany];
    const nodeParams = nodeList.map((n) => `node=${n}`).join("&");
    const checkUrl = `https://check-host.net/check-http?host=${encodeURIComponent(url)}&${nodeParams}`;
    const initResponse = await fetch(checkUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!initResponse.ok) {
      // Fallback: just report we couldn't check
      result.regions.push({
        name: "california",
        location: "San Francisco, CA, USA",
        status: "error",
        error: "check-host.net API unavailable",
      });
      result.regions.push({
        name: "germany",
        location: "Frankfurt, Germany",
        status: "error",
        error: "check-host.net API unavailable",
      });
      return result;
    }

    const initData = await initResponse.json();
    const requestId = initData.request_id;
    const nodeResults = initData.nodes || {};

    if (!requestId) {
      throw new Error("No request_id in response");
    }

    // Step 2: Wait for results (check-host needs time to complete)
    await new Promise((r) => setTimeout(r, 5000));

    // Step 3: Get results
    const resultResponse = await fetch(`https://check-host.net/check-result/${requestId}`, {
      headers: { Accept: "application/json" },
    });

    if (!resultResponse.ok) {
      throw new Error(`Failed to get results: ${resultResponse.status}`);
    }

    const resultData = await resultResponse.json();

    // Parse results for each node
    for (const [nodeId, nodeInfo] of Object.entries(nodeResults)) {
      const nodeResult = resultData[nodeId];
      // nodeInfo format: [country_code, country, city, ip, asn]
      const info = nodeInfo as [string, string, string, string, string];
      const location = `${info[2]}, ${info[1]}`;

      // Determine region name based on node ID
      let regionName = "other";
      if (nodeId === CHECK_HOST_NODES.california) {
        regionName = "california";
      } else if (nodeId === CHECK_HOST_NODES.germany) {
        regionName = "germany";
      }

      if (nodeResult === null) {
        result.regions.push({
          name: regionName,
          location,
          status: "pending",
        });
      } else if (Array.isArray(nodeResult) && nodeResult[0]) {
        const checkResult = nodeResult[0];
        if (checkResult[0] === 1) {
          // Success
          result.regions.push({
            name: regionName,
            location,
            status: "ok",
            responseTime: checkResult[1],
          });
        } else {
          // Error
          result.regions.push({
            name: regionName,
            location,
            status: "error",
            error: checkResult[2] || "Connection failed",
          });
        }
      } else {
        result.regions.push({
          name: regionName,
          location,
          status: "timeout",
        });
      }
    }
  } catch (error) {
    console.error("Multi-region check error:", error);
    result.regions.push({
      name: "california",
      location: "San Francisco, CA, USA",
      status: "error",
      error: error.message,
    });
    result.regions.push({
      name: "germany",
      location: "Frankfurt, Germany",
      status: "error",
      error: error.message,
    });
  }

  return result;
}

/**
 * Main monitoring function
 */
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

  // 0. DNS Resolution (for custom domains)
  console.log("Resolving DNS...");
  const customDomainNames = ["foodshare.club", "www.foodshare.club"];
  for (const domain of customDomainNames) {
    const dnsResult = await resolveDNS(domain);
    result.dnsResolution.push(dnsResult);
  }

  // 1. Check Google Safe Browsing
  console.log("Checking Google Safe Browsing...");
  result.googleSafeBrowsing = await checkGoogleSafeBrowsing(DOMAINS_TO_MONITOR);

  if (result.googleSafeBrowsing.error) {
    console.warn("Google Safe Browsing error:", result.googleSafeBrowsing.error);
  } else if (result.googleSafeBrowsing.matches && result.googleSafeBrowsing.matches.length > 0) {
    result.status = "critical";
    const flaggedUrls = result.googleSafeBrowsing.matches
      .map((m) => `${m.threat.url} (${m.threatType})`)
      .join("\n");
    result.alerts.push(`Google Safe Browsing flagged:\n${flaggedUrls}`);
  }

  // 2. Check VirusTotal (with rate limiting - 4 req/min free tier)
  console.log("Checking VirusTotal...");
  for (const url of DOMAINS_TO_MONITOR) {
    const vtResult = await checkVirusTotal(url);
    result.virusTotal.push(vtResult);

    if (vtResult.status === "flagged") {
      result.status = result.status === "critical" ? "critical" : "warning";
      result.alerts.push(
        `VirusTotal flagged ${url}: ${vtResult.malicious} malicious, ${vtResult.suspicious} suspicious`
      );
    }

    // Rate limit: wait 15 seconds between requests
    if (DOMAINS_TO_MONITOR.indexOf(url) < DOMAINS_TO_MONITOR.length - 1) {
      await new Promise((r) => setTimeout(r, 15000));
    }
  }

  // 3. Quick SSL/connectivity checks (parallel)
  console.log("Checking SSL/connectivity...");
  const sslResults = await Promise.all(DOMAINS_TO_MONITOR.map((url) => checkSSL(url)));
  result.sslChecks = sslResults;

  for (const sslResult of sslResults) {
    if (sslResult.status === "error") {
      result.status = result.status === "healthy" ? "warning" : result.status;
      result.alerts.push(`SSL/connectivity issue for ${sslResult.url}: ${sslResult.error}`);
    }
  }

  // 4. SafeBrowse hijack detection (custom domains only)
  console.log("Checking for SafeBrowse hijacking...");
  const customDomains = DOMAINS_TO_MONITOR.filter((d) => !d.includes("vercel.app"));
  for (const url of customDomains) {
    const hijackResult = await checkSafeBrowseHijack(url);
    result.safeBrowseHijackChecks.push(hijackResult);

    if (hijackResult.status === "hijacked") {
      result.status = "critical";
      result.alerts.push(
        `🚨 SafeBrowse HIJACK detected for ${url}!\nRedirect: ${hijackResult.redirectUrl || hijackResult.error}`
      );
    }
  }

  // 5. Multi-region checks (California & Germany) for custom domains only
  console.log("Checking from multiple regions (CA & DE)...");
  for (const url of customDomains) {
    const multiResult = await checkMultiRegion(url);
    result.multiRegionChecks.push(multiResult);

    // Check for regional failures
    for (const region of multiResult.regions) {
      if (region.status === "error" || region.status === "timeout") {
        result.status = result.status === "healthy" ? "warning" : result.status;
        result.alerts.push(
          `Regional issue for ${url} from ${region.location}: ${region.error || region.status}`
        );
      }
    }
  }

  // 5. Send Telegram alerts if issues found
  if (result.alerts.length > 0) {
    const statusEmoji =
      result.status === "critical" ? "🚨" : result.status === "warning" ? "⚠️" : "✅";

    const message =
      `${statusEmoji} <b>FoodShare Domain Monitor</b>\n\n` +
      `Status: <b>${result.status.toUpperCase()}</b>\n` +
      `Time: ${result.timestamp}\n\n` +
      `<b>Alerts:</b>\n${result.alerts.map((a) => `• ${a}`).join("\n")}\n\n` +
      `<i>Check: https://transparencyreport.google.com/safe-browsing/search?url=foodshare.club</i>`;

    await sendTelegramAlert(message);
  }

  return result;
}

// Main handler
Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Check if function is disabled
  if (FUNCTION_DISABLED) {
    return new Response(
      JSON.stringify({
        status: "disabled",
        message:
          "Domain monitor is currently disabled. Set FUNCTION_DISABLED = false to re-enable.",
        timestamp: new Date().toISOString(),
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  try {
    console.log("Starting domain monitoring...");
    const result = await monitorDomains();

    // Send summary notification even if healthy (optional, for testing)
    const forceNotify = new URL(req.url).searchParams.get("notify") === "true";
    if (forceNotify && result.alerts.length === 0) {
      // Build multi-region summary
      let regionSummary = "";
      for (const check of result.multiRegionChecks) {
        const domain = check.url.replace("https://", "");
        for (const region of check.regions) {
          const ms = region.responseTime ? Math.round(region.responseTime * 1000) : "N/A";
          const status = region.status === "ok" ? "✓" : "✗";
          regionSummary += `${status} ${domain} → ${region.name}: ${ms}ms\n`;
        }
      }

      // Build hijack check summary
      let hijackSummary = "";
      for (const check of result.safeBrowseHijackChecks) {
        const domain = check.url.replace("https://", "");
        const status = check.status === "clean" ? "✓" : "✗ HIJACKED";
        hijackSummary += `${status} ${domain}\n`;
      }

      // Build DNS summary
      let dnsSummary = "";
      for (const dns of result.dnsResolution) {
        dnsSummary += `${dns.domain}: ${dns.ips.join(", ") || dns.error || "N/A"}\n`;
      }

      await sendTelegramAlert(
        `✅ <b>FoodShare Domain Monitor</b>\n\n` +
          `<b>Status:</b> All domains healthy\n` +
          `<b>Time:</b> ${result.timestamp}\n\n` +
          `<b>DNS Resolution:</b>\n<code>${dnsSummary}</code>\n` +
          `<b>SafeBrowse Hijack Check:</b>\n<code>${hijackSummary}</code>\n` +
          `<b>Multi-Region Checks:</b>\n<code>${regionSummary}</code>\n` +
          `<b>SSL:</b> ${result.sslChecks.filter((s) => s.status === "valid").length}/${result.sslChecks.length} valid\n` +
          `<b>Safe Browsing:</b> ${result.googleSafeBrowsing?.matches ? "⚠️ Flagged" : "Clean"}`
      );
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Monitor error:", error);

    // Send error alert
    await sendTelegramAlert(
      `❌ <b>FoodShare Domain Monitor Error</b>\n\n` +
        `Error: ${error.message}\n` +
        `Time: ${new Date().toISOString()}`
    );

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});
