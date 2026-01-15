import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function createSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// Deep merge helper
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge((result[key] as Record<string, unknown>) || {}, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createSupabaseClient();

  try {
    const body = await req.json();
    const { locale, updates } = body;

    if (!locale || !updates) {
      return new Response(JSON.stringify({
        success: false,
        error: "missing_params",
        message: "locale and updates are required"
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get current translations
    const { data: current, error: fetchError } = await supabase
      .from("translations")
      .select("id, messages, version")
      .eq("locale", locale)
      .single();

    if (fetchError || !current) {
      return new Response(JSON.stringify({
        success: false,
        error: "locale_not_found",
        message: `Locale '${locale}' not found`
      }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Merge updates
    const mergedMessages = deepMerge(current.messages as Record<string, unknown>, updates);
    const newVersion = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

    // Update database
    const { error: updateError } = await supabase
      .from("translations")
      .update({
        messages: mergedMessages,
        version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", current.id);

    if (updateError) {
      return new Response(JSON.stringify({
        success: false,
        error: "update_failed",
        message: updateError.message
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      locale,
      previousVersion: current.version,
      newVersion,
      keysUpdated: Object.keys(updates).length
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: "server_error",
      message: error instanceof Error ? error.message : String(error)
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
