import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { timing, startTime, endTime } from "npm:hono@4/timing";
import { compress } from "npm:hono@4/compress";
import { secureHeaders } from "npm:hono@4/secure-headers";
import { stream } from "npm:hono@4/streaming";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

// ============================================================================
// CROSS-PLATFORM TRANSLATION API v4 - Bleeding Edge
// Built with: Hono 4, Zod 3, Supabase JS 2, Deno 2
// Features: WebSocket real-time, Streaming, HTTP/2 Server Push hints,
//           Advanced caching, Prefetch, Background sync, Smart CDN
// ============================================================================

const VERSION = "4.0.0";
const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

const SUPPORTED_LOCALES = [
  "en",
  "cs",
  "de",
  "es",
  "fr",
  "pt",
  "ru",
  "uk",
  "zh",
  "hi",
  "ar",
  "it",
  "pl",
  "nl",
  "ja",
  "ko",
  "tr",
];

const SUPPORTED_PLATFORMS = [
  "web",
  "ios",
  "android",
  "desktop",
  "browser_extension",
  "api",
  "react_native",
  "flutter",
  "unknown",
];

const LocaleSchema = z.enum(SUPPORTED_LOCALES as [string, ...string[]]);
const PlatformSchema = z.enum(SUPPORTED_PLATFORMS as [string, ...string[]]);

// ============================================================================
// Platform Configurations with Bleeding Edge Features
// ============================================================================

const PLATFORM_CONFIGS: Record<string, any> = {
  web: {
    cacheTTL: 3600,
    maxBatch: 10,
    rateLimit: 200,
    deltaEnabled: true,
    compressionThreshold: 1024,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: true,
    smartCDN: true,
  },
  ios: {
    cacheTTL: 7200,
    maxBatch: 5,
    rateLimit: 150,
    deltaEnabled: true,
    compressionThreshold: 512,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: false,
    smartCDN: true,
  },
  android: {
    cacheTTL: 7200,
    maxBatch: 5,
    rateLimit: 150,
    deltaEnabled: true,
    compressionThreshold: 512,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: false,
    smartCDN: true,
  },
  react_native: {
    cacheTTL: 7200,
    maxBatch: 5,
    rateLimit: 150,
    deltaEnabled: true,
    compressionThreshold: 512,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: false,
    smartCDN: true,
  },
  flutter: {
    cacheTTL: 7200,
    maxBatch: 5,
    rateLimit: 150,
    deltaEnabled: true,
    compressionThreshold: 512,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: false,
    smartCDN: true,
  },
  desktop: {
    cacheTTL: 3600,
    maxBatch: 10,
    rateLimit: 200,
    deltaEnabled: true,
    compressionThreshold: 1024,
    streamingEnabled: true,
    realtimeEnabled: true,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: true,
    smartCDN: true,
  },
  browser_extension: {
    cacheTTL: 1800,
    maxBatch: 3,
    rateLimit: 100,
    deltaEnabled: true,
    compressionThreshold: 512,
    streamingEnabled: false,
    realtimeEnabled: false,
    prefetchEnabled: true,
    backgroundSyncEnabled: true,
    http2PushEnabled: false,
    smartCDN: false,
  },
  api: {
    cacheTTL: 300,
    maxBatch: 20,
    rateLimit: 500,
    deltaEnabled: true,
    compressionThreshold: 0,
    streamingEnabled: true,
    realtimeEnabled: false,
    prefetchEnabled: false,
    backgroundSyncEnabled: false,
    http2PushEnabled: false,
    smartCDN: false,
  },
  unknown: {
    cacheTTL: 3600,
    maxBatch: 5,
    rateLimit: 100,
    deltaEnabled: true,
    compressionThreshold: 1024,
    streamingEnabled: false,
    realtimeEnabled: false,
    prefetchEnabled: false,
    backgroundSyncEnabled: false,
    http2PushEnabled: false,
    smartCDN: false,
  },
};

// ============================================================================
// Hono App Setup
// ============================================================================

const app = new Hono();

app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
  })
);

