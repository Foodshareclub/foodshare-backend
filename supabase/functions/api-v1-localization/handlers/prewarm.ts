/**
 * Prewarm Translation Cache Handler
 *
 * Proxies prewarm requests to translation server to pre-populate Redis cache.
 * Fire-and-forget pattern - returns immediately, translation happens async.
 *
 * Usage:
 * POST /localization/prewarm
 * {
 *   "texts": ["Fresh apples", "Organic vegetables"],
 *   "languages": ["es", "ru", "de"],
 *   "domain": "food"  // optional, defaults to "food"
 * }
 */

const TRANSLATE_API = Deno.env.get("LLM_TRANSLATION_ENDPOINT") ||
  "https://translate.foodshare.club";
const TRANSLATE_API_KEY = Deno.env.get("LLM_TRANSLATION_API_KEY") || "";
const CF_ACCESS_CLIENT_ID = Deno.env.get("CF_ACCESS_CLIENT_ID") || "";
const CF_ACCESS_CLIENT_SECRET = Deno.env.get("CF_ACCESS_CLIENT_SECRET") || "";

interface PrewarmRequest {
  texts: string[];
  languages: string[];
  domain?: string;
}

interface PrewarmResponse {
  accepted: boolean;
  textsCount: number;
  languages: string[];
  estimatedTimeSeconds?: number;
}

export default async function prewarmHandler(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Method not allowed. Use POST.",
      }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const body: PrewarmRequest = await req.json();
    const { texts, languages, domain = "food" } = body;

    // Validate input
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "texts array is required and must not be empty",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!languages || !Array.isArray(languages) || languages.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "languages array is required and must not be empty",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Fire-and-forget prewarm request to translation server
    // This will queue translations in the background
    fetch(`${TRANSLATE_API}/api/translate/prewarm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": TRANSLATE_API_KEY,
        "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET,
      },
      body: JSON.stringify({ texts, languages, domain }),
    }).catch((error) => {
      // Log but don't fail - fire and forget
      logger.warn("Prewarm request failed", { error: error.message });
    });

    const response: PrewarmResponse = {
      accepted: true,
      textsCount: texts.length,
      languages,
      estimatedTimeSeconds: texts.length * languages.length * 10, // ~10s per translation
    };

    logger.info("Prewarm request accepted", {
      textsCount: texts.length,
      languages,
      domain,
    });

    return new Response(JSON.stringify(response), {
      status: 202, // Accepted
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    logger.error("Prewarm error", error as Error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
