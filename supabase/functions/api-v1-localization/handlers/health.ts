/**
 * Health Check Handler
 * Returns comprehensive health status for the translation service
 */

import { llmTranslationService } from "../services/llm-translation.ts";

export default async function healthHandler(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    // Get comprehensive health status
    const health = await llmTranslationService.checkHealth();

    // Determine HTTP status based on health
    let httpStatus = 200;
    if (health.status === "UNHEALTHY") {
      httpStatus = 503; // Service Unavailable
    } else if (health.status === "DEGRADED") {
      httpStatus = 200; // Still OK but degraded
    }

    return new Response(
      JSON.stringify(health, null, 2),
      {
        status: httpStatus,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      },
    );
  } catch (error) {
    logger.error("Health check error", error as Error);
    return new Response(
      JSON.stringify({
        status: "UNHEALTHY",
        timestamp: new Date().toISOString(),
        error: (error as Error).message,
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
