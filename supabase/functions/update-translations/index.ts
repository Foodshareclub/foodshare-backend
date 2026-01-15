import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { locale, translations } = await req.json();

    if (!locale || !translations) {
      return new Response(
        JSON.stringify({ error: "locale and translations required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get current messages
    const { data: current, error: fetchError } = await supabase
      .from("translations")
      .select("id, messages")
      .eq("locale", locale)
      .single();

    if (fetchError) throw fetchError;

    // Merge translations
    const updatedMessages = { ...current.messages, ...translations };
    const version = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

    // Update
    const { error: updateError } = await supabase
      .from("translations")
      .update({
        messages: updatedMessages,
        version,
        updated_at: new Date().toISOString(),
      })
      .eq("id", current.id);

    if (updateError) throw updateError;

    const addedCount = Object.keys(translations).length;
    const totalCount = Object.keys(updatedMessages).length;

    return new Response(
      JSON.stringify({
        success: true,
        locale,
        added: addedCount,
        total: totalCount,
        version,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