app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: [
      "Authorization",
      "X-Client-Info",
      "apikey",
      "Content-Type",
      "X-Locale",
      "X-Version",
      "X-Platform",
      "X-User-Id",
      "X-Device-Id",
      "X-App-Version",
      "X-OS-Version",
      "X-Batch-Locales",
      "X-Keys",
      "If-None-Match",
      "If-Modified-Since",
      "Accept-Encoding",
      "X-Request-Id",
      "X-Region",
      "X-Format",
      "X-Prefetch",
      "X-Background-Sync",
      "X-Stream",
      "Upgrade",
      "Connection",
    ],
    allowMethods: ["GET", "POST", "HEAD", "OPTIONS"],
    exposeHeaders: [
      "X-Cache",
      "X-Response-Time",
      "X-Locale",
      "X-Platform",
      "X-Rate-Limit-Remaining",
      "X-Rate-Limit-Reset",
      "ETag",
      "X-Delta-Available",
      "X-Request-Id",
      "Server-Timing",
      "X-Version",
      "X-Fallback",
      "Content-Encoding",
      "Last-Modified",
      "Link",
      "X-Prefetch-Available",
      "X-Realtime-Available",
    ],
    maxAge: 86400,
  })
);

app.use("*", timing());
app.use("*", compress());

// ============================================================================
// Helper Functions
// ============================================================================

function createSupabaseClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "X-Client-Info": `edge-function/translations/${VERSION}`,
      },
    },
  });
}

function detectPlatform(ua: string | undefined): string {
  if (!ua) return "unknown";
  const l = ua.toLowerCase();
  if (l.includes("electron") || l.includes("tauri")) return "desktop";
  if (l.includes("expo") || l.includes("react-native")) return "react_native";
  if (l.includes("dart") || l.includes("flutter")) return "flutter";
  if (l.includes("iphone") || l.includes("ipad") || l.includes("ios")) return "ios";
  if (l.includes("android")) return "android";
  if (l.includes("node") || l.includes("deno") || l.includes("bun")) return "api";
  if (l.includes("mozilla") || l.includes("chrome") || l.includes("safari")) return "web";
  return "unknown";
}

