import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    // Validate environment variables
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error(
        "Missing required environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Server configuration error: Missing required environment variables",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: secrets, error: secretsError } = await supabaseClient.rpc("get_secrets", {
      secret_names: [
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
        "UPSTASH_VECTOR_REST_URL",
        "UPSTASH_VECTOR_REST_TOKEN",
        "QSTASH_URL",
        "QSTASH_TOKEN",
        "UPSTASH_SEARCH_REST_URL",
        "UPSTASH_SEARCH_REST_TOKEN",
      ],
    });
    if (secretsError) {
      throw new Error(`Failed to fetch secrets: ${secretsError.message}`);
    }
    const results = [];
    // Check Redis with PING command
    try {
      const startTime = Date.now();
      const redisUrl = secrets.find((s) => s.name === "UPSTASH_REDIS_REST_URL")?.value;
      const redisToken = secrets.find((s) => s.name === "UPSTASH_REDIS_REST_TOKEN")?.value;
      const redisResponse = await fetch(`${redisUrl}/ping`, {
        headers: {
          Authorization: `Bearer ${redisToken}`,
        },
      });
      const redisData = await redisResponse.json();
      const responseTime = Date.now() - startTime;
      results.push({
        service: "Redis",
        status: redisData.result === "PONG" ? "ok" : "error",
        message: redisData.result === "PONG" ? "PING successful" : "Unexpected response",
        details: redisData,
        responseTime,
      });
    } catch (error) {
      results.push({
        service: "Redis",
        status: "error",
        message: error.message,
      });
    }
    // Check Vector with INFO command
    try {
      const startTime = Date.now();
      const vectorUrl = secrets.find((s) => s.name === "UPSTASH_VECTOR_REST_URL")?.value;
      const vectorToken = secrets.find((s) => s.name === "UPSTASH_VECTOR_REST_TOKEN")?.value;
      const vectorResponse = await fetch(`${vectorUrl}/info`, {
        headers: {
          Authorization: `Bearer ${vectorToken}`,
        },
      });
      const vectorData = await vectorResponse.json();
      const responseTime = Date.now() - startTime;
      results.push({
        service: "Vector",
        status: vectorResponse.ok && vectorData.result ? "ok" : "error",
        message: vectorResponse.ok
          ? `Vector DB ready (${vectorData.result?.vectorCount || 0} vectors)`
          : "Failed to get info",
        details: vectorData,
        responseTime,
      });
    } catch (error) {
      results.push({
        service: "Vector",
        status: "error",
        message: error.message,
      });
    }
    // Check QStash - list schedules to verify authentication and connectivity
    try {
      const startTime = Date.now();
      const qstashUrl = secrets.find((s) => s.name === "QSTASH_URL")?.value;
      const qstashToken = secrets.find((s) => s.name === "QSTASH_TOKEN")?.value;
      const qstashResponse = await fetch(`${qstashUrl}/v2/schedules`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${qstashToken}`,
        },
      });
      const responseTime = Date.now() - startTime;
      if (qstashResponse.ok) {
        const qstashData = await qstashResponse.json();
        results.push({
          service: "QStash",
          status: "ok",
          message: "QStash API accessible",
          details: {
            schedulesCount: qstashData.length || 0,
          },
          responseTime,
        });
      } else {
        const errorText = await qstashResponse.text();
        results.push({
          service: "QStash",
          status: "error",
          message: `HTTP ${qstashResponse.status}: ${errorText}`,
          responseTime,
        });
      }
    } catch (error) {
      results.push({
        service: "QStash",
        status: "error",
        message: error.message,
      });
    }
    // Check Workflow - list workflow logs
    try {
      const startTime = Date.now();
      const qstashUrl = secrets.find((s) => s.name === "QSTASH_URL")?.value;
      const qstashToken = secrets.find((s) => s.name === "QSTASH_TOKEN")?.value;
      // Workflow uses QStash credentials and API
      const workflowResponse = await fetch(`${qstashUrl}/v2/workflows/logs`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${qstashToken}`,
        },
      });
      const responseTime = Date.now() - startTime;
      if (workflowResponse.ok) {
        const workflowData = await workflowResponse.json();
        results.push({
          service: "Workflow",
          status: "ok",
          message: "Workflow API accessible",
          details: {
            runsCount: workflowData.runs?.length || 0,
          },
          responseTime,
        });
      } else {
        const errorText = await workflowResponse.text();
        results.push({
          service: "Workflow",
          status: "error",
          message: `HTTP ${workflowResponse.status}: ${errorText}`,
          responseTime,
        });
      }
    } catch (error) {
      results.push({
        service: "Workflow",
        status: "error",
        message: error.message,
      });
    }
    // Check Search with INFO command
    try {
      const startTime = Date.now();
      const searchUrl = secrets.find((s) => s.name === "UPSTASH_SEARCH_REST_URL")?.value;
      const searchToken = secrets.find((s) => s.name === "UPSTASH_SEARCH_REST_TOKEN")?.value;
      const searchResponse = await fetch(`${searchUrl}/info`, {
        headers: {
          Authorization: `Bearer ${searchToken}`,
        },
      });
      const searchData = await searchResponse.json();
      const responseTime = Date.now() - startTime;
      results.push({
        service: "Search",
        status: searchResponse.ok && searchData.result ? "ok" : "error",
        message: searchResponse.ok
          ? `Search ready (${searchData.result?.vectorCount || 0} vectors)`
          : "Failed to get info",
        details: searchData,
        responseTime,
      });
    } catch (error) {
      results.push({
        service: "Search",
        status: "error",
        message: error.message,
      });
    }
    const allOk = results.every((r) => r.status === "ok");
    const avgResponseTime =
      results.filter((r) => r.responseTime).reduce((sum, r) => sum + (r.responseTime || 0), 0) /
      results.filter((r) => r.responseTime).length;
    return new Response(
      JSON.stringify({
        success: allOk,
        timestamp: new Date().toISOString(),
        summary: {
          total: results.length,
          healthy: results.filter((r) => r.status === "ok").length,
          unhealthy: results.filter((r) => r.status === "error").length,
          avgResponseTime: Math.round(avgResponseTime),
        },
        results,
      }),
      {
        status: allOk ? 200 : 500,
        headers: {
          "Content-Type": "application/json",
          Connection: "keep-alive",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
});
