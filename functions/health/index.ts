/**
 * Health Monitoring Endpoint
 *
 * Enterprise-grade health monitoring for all Foodshare edge functions.
 *
 * Endpoints:
 * - GET /health - Quick system health (database check)
 * - GET /health?full=true - Full health with all services
 * - POST /health/check-functions - Check all edge functions
 * - POST /health/check-functions?quick=true - Quick check (skip slow functions)
 * - POST /health/check-function - Check specific function
 *
 * Cron: Run POST /health/check-functions every 5 minutes
 */

import { getHealthService, HEALTH_VERSION, FunctionHealthResult } from "../_shared/health/index.ts";
import { getCorsHeaders, handleCorsPrelight } from "../_shared/cors.ts";
import { logger } from "../_shared/logger.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return handleCorsPrelight(req);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/health\/?/, "").replace(/\/$/, "");

  try {
    const service = getHealthService();

    // GET /health or GET /health?full=true
    if (req.method === "GET") {
      const full = url.searchParams.get("full") === "true";

      if (full) {
        const result = await service.checkFullHealth();
        const httpStatus = result.status === "healthy" ? 200 : result.status === "degraded" ? 200 : 503;
        return new Response(JSON.stringify(result), {
          status: httpStatus,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await service.checkQuickHealth();
      const httpStatus = result.status === "ok" ? 200 : 503;
      return new Response(JSON.stringify(result), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /health/check-functions
    if (req.method === "POST" && (path === "check-functions" || path === "")) {
      const quick = url.searchParams.get("quick") === "true";
      const result = await service.checkAllFunctions(quick);
      const httpStatus = result.status === "healthy" ? 200 : result.status === "degraded" ? 200 : 503;
      return new Response(JSON.stringify(result), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /health/check-function
    if (req.method === "POST" && path === "check-function") {
      const body = await req.json();
      const functionName = body.function || body.name;

      if (!functionName) {
        return new Response(
          JSON.stringify({ error: "Missing 'function' parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const result = await service.checkSingleFunction(functionName);

      // Check if it's an error response
      if ("error" in result && !("status" in result)) {
        return new Response(JSON.stringify(result), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const healthResult = result as FunctionHealthResult;
      const httpStatus = healthResult.status === "healthy" ? 200 : healthResult.status === "degraded" ? 200 : 503;
      return new Response(JSON.stringify(result), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: "Not found",
        version: HEALTH_VERSION,
        availableEndpoints: [
          "GET /health - Quick health check",
          "GET /health?full=true - Full health with services",
          "POST /health/check-functions - Check all edge functions",
          "POST /health/check-functions?quick=true - Quick check (skip slow functions)",
          "POST /health/check-function - Check specific function",
        ],
      }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    logger.error("Health check failed", error instanceof Error ? error : { error });

    return new Response(
      JSON.stringify({
        status: "unhealthy",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
        version: HEALTH_VERSION,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