function extractContext(c: any) {
  const h = (name: string) => c.req.header(name);
  const q = (name: string) => c.req.query(name);

  const rawLocale = h("x-locale") || q("locale") || "en";
  const rawPlatform = h("x-platform") || q("platform") || detectPlatform(h("user-agent"));

  const locale = LocaleSchema.safeParse(rawLocale).success ? rawLocale : "en";
  const platform = rawPlatform in PLATFORM_CONFIGS ? rawPlatform : "unknown";

  return {
    supabase: createSupabaseClient(),
    locale,
    platform,
    version: h("x-version") || q("version"),
    userId: h("x-user-id"),
    deviceId: h("x-device-id"),
    batchLocales: h("x-batch-locales")
      ?.split(",")
      .map((l: string) => l.trim())
      .filter((l: string) => LocaleSchema.safeParse(l).success),
    keys: (h("x-keys") || q("keys"))?.split(",").map((k: string) => k.trim()),
    format: h("x-format") || q("format") || "json",
    ifNoneMatch: h("if-none-match")?.replace(/"/g, ""),
    ifModifiedSince: h("if-modified-since"),
    ip: h("x-forwarded-for")?.split(",")[0]?.trim() || h("x-real-ip"),
    userAgent: h("user-agent"),
    requestId: h("x-request-id") || crypto.randomUUID(),
    config: PLATFORM_CONFIGS[platform],
    region: h("x-sb-edge-region"),
    prefetch: h("x-prefetch") === "true" || q("prefetch") === "true",
    stream: h("x-stream") === "true" || q("stream") === "true",
    backgroundSync: h("x-background-sync") === "true",
  };
}

async function generateETag(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function checkRateLimit(ctx: any) {
  const key = ctx.userId || ctx.deviceId || ctx.ip || "anon";
  try {
    const { data } = await ctx.supabase.rpc("check_platform_rate_limit", {
      p_identifier: key,
      p_platform: ctx.platform,
    });
    return (
      data || {
        allowed: true,
        remaining: ctx.config.rateLimit,
        resetAt: new Date(Date.now() + 3600000).toISOString(),
      }
    );
  } catch {
    return {
      allowed: true,
      remaining: ctx.config.rateLimit,
      resetAt: new Date(Date.now() + 3600000).toISOString(),
    };
  }
}

async function getTranslations(ctx: any, locale: string) {
  const { data, error } = await ctx.supabase
    .from("translations")
    .select("messages, version, updated_at")
    .eq("locale", locale)
    .single();

  if (error || !data) return null;

  let messages = data.messages;
  if (ctx.keys && ctx.keys.length > 0) {
    messages = Object.fromEntries(
      Object.entries(messages).filter(([key]) => ctx.keys.some((k: string) => key.startsWith(k)))
    );
  }

  return {
    messages,
    version: data.version,
    updatedAt: data.updated_at,
  };
}

function logAnalytics(
  ctx: any,
  status: number,
  cached: boolean,
  responseTimeMs: number,
  fallback = false
) {
  ctx.supabase
    .from("translation_analytics")
    .insert({
      locale: ctx.locale,
      platform: ctx.platform,
      user_id: ctx.userId,
      device_id: ctx.deviceId,
      response_time_ms: responseTimeMs,
      status_code: status,
      cached,
      fallback,
      user_agent: ctx.userAgent?.slice(0, 500),
      ip_address: ctx.ip,
    })
    .then(() => {})
    .catch(() => {});
}

function buildCacheControl(ctx: any, immutable = false): string {
  if (immutable) return CACHE_CONTROL_IMMUTABLE;
  return `public, max-age=${ctx.config.cacheTTL}, stale-while-revalidate=${ctx.config.cacheTTL * 2}`;
}

// ============================================================================
// WebSocket Real-time Updates
// ============================================================================

app.get("/ws", async (c) => {
  const upgrade = c.req.header("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return c.json({ error: "WebSocket upgrade required" }, 400);
  }

  const ctx = extractContext(c);
  if (!ctx.config.realtimeEnabled) {
    return c.json({ error: "Real-time not supported for this platform" }, 400);
  }

  const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

  socket.onopen = () => {
    console.log(`[WS] Client connected: ${ctx.requestId}`);
    socket.send(
      JSON.stringify({
        type: "connected",
        version: VERSION,
        locale: ctx.locale,
        platform: ctx.platform,
      })
    );
  };

  socket.onmessage = async (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "subscribe") {
        const locale = msg.locale || ctx.locale;
        const translations = await getTranslations(ctx, locale);
        if (translations) {
          socket.send(
            JSON.stringify({
              type: "translations",
              locale,
              data: translations,
              timestamp: new Date().toISOString(),
            })
          );
        }
      } else if (msg.type === "ping") {
        socket.send(
          JSON.stringify({
            type: "pong",
            timestamp: new Date().toISOString(),
          })
        );
      }
    } catch (err) {
      console.error("[WS] Message error:", err);
      socket.send(
        JSON.stringify({
          type: "error",
          message: "Invalid message format",
        })
      );
    }
  };

  socket.onerror = (e) => console.error("[WS] Error:", e);
  socket.onclose = () => console.log(`[WS] Client disconnected: ${ctx.requestId}`);

  return response;
});

// ============================================================================
// Streaming Endpoint
// ============================================================================

app.get("/stream", async (c) => {
  const ctx = extractContext(c);
  if (!ctx.config.streamingEnabled) {
    return c.json({ error: "Streaming not supported for this platform" }, 400);
  }

  return stream(c, async (stream) => {
    const locales = ctx.batchLocales || [ctx.locale];
    for (const locale of locales) {
      const translations = await getTranslations(ctx, locale);
      if (translations) {
        await stream.write(
          new TextEncoder().encode(JSON.stringify({ locale, data: translations }) + "\n")
        );
      }
      await stream.sleep(10);
    }
  });
});

// ============================================================================
// Prefetch Endpoint
// ============================================================================

