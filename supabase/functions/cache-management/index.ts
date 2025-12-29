import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

interface CacheOperation {
  operation: "get" | "set" | "delete" | "clear";
  key?: string;
  value?: any;
  ttl?: number; // Time to live in seconds
  pattern?: string; // For batch operations
}

Deno.serve(async (req: Request) => {
  try {
    // CORS headers
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get Upstash Redis credentials from Supabase Vault
    const { data: redisUrl, error: urlError } = await supabase.rpc(
      "get_upstash_redis_url"
    );
    const { data: redisToken, error: tokenError } = await supabase.rpc(
      "get_upstash_redis_token"
    );

    if (urlError || tokenError || !redisUrl || !redisToken) {
      console.error("Error retrieving Upstash credentials");
      return new Response(
        JSON.stringify({ error: "Failed to retrieve cache service credentials" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const payload: CacheOperation = await req.json();
    const { operation, key, value, ttl = 3600, pattern } = payload;

    // Validate operation
    if (!operation) {
      return new Response(
        JSON.stringify({ error: "Missing operation" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    let result: any;

    // Execute cache operation using Upstash Redis REST API
    const upstashHeaders = {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    };

    switch (operation) {
      case "get": {
        if (!key) {
          return new Response(
            JSON.stringify({ error: "Missing key for get operation" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const response = await fetch(`${redisUrl}/get/${key}`, {
          headers: upstashHeaders,
        });
        const data = await response.json();
        result = { value: data.result };
        break;
      }

      case "set": {
        if (!key || value === undefined) {
          return new Response(
            JSON.stringify({ error: "Missing key or value for set operation" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Serialize value if it's an object
        const serializedValue = typeof value === "object"
          ? JSON.stringify(value)
          : value;

        const response = await fetch(`${redisUrl}/setex/${key}/${ttl}/${encodeURIComponent(serializedValue)}`, {
          headers: upstashHeaders,
        });
        const data = await response.json();
        result = { success: data.result === "OK", ttl };
        break;
      }

      case "delete": {
        if (!key) {
          return new Response(
            JSON.stringify({ error: "Missing key for delete operation" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        const response = await fetch(`${redisUrl}/del/${key}`, {
          headers: upstashHeaders,
        });
        const data = await response.json();
        result = { deleted: data.result };
        break;
      }

      case "clear": {
        if (!pattern) {
          return new Response(
            JSON.stringify({ error: "Missing pattern for clear operation" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Get keys matching pattern
        const keysResponse = await fetch(`${redisUrl}/keys/${pattern}`, {
          headers: upstashHeaders,
        });
        const keysData = await keysResponse.json();
        const keys = keysData.result;

        if (keys && keys.length > 0) {
          // Delete all matching keys
          const deletePromises = keys.map((k: string) =>
            fetch(`${redisUrl}/del/${k}`, { headers: upstashHeaders })
          );
          await Promise.all(deletePromises);
          result = { cleared: keys.length };
        } else {
          result = { cleared: 0 };
        }
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: "Invalid operation" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
    }

    return new Response(
      JSON.stringify({
        success: true,
        operation,
        result,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error in cache-management:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
