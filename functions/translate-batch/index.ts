import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "1.0.0";
const MAX_KEYS_PER_BATCH = 50;

const LOCALE_NAMES: Record<string, string> = {
  cs: "Czech",
  de: "German",
  es: "Spanish",
  fr: "French",
  pt: "Portuguese",
  ru: "Russian",
  uk: "Ukrainian",
  zh: "Chinese (Simplified)",
  hi: "Hindi",
  ar: "Arabic",
  it: "Italian",
  pl: "Polish",
  nl: "Dutch",
  ja: "Japanese",
  ko: "Korean",
  tr: "Turkish",
  sv: "Swedish",
  vi: "Vietnamese",
  id: "Indonesian",
  th: "Thai",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function createSupabaseClient() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Translate using OpenAI
async function translateWithOpenAI(
  keys: Record<string, string>,
  targetLocale: string,
  openaiApiKey: string
): Promise<Record<string, string>> {
  const languageName = LOCALE_NAMES[targetLocale] || targetLocale;

  const prompt = `You are a professional translator for a food sharing mobile app called "Foodshare".
Translate the following UI strings from English to ${languageName}.

Rules:
1. Keep the translations natural and appropriate for a mobile app UI
2. Preserve any placeholders like {name}, {count}, {time} exactly as they are
3. Keep brand names like "Foodshare" unchanged
4. For very short strings (1-2 words), keep the translation concise
5. Return ONLY a valid JSON object with the same keys but translated values
6. Do not add any explanation or markdown

Input JSON:
${JSON.stringify(keys, null, 2)}

Return the translated JSON:`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content || "{}";

  // Parse JSON from response (handle potential markdown code blocks)
  let cleanContent = content.trim();
  if (cleanContent.startsWith("```json")) {
    cleanContent = cleanContent.slice(7);
  }
  if (cleanContent.startsWith("```")) {
    cleanContent = cleanContent.slice(3);
  }
  if (cleanContent.endsWith("```")) {
    cleanContent = cleanContent.slice(0, -3);
  }

  try {
    return JSON.parse(cleanContent.trim());
  } catch {
    console.error("Failed to parse OpenAI response:", cleanContent);
    throw new Error("Failed to parse translation response as JSON");
  }
}

// Convert flat dot-notation keys to nested object for update
function unflattenObject(flat: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [flatKey, value] of Object.entries(flat)) {
    const parts = flatKey.split(".");
    let current: Record<string, unknown> = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  return result;
}

// Deep merge two objects
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(
        (result[key] as Record<string, unknown>) || {},
        value as Record<string, unknown>
      );
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

  // Get OpenAI API key from environment variable (set via supabase secrets)
  // or from Supabase Vault (decrypted_secrets view)
  let openaiApiKey = Deno.env.get("OPENAI_API_KEY");

  if (!openaiApiKey) {
    // Try Supabase Vault as fallback
    const { data: vaultData } = await supabase
      .from("decrypted_secrets")
      .select("decrypted_secret")
      .eq("name", "OPENAI_API_KEY")
      .single();
    openaiApiKey = vaultData?.decrypted_secret;
  }

  if (!openaiApiKey) {
    return new Response(JSON.stringify({
      success: false,
      error: "missing_api_key",
      message: "OPENAI_API_KEY not found in Vault or environment"
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json();
    const { locale, keys, apply = false, category } = body;

    if (!locale) {
      return new Response(JSON.stringify({
        success: false,
        error: "missing_locale",
        message: "locale is required"
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (!LOCALE_NAMES[locale]) {
      return new Response(JSON.stringify({
        success: false,
        error: "unsupported_locale",
        message: `Locale '${locale}' not supported. Supported: ${Object.keys(LOCALE_NAMES).join(", ")}`
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // If keys not provided, fetch from audit endpoint
    let keysToTranslate = keys as Record<string, string>;

    if (!keysToTranslate || Object.keys(keysToTranslate).length === 0) {
      // Fetch untranslated keys from audit
      const auditUrl = new URL(req.url);
      auditUrl.pathname = "/functions/v1/translation-audit";
      auditUrl.search = `?locale=${locale}&limit=${MAX_KEYS_PER_BATCH}${category ? `&category=${category}` : ""}`;

      const auditResponse = await fetch(auditUrl.toString());
      const auditData = await auditResponse.json();

      if (!auditData.success || !auditData.untranslated) {
        return new Response(JSON.stringify({
          success: false,
          error: "audit_failed",
          message: "Could not fetch untranslated keys from audit",
          auditData
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      keysToTranslate = {};
      for (const item of auditData.untranslated) {
        keysToTranslate[item.key] = item.englishValue;
      }
    }

    const keyCount = Object.keys(keysToTranslate).length;

    if (keyCount === 0) {
      return new Response(JSON.stringify({
        success: true,
        locale,
        message: "No keys to translate",
        translated: 0
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Limit batch size
    if (keyCount > MAX_KEYS_PER_BATCH) {
      const limitedKeys: Record<string, string> = {};
      let count = 0;
      for (const [key, value] of Object.entries(keysToTranslate)) {
        if (count >= MAX_KEYS_PER_BATCH) break;
        limitedKeys[key] = value;
        count++;
      }
      keysToTranslate = limitedKeys;
    }

    // Translate using OpenAI
    const translations = await translateWithOpenAI(keysToTranslate, locale, openaiApiKey);

    // Apply to database if requested
    if (apply) {
      // Get current translations
      const { data: current, error: fetchError } = await supabase
        .from("translations")
        .select("id, messages")
        .eq("locale", locale)
        .single();

      if (fetchError || !current) {
        return new Response(JSON.stringify({
          success: false,
          error: "locale_not_found",
          message: `Could not fetch current translations for locale '${locale}'`,
          translations // Return translations even if apply failed
        }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Convert flat translations to nested and merge
      const nestedTranslations = unflattenObject(translations);
      const mergedMessages = deepMerge(current.messages as Record<string, unknown>, nestedTranslations);
      const version = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

      // Update database
      const { error: updateError } = await supabase
        .from("translations")
        .update({
          messages: mergedMessages,
          version,
          updated_at: new Date().toISOString(),
        })
        .eq("id", current.id);

      if (updateError) {
        return new Response(JSON.stringify({
          success: false,
          error: "update_failed",
          message: updateError.message,
          translations
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        version: VERSION,
        locale,
        translated: Object.keys(translations).length,
        applied: true,
        newVersion: version,
        translations
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Return translations without applying
    return new Response(JSON.stringify({
      success: true,
      version: VERSION,
      locale,
      translated: Object.keys(translations).length,
      applied: false,
      translations
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: "translation_failed",
      message: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