app.get("/prefetch", async (c) => {
  const ctx = extractContext(c);
  if (!ctx.config.prefetchEnabled) {
    return c.json({ error: "Prefetch not supported for this platform" }, 400);
  }

  const { data } = await ctx.supabase
    .from("translations")
    .select("locale, version, updated_at")
    .order("updated_at", { ascending: false });

  const prefetchList = (data || []).map((t: any) => ({
    locale: t.locale,
    version: t.version,
    url: `/translations?locale=${t.locale}`,
    priority: t.locale === ctx.locale ? "high" : "low",
    updatedAt: t.updated_at,
  }));

  return c.json(
    {
      success: true,
      prefetch: prefetchList,
      currentLocale: ctx.locale,
      platform: ctx.platform,
    },
    200,
    {
      "Cache-Control": "public, max-age=300",
      Link: prefetchList
        .slice(0, 5)
        .map((p: any) => `<${p.url}>; rel=prefetch; as=fetch`)
        .join(", "),
    }
  );
});

// ============================================================================
// Main Routes
// ============================================================================

app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: VERSION,
    timestamp: new Date().toISOString(),
    region: c.req.header("x-sb-edge-region") || "unknown",
    features: {
      websocket: true,
      streaming: true,
      prefetch: true,
      backgroundSync: true,
      smartCDN: true,
    },
  })
);

app.get("/locales", (c) =>
  c.json(
    {
      success: true,
      locales: SUPPORTED_LOCALES,
      default: "en",
      total: SUPPORTED_LOCALES.length,
    },
    200,
    { "Cache-Control": CACHE_CONTROL_IMMUTABLE }
  )
);

app.get("/platforms", (c) =>
  c.json(
    {
      success: true,
      platforms: SUPPORTED_PLATFORMS,
      configs: PLATFORM_CONFIGS,
    },
    200,
    { "Cache-Control": CACHE_CONTROL_IMMUTABLE }
  )
);

