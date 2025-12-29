/**
 * Cross-Platform Push Notification Service v2.0
 *
 * Supports: iOS (APNs), Android (FCM v1), Web (VAPID)
 *
 * Features:
 * - Circuit breaker pattern for resilience
 * - Automatic retry with exponential backoff
 * - Batch processing with concurrency control
 * - Dead token cleanup
 * - Metrics and observability
 * - Rate limiting awareness
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as jose from "https://deno.land/x/jose@v5.2.0/index.ts";
import webpush from "npm:web-push@3.6.7";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Retry settings
  maxRetries: 3,
  retryDelayMs: 1000,
  maxRetryDelayMs: 10000,

  // Batch processing
  batchSize: 100,
  concurrency: 10,

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxAttempts: 3,
  },

  // Timeouts
  requestTimeoutMs: 30000,

  // Token cleanup
  cleanupStaleTokensDays: 90,
} as const;

// Environment
const env = {
  supabaseUrl: Deno.env.get("SUPABASE_URL")!,
  supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  // APNs
  apnsKeyId: Deno.env.get("APNS_KEY_ID"),
  apnsTeamId: Deno.env.get("APNS_TEAM_ID"),
  apnsBundleId: Deno.env.get("APNS_BUNDLE_ID") || "co.nz.foodshare.FoodShare",
  apnsPrivateKey: Deno.env.get("APNS_PRIVATE_KEY"),
  apnsEnvironment: Deno.env.get("APNS_ENVIRONMENT") || "production",
  // FCM
  fcmProjectId: Deno.env.get("FCM_PROJECT_ID"),
  fcmClientEmail: Deno.env.get("FCM_CLIENT_EMAIL"),
  fcmPrivateKey: Deno.env.get("FCM_PRIVATE_KEY"),
  // VAPID
  vapidPublicKey: Deno.env.get("VAPID_PUBLIC_KEY"),
  vapidPrivateKey: Deno.env.get("VAPID_PRIVATE_KEY"),
  vapidSubject: Deno.env.get("VAPID_SUBJECT") || "mailto:hello@foodshare.club",
};

// ============================================================================
// Types
// ============================================================================

type Platform = "ios" | "android" | "web";
type CircuitState = "closed" | "open" | "half-open";

interface PushPayload {
  type: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string | number;
  image?: string;
  url?: string;
  tag?: string;
  data?: Record<string, string>;
  sound?: string;
  priority?: "high" | "normal";
  ttl?: number;
  collapseKey?: string;
  actions?: Array<{ action: string; title: string; icon?: string }>;
}

interface SendRequest {
  user_ids?: string[];
  tokens?: Array<{ token: string; platform: Platform }>;
  platforms?: Platform[];
  payload: PushPayload;
  options?: {
    dryRun?: boolean;
    priority?: "high" | "normal";
    ttl?: number;
  };
}

interface DeviceToken {
  profile_id: string;
  token: string;
  platform: Platform;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
}

interface SendResult {
  success: boolean;
  platform: Platform;
  token?: string;
  messageId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
}

interface Metrics {
  total: number;
  sent: number;
  failed: number;
  retried: number;
  byPlatform: Record<Platform, { sent: number; failed: number }>;
  latencyMs: number;
  tokensRemoved: number;
}

// ============================================================================
// Logging
// ============================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...ctx };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ============================================================================
// Circuit Breaker
// ============================================================================

const circuits = new Map<Platform, CircuitBreakerState>();

function getCircuit(platform: Platform): CircuitBreakerState {
  if (!circuits.has(platform)) {
    circuits.set(platform, {
      state: "closed",
      failures: 0,
      lastFailureTime: 0,
      halfOpenAttempts: 0,
    });
  }
  return circuits.get(platform)!;
}

function canAttempt(platform: Platform): boolean {
  const circuit = getCircuit(platform);

  if (circuit.state === "closed") return true;

  if (circuit.state === "open") {
    if (Date.now() - circuit.lastFailureTime >= CONFIG.circuitBreaker.resetTimeoutMs) {
      circuit.state = "half-open";
      circuit.halfOpenAttempts = 0;
      log("info", "Circuit half-open", { platform });
      return true;
    }
    return false;
  }

  // half-open
  if (circuit.halfOpenAttempts < CONFIG.circuitBreaker.halfOpenMaxAttempts) {
    circuit.halfOpenAttempts++;
    return true;
  }
  return false;
}

function recordSuccess(platform: Platform): void {
  const circuit = getCircuit(platform);
  if (circuit.state !== "closed") {
    circuit.state = "closed";
    circuit.failures = 0;
    log("info", "Circuit closed", { platform });
  }
}

function recordFailure(platform: Platform): void {
  const circuit = getCircuit(platform);
  circuit.failures++;
  circuit.lastFailureTime = Date.now();

  if (circuit.state === "half-open" || circuit.failures >= CONFIG.circuitBreaker.failureThreshold) {
    circuit.state = "open";
    log("warn", "Circuit opened", { platform, failures: circuit.failures });
  }
}

// ============================================================================
// Retry Logic
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  platform: Platform,
  maxRetries = CONFIG.maxRetries
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < maxRetries) {
        const delay = Math.min(
          CONFIG.retryDelayMs * Math.pow(2, attempt - 1),
          CONFIG.maxRetryDelayMs
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// ============================================================================
// APNs Provider (iOS)
// ============================================================================

let apnsJwtCache: { token: string; expires: number } | null = null;

async function getApnsToken(): Promise<string> {
  // Cache JWT for 50 minutes (APNs tokens valid for 60 min)
  if (apnsJwtCache && apnsJwtCache.expires > Date.now()) {
    return apnsJwtCache.token;
  }

  if (!env.apnsPrivateKey || !env.apnsKeyId || !env.apnsTeamId) {
    throw new Error("APNs not configured");
  }

  const privateKey = await jose.importPKCS8(env.apnsPrivateKey.replace(/\\n/g, "\n"), "ES256");

  const token = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.apnsKeyId })
    .setIssuedAt()
    .setIssuer(env.apnsTeamId)
    .sign(privateKey);

  apnsJwtCache = { token, expires: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function sendApns(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  if (!canAttempt("ios")) {
    return { success: false, platform: "ios", error: "Circuit open", retryable: true };
  }

  try {
    const jwt = await getApnsToken();
    const host =
      env.apnsEnvironment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";

    const apnsPayload = {
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: payload.sound || "default",
        badge: typeof payload.badge === "number" ? payload.badge : undefined,
        "mutable-content": 1,
        "content-available": 1,
        "thread-id": payload.collapseKey,
      },
      type: payload.type,
      url: payload.url,
      ...payload.data,
    };

    const response = await fetch(`https://${host}/3/device/${device.token}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "apns-topic": env.apnsBundleId,
        "apns-push-type": "alert",
        "apns-priority": payload.priority === "normal" ? "5" : "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + (payload.ttl || 86400)),
        "apns-collapse-id": payload.collapseKey || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(apnsPayload),
    });

    if (response.status === 200) {
      recordSuccess("ios");
      const apnsId = response.headers.get("apns-id");
      return { success: true, platform: "ios", messageId: apnsId || undefined };
    }

    const errorBody = await response.json().catch(() => ({}));
    const reason = errorBody.reason || `HTTP ${response.status}`;

    // Determine if token is invalid
    const invalidTokenReasons = ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"];
    const isInvalidToken = invalidTokenReasons.includes(reason) || response.status === 410;

    if (!isInvalidToken) recordFailure("ios");

    return {
      success: false,
      platform: "ios",
      token: device.token,
      error: reason,
      errorCode: reason,
      retryable: !isInvalidToken && response.status >= 500,
    };
  } catch (e) {
    recordFailure("ios");
    return { success: false, platform: "ios", error: (e as Error).message, retryable: true };
  }
}

// ============================================================================
// FCM Provider (Android) - HTTP v1 API
// ============================================================================

let fcmAccessTokenCache: { token: string; expires: number } | null = null;

async function getFcmAccessToken(): Promise<string> {
  if (fcmAccessTokenCache && fcmAccessTokenCache.expires > Date.now()) {
    return fcmAccessTokenCache.token;
  }

  if (!env.fcmClientEmail || !env.fcmPrivateKey || !env.fcmProjectId) {
    throw new Error("FCM not configured");
  }

  const privateKey = await jose.importPKCS8(env.fcmPrivateKey.replace(/\\n/g, "\n"), "RS256");

  const now = Math.floor(Date.now() / 1000);
  const jwt = await new jose.SignJWT({
    iss: env.fcmClientEmail,
    sub: env.fcmClientEmail,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(privateKey);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    throw new Error(`FCM auth failed: ${response.status}`);
  }

  const data = await response.json();
  fcmAccessTokenCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

async function sendFcm(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  if (!canAttempt("android")) {
    return { success: false, platform: "android", error: "Circuit open", retryable: true };
  }

  try {
    const accessToken = await getFcmAccessToken();

    const fcmPayload = {
      message: {
        token: device.token,
        notification: {
          title: payload.title,
          body: payload.body,
          image: payload.image,
        },
        android: {
          priority: payload.priority === "normal" ? "NORMAL" : "HIGH",
          ttl: `${payload.ttl || 86400}s`,
          collapse_key: payload.collapseKey,
          notification: {
            icon: payload.icon,
            color: "#FF2D55",
            sound: payload.sound || "default",
            tag: payload.tag,
            click_action: "OPEN_URL",
          },
        },
        data: {
          type: payload.type,
          url: payload.url || "/",
          ...payload.data,
        },
      },
    };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.fcmProjectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fcmPayload),
      }
    );

    if (response.ok) {
      recordSuccess("android");
      const data = await response.json();
      return { success: true, platform: "android", messageId: data.name };
    }

    const errorBody = await response.json().catch(() => ({}));
    const errorCode = errorBody.error?.details?.[0]?.errorCode || errorBody.error?.code;

    const invalidTokenCodes = ["UNREGISTERED", "INVALID_ARGUMENT"];
    const isInvalidToken = invalidTokenCodes.includes(errorCode);

    if (!isInvalidToken) recordFailure("android");

    return {
      success: false,
      platform: "android",
      token: device.token,
      error: errorBody.error?.message || `HTTP ${response.status}`,
      errorCode,
      retryable: !isInvalidToken && response.status >= 500,
    };
  } catch (e) {
    recordFailure("android");
    return { success: false, platform: "android", error: (e as Error).message, retryable: true };
  }
}

// ============================================================================
// Web Push Provider
// ============================================================================

let webPushInitialized = false;

function initWebPush(): boolean {
  if (webPushInitialized) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;

  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  webPushInitialized = true;
  return true;
}

async function sendWebPush(device: DeviceToken, payload: PushPayload): Promise<SendResult> {
  if (!canAttempt("web")) {
    return { success: false, platform: "web", error: "Circuit open", retryable: true };
  }

  if (!initWebPush()) {
    return { success: false, platform: "web", error: "VAPID not configured" };
  }

  if (!device.endpoint || !device.p256dh || !device.auth) {
    return { success: false, platform: "web", error: "Invalid subscription" };
  }

  const subscription = {
    endpoint: device.endpoint,
    keys: { p256dh: device.p256dh, auth: device.auth },
  };

  const webPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || "/logo192.png",
    badge: payload.badge || "/favicon-32x32.png",
    image: payload.image,
    tag: payload.tag || payload.type,
    data: { url: payload.url || "/", type: payload.type, ...payload.data },
    actions: payload.actions,
    requireInteraction: false,
    renotify: true,
  });

  try {
    const result = await webpush.sendNotification(subscription, webPayload, {
      TTL: payload.ttl || 86400,
      urgency: payload.priority === "normal" ? "normal" : "high",
    });

    recordSuccess("web");
    return { success: true, platform: "web", messageId: result.headers?.location };
  } catch (e: unknown) {
    const err = e as { statusCode?: number; body?: string };

    const isInvalidSubscription = err.statusCode === 404 || err.statusCode === 410;
    if (!isInvalidSubscription) recordFailure("web");

    return {
      success: false,
      platform: "web",
      token: device.endpoint,
      error: err.body || String(e),
      errorCode: String(err.statusCode),
      retryable: !isInvalidSubscription && (err.statusCode || 0) >= 500,
    };
  }
}

// ============================================================================
// Token Management
// ============================================================================

async function removeInvalidTokens(
  supabase: SupabaseClient,
  results: SendResult[]
): Promise<number> {
  const invalidTokens = results.filter((r) => !r.success && !r.retryable && r.token);

  if (!invalidTokens.length) return 0;

  let removed = 0;

  for (const result of invalidTokens) {
    if (result.platform === "web" && result.token?.startsWith("http")) {
      await supabase.from("device_tokens").delete().eq("endpoint", result.token);
    } else if (result.token) {
      await supabase
        .from("device_tokens")
        .delete()
        .eq("token", result.token)
        .eq("platform", result.platform);
    }
    removed++;
  }

  if (removed > 0) {
    log("info", "Removed invalid tokens", { count: removed });
  }

  return removed;
}

async function getDeviceTokens(
  supabase: SupabaseClient,
  userIds: string[],
  platforms?: Platform[]
): Promise<DeviceToken[]> {
  let query = supabase
    .from("device_tokens")
    .select("profile_id, token, platform, endpoint, p256dh, auth")
    .in("profile_id", userIds);

  if (platforms?.length) {
    query = query.in("platform", platforms);
  }

  const { data, error } = await query;

  if (error) {
    log("error", "Failed to fetch tokens", { error: error.message });
    return [];
  }

  return (data as DeviceToken[]) || [];
}

// ============================================================================
// Batch Processing
// ============================================================================

async function processBatch(
  devices: DeviceToken[],
  payload: PushPayload,
  concurrency: number
): Promise<SendResult[]> {
  const results: SendResult[] = [];

  // Process in chunks
  for (let i = 0; i < devices.length; i += concurrency) {
    const chunk = devices.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (device) => {
        const sendFn = async () => {
          switch (device.platform) {
            case "ios":
              return sendApns(device, payload);
            case "android":
              return sendFcm(device, payload);
            case "web":
              return sendWebPush(device, payload);
            default:
              return {
                success: false,
                platform: device.platform,
                error: "Unknown platform",
              } as SendResult;
          }
        };

        try {
          return await withRetry(sendFn, device.platform);
        } catch (e) {
          return {
            success: false,
            platform: device.platform,
            token: device.platform === "web" ? device.endpoint : device.token,
            error: (e as Error).message,
          } as SendResult;
        }
      })
    );

    results.push(...chunkResults);
  }

  return results;
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  const startTime = performance.now();
  const requestId = crypto.randomUUID();

  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const supabase = createClient(env.supabaseUrl, env.supabaseKey);

  try {
    const request: SendRequest = await req.json();
    const { user_ids, tokens, platforms, payload, options } = request;

    // Validation
    if (!payload?.title || !payload?.body) {
      return jsonResponse({ error: "Missing required fields: title, body" }, 400, requestId);
    }

    if (!payload.type) {
      payload.type = "notification";
    }

    // Get device tokens
    let deviceTokens: DeviceToken[] = [];

    if (user_ids?.length) {
      deviceTokens = await getDeviceTokens(supabase, user_ids, platforms);
    } else if (tokens?.length) {
      deviceTokens = tokens.map((t) => ({
        profile_id: "",
        token: t.token,
        platform: t.platform,
      }));
    } else {
      return jsonResponse({ error: "Must provide user_ids or tokens" }, 400, requestId);
    }

    if (!deviceTokens.length) {
      return jsonResponse(
        { success: true, sent: 0, failed: 0, message: "No device tokens found" },
        200,
        requestId
      );
    }

    // Apply options
    if (options?.priority) payload.priority = options.priority;
    if (options?.ttl) payload.ttl = options.ttl;

    // Dry run mode
    if (options?.dryRun) {
      return jsonResponse(
        {
          success: true,
          dryRun: true,
          wouldSend: deviceTokens.length,
          byPlatform: {
            ios: deviceTokens.filter((d) => d.platform === "ios").length,
            android: deviceTokens.filter((d) => d.platform === "android").length,
            web: deviceTokens.filter((d) => d.platform === "web").length,
          },
        },
        200,
        requestId
      );
    }

    // Process notifications
    const results = await processBatch(deviceTokens, payload, CONFIG.concurrency);

    // Cleanup invalid tokens
    const tokensRemoved = await removeInvalidTokens(supabase, results);

    // Calculate metrics
    const metrics: Metrics = {
      total: results.length,
      sent: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      retried: 0,
      byPlatform: {
        ios: {
          sent: results.filter((r) => r.platform === "ios" && r.success).length,
          failed: results.filter((r) => r.platform === "ios" && !r.success).length,
        },
        android: {
          sent: results.filter((r) => r.platform === "android" && r.success).length,
          failed: results.filter((r) => r.platform === "android" && !r.success).length,
        },
        web: {
          sent: results.filter((r) => r.platform === "web" && r.success).length,
          failed: results.filter((r) => r.platform === "web" && !r.success).length,
        },
      },
      latencyMs: Math.round(performance.now() - startTime),
      tokensRemoved,
    };

    log("info", "Push notifications sent", { requestId, ...metrics });

    return jsonResponse(
      {
        success: true,
        ...metrics,
        circuits: {
          ios: getCircuit("ios").state,
          android: getCircuit("android").state,
          web: getCircuit("web").state,
        },
      },
      200,
      requestId
    );
  } catch (e) {
    log("error", "Push notification error", { requestId, error: (e as Error).message });
    return jsonResponse({ error: (e as Error).message }, 500, requestId);
  }
});

function jsonResponse(data: Record<string, unknown>, status: number, requestId: string): Response {
  return new Response(JSON.stringify({ ...data, requestId }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Request-Id": requestId,
    },
  });
}
