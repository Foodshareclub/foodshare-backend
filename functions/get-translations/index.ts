import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "4.1.0";
const SUPPORTED_LOCALES = ["en","cs","de","es","fr","pt","ru","uk","zh","hi","ar","it","pl","nl","ja","ko","tr"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-locale, x-version, x-platform, if-none-match",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "etag, x-version, x-locale, x-delta-available",
};

function createSupabaseClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function generateETag(data: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace("/get-translations", "");
  const supabase = createSupabaseClient();

  // Health check
  if (path === "/health" || path === "/get-translations/health") {
    return new Response(JSON.stringify({
      status: "ok",
      version: VERSION,
      timestamp: new Date().toISOString(),
      features: { deltaSync: true, prefetch: true }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Locales list
  if (path === "/locales") {
    return new Response(JSON.stringify({ success: true, locales: SUPPORTED_LOCALES, default: "en" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }
    });
  }

  // Delta sync endpoint
  if (path === "/delta") {
    const locale = url.searchParams.get("locale") || req.headers.get("x-locale") || "en";
    const sinceVersion = url.searchParams.get("since") || req.headers.get("x-version");

    if (!sinceVersion) {
      return new Response(JSON.stringify({ success: false, error: "missing_version", message: "Provide 'since' query param or X-Version header" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { data: currentData, error: currentError } = await supabase
      .from("translations").select("messages, version, updated_at").eq("locale", locale).single();

    if (currentError || !currentData) {
      return new Response(JSON.stringify({ success: false, error: "locale_not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (currentData.version === sinceVersion) {
      return new Response(JSON.stringify({
        success: true, hasChanges: false, locale, currentVersion: currentData.version, sinceVersion,
        delta: { added: {}, updated: {}, deleted: [] }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Delta-Available": "false" } });
    }

    // Query change log
    const { data: changes, error: changesError } = await supabase
      .from("translation_change_log")
      .select("key_path, old_value, new_value, change_type, version")
      .eq("locale", locale)
      .gt("version", sinceVersion)
      .order("created_at", { ascending: true });

    if (changesError || !changes || changes.length === 0) {
      // Fallback to full sync
      return new Response(JSON.stringify({
        success: true, hasChanges: true, fullSync: true, locale, currentVersion: currentData.version, sinceVersion,
        data: { messages: currentData.messages, version: currentData.version, updatedAt: currentData.updated_at }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Full-Sync": "true" } });
    }

    const delta: { added: Record<string, string>; updated: Record<string, { old: string | null; new: string }>; deleted: string[] } = { added: {}, updated: {}, deleted: [] };
    const keyStates = new Map<string, { type: string; oldValue: string | null; newValue: string | null }>();

    for (const change of changes) {
      const existing = keyStates.get(change.key_path);
      if (!existing) {
        keyStates.set(change.key_path, { type: change.change_type, oldValue: change.old_value, newValue: change.new_value });
      } else {
        if (change.change_type === "delete") {
          keyStates.set(change.key_path, { type: existing.type === "add" ? "noop" : "delete", oldValue: existing.oldValue, newValue: null });
        } else {
          keyStates.set(change.key_path, { type: existing.type === "add" ? "add" : "update", oldValue: existing.oldValue, newValue: change.new_value });
        }
      }
    }

    for (const [key, state] of keyStates) {
      if (state.type === "noop") continue;
      if (state.type === "add" && state.newValue !== null) delta.added[key] = state.newValue;
      else if (state.type === "update" && state.newValue !== null) delta.updated[key] = { old: state.oldValue, new: state.newValue };
      else if (state.type === "delete") delta.deleted.push(key);
    }

    const hasChanges = Object.keys(delta.added).length > 0 || Object.keys(delta.updated).length > 0 || delta.deleted.length > 0;

    return new Response(JSON.stringify({
      success: true, hasChanges, locale, currentVersion: currentData.version, sinceVersion, updatedAt: currentData.updated_at, delta,
      stats: { added: Object.keys(delta.added).length, updated: Object.keys(delta.updated).length, deleted: delta.deleted.length }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Delta-Available": hasChanges ? "true" : "false" } });
  }

  // Prefetch endpoint
  if (path === "/prefetch") {
    const { data } = await supabase.from("translations").select("locale, version, updated_at").order("updated_at", { ascending: false });
    const prefetchList = (data || []).map((t: any) => ({ locale: t.locale, version: t.version, updatedAt: t.updated_at }));
    return new Response(JSON.stringify({ success: true, prefetch: prefetchList }), {
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });
  }

  // Main translations endpoint
  const locale = url.searchParams.get("locale") || req.headers.get("x-locale") || "en";
  const normalizedLocale = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  const ifNoneMatch = req.headers.get("if-none-match")?.replace(/"/g, "");

  const { data, error } = await supabase
    .from("translations").select("messages, version, updated_at").eq("locale", normalizedLocale).single();

  if (error || !data) {
    // Fallback to English
    const { data: fallback } = await supabase.from("translations").select("messages, version, updated_at").eq("locale", "en").single();
    if (!fallback) {
      return new Response(JSON.stringify({ success: false, error: "locale_not_found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const etag = await generateETag(`en:${fallback.version}:${fallback.updated_at}`);
    return new Response(JSON.stringify({
      success: true, data: { messages: fallback.messages, version: fallback.version, updatedAt: fallback.updated_at },
      locale: "en", fallback: true, features: { deltaSupported: true }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json", "ETag": `"${etag}"`, "X-Fallback": "true" } });
  }

  const etag = await generateETag(`${normalizedLocale}:${data.version}:${data.updated_at}`);

  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ...corsHeaders, "ETag": `"${etag}"` } });
  }

  return new Response(JSON.stringify({
    success: true, data: { messages: data.messages, version: data.version, updatedAt: data.updated_at },
    locale: normalizedLocale, fallback: false, features: { deltaSupported: true }
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json", "ETag": `"${etag}"`, "Cache-Control": "public, max-age=3600", "X-Version": VERSION, "X-Locale": normalizedLocale }
  });
});