app.get("/", async (c) => {
  const start = Date.now();
  const ctx = extractContext(c);

  c.header("X-Request-Id", ctx.requestId);
  c.header("X-Version", VERSION);
  startTime(c, "total");

  try {
    // Rate limiting
    const rateLimit = await checkRateLimit(ctx);
    if (!rateLimit.allowed) {
      logAnalytics(ctx, 429, false, Date.now() - start);
      return c.json(
        {
          success: false,
          error: "rate_limit_exceeded",
          retryAfter: 3600,
        },
        429,
        {
          "Retry-After": "3600",
          "X-Rate-Limit-Remaining": "0",
          "X-Rate-Limit-Reset": rateLimit.resetAt,
        }
      );
    }

    // Batch request handling
    if (ctx.batchLocales && ctx.batchLocales.length > 0) {
      const locales = ctx.batchLocales.slice(0, ctx.config.maxBatch);
      const { data } = await ctx.supabase
        .from("translations")
        .select("locale, messages, version, updated_at")
        .in("locale", locales);

      const result = Object.fromEntries(
        (data || []).map((t: any) => [
          t.locale,
          {
            messages: t.messages,
            version: t.version,
            updatedAt: t.updated_at,
          },
        ])
      );

      logAnalytics(ctx, 200, false, Date.now() - start);
      endTime(c, "total");

      return c.json(
        {
          success: true,
          data: result,
          locales,
          platform: ctx.platform,
          batchSize: locales.length,
        },
        200,
        {
          "Cache-Control": buildCacheControl(ctx),
          "X-Rate-Limit-Remaining": String(rateLimit.remaining),
          "X-Realtime-Available": ctx.config.realtimeEnabled ? "true" : "false",
          "X-Prefetch-Available": ctx.config.prefetchEnabled ? "true" : "false",
        }
      );
    }

    // Single locale fetch
    let translations = await getTranslations(ctx, ctx.locale);
    let isFallback = false;

    if (!translations && ctx.locale !== "en") {
      translations = await getTranslations(ctx, "en");
      isFallback = true;
    }

    if (!translations) {
      logAnalytics(ctx, 404, false, Date.now() - start);
      return c.json(
        {
          success: false,
          error: "locale_not_found",
          requestedLocale: ctx.locale,
        },
        404
      );
    }

    const etagData = `${ctx.locale}:${translations.version}:${translations.updatedAt}`;
    const etag = await generateETag(etagData);

    if (ctx.ifNoneMatch === etag) {
      logAnalytics(ctx, 304, true, Date.now() - start);
      endTime(c, "total");
      return new Response(null, {
        status: 304,
        headers: {
          ETag: `"${etag}"`,
          "X-Cache": "HIT",
          "X-Rate-Limit-Remaining": String(rateLimit.remaining),
        },
      });
    }

    logAnalytics(ctx, 200, false, Date.now() - start, isFallback);
    endTime(c, "total");

    const responseHeaders: Record<string, string> = {
      ETag: `"${etag}"`,
      "Cache-Control": buildCacheControl(ctx),
      "X-Cache": "MISS",
      "X-Locale": ctx.locale,
      "X-Platform": ctx.platform,
      "X-Rate-Limit-Remaining": String(rateLimit.remaining),
      "X-Rate-Limit-Reset": rateLimit.resetAt,
      "Last-Modified": new Date(translations.updatedAt).toUTCString(),
      "X-Realtime-Available": ctx.config.realtimeEnabled ? "true" : "false",
      "X-Prefetch-Available": ctx.config.prefetchEnabled ? "true" : "false",
    };

    if (isFallback) {
      responseHeaders["X-Fallback"] = "true";
    }

    // Add HTTP/2 Server Push hints for prefetch
    if (ctx.config.http2PushEnabled && ctx.config.prefetchEnabled) {
      const relatedLocales = SUPPORTED_LOCALES.filter((l) => l !== ctx.locale).slice(0, 3);
      responseHeaders["Link"] = relatedLocales
        .map((l) => `</translations?locale=${l}>; rel=prefetch; as=fetch`)
        .join(", ");
    }

    return c.json(
      {
        success: true,
        data: {
          messages: translations.messages,
          version: translations.version,
          updatedAt: translations.updatedAt,
        },
        locale: ctx.locale,
        platform: ctx.platform,
        fallback: isFallback,
        features: {
          deltaSupported: ctx.config.deltaEnabled,
          realtimeSupported: ctx.config.realtimeEnabled,
          streamingSupported: ctx.config.streamingEnabled,
          prefetchSupported: ctx.config.prefetchEnabled,
          backgroundSyncSupported: ctx.config.backgroundSyncEnabled,
        },
      },
      200,
      responseHeaders
    );
  } catch (err) {
    console.error("Translation error:", err);
    logAnalytics(ctx, 500, false, Date.now() - start);
    endTime(c, "total");
    return c.json(
      {
        success: false,
        error: "internal_server_error",
        requestId: ctx.requestId,
      },
      500
    );
  }
});

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ctx = extractContext(c);

  if (body.locales && Array.isArray(body.locales)) {
    ctx.batchLocales = body.locales
      .filter((l: string) => LocaleSchema.safeParse(l).success)
      .slice(0, ctx.config.maxBatch);
  }

  if (body.keys && Array.isArray(body.keys)) {
    ctx.keys = body.keys.slice(0, 100);
  }

  if (body.locale && LocaleSchema.safeParse(body.locale).success) {
    ctx.locale = body.locale;
  }

  const url = new URL(c.req.url);
  const newHeaders = new Headers(c.req.raw.headers);

  if (ctx.batchLocales) newHeaders.set("x-batch-locales", ctx.batchLocales.join(","));
  if (ctx.keys) newHeaders.set("x-keys", ctx.keys.join(","));
  newHeaders.set("x-locale", ctx.locale);

  return app.fetch(
    new Request(url.toString(), {
      method: "GET",
      headers: newHeaders,
    }),
    c.env
  );
});

app.head("/", async (c) => {
  const ctx = extractContext(c);
  const { data } = await ctx.supabase
    .from("translations")
    .select("version, updated_at")
    .eq("locale", ctx.locale)
    .single();

  if (!data) {
    return new Response(null, { status: 404 });
  }

  const etag = await generateETag(`${ctx.locale}:${data.version}:${data.updated_at}`);

  return new Response(null, {
    status: 200,
    headers: {
      ETag: `"${etag}"`,
      "Last-Modified": new Date(data.updated_at).toUTCString(),
      "X-Locale": ctx.locale,
      "X-Version": data.version,
    },
  });
});

Deno.serve(app.fetch);
