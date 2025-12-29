import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Secure Cache Operation Edge Function
 *
 * Provides secure, proxied access to Upstash Redis for iOS/Android clients.
 * Credentials are stored in Supabase Vault and never exposed to clients.
 *
 * Features:
 * - Authentication required
 * - Rate limiting (60 requests/minute per user)
 * - Audit logging
 * - User-scoped cache keys
 * - Comprehensive error handling
 *
 * Security:
 * - Redis credentials fetched from Vault (service role only)
 * - All operations scoped to authenticated user
 * - Keys must be prefixed with user:{user_id}:
 * - Rate limiting prevents abuse
 */

interface CacheRequest {
  operation: "get" | "set" | "delete" | "incr" | "expire" | "exists" | "ttl";
  key: string;
  value?: string;
  ttl?: number; // Time to live in seconds
}

interface CacheResponse {
  success: boolean;
  operation: string;
  result: any;
  user_id?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
  status?: number;
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "authorization, x-client-info, apikey, content-type",
        },
      });
    }

    // =========================================================================
    // AUTHENTICATION
    // =========================================================================

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Unauthorized - No authorization header", 401);
    }

    // Initialize Supabase with service role key
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing Supabase environment variables");
      return errorResponse("Service configuration error", 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user authentication
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      token
    );

    if (authError || !user) {
      console.error("Authentication failed:", authError?.message);
      return errorResponse("Invalid authentication token", 401);
    }

    console.log(`Cache operation request from user: ${user.id}`);

    // =========================================================================
    // RATE LIMITING
    // =========================================================================

    const { data: withinLimit, error: rateLimitError } = await supabase.rpc(
      "check_rate_limit",
      {
        user_id: user.id,
        operation: "cache_operation",
        max_requests: 60,
        time_window_seconds: 60,
      }
    );

    if (rateLimitError) {
      console.error("Rate limit check failed:", rateLimitError);
      // Continue anyway - don't block legitimate requests due to rate limit check failure
    } else if (withinLimit === false) {
      console.warn(`Rate limit exceeded for user: ${user.id}`);
      return errorResponse(
        "Rate limit exceeded. Maximum 60 requests per minute.",
        429
      );
    }

    // =========================================================================
    // FETCH REDIS CREDENTIALS FROM VAULT
    // =========================================================================

    // Get request metadata for audit logging
    const requestMetadata = {
      ip_address: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown",
      user_agent: req.headers.get("user-agent") || "unknown",
      request_id: crypto.randomUUID(),
    };

    // Fetch Redis URL from Vault (audited)
    const { data: redisUrl, error: urlError } = await supabase.rpc(
      "get_secret_audited",
      {
        secret_name: "UPSTASH_REDIS_URL",
        requesting_user_id: user.id,
        request_metadata: requestMetadata,
      }
    );

    // Fetch Redis token from Vault (audited)
    const { data: redisToken, error: tokenError } = await supabase.rpc(
      "get_secret_audited",
      {
        secret_name: "UPSTASH_REDIS_TOKEN",
        requesting_user_id: user.id,
        request_metadata: requestMetadata,
      }
    );

    // Check for errors
    if (urlError || tokenError) {
      console.error("Failed to retrieve Redis credentials from Vault:", {
        urlError,
        tokenError,
      });
      return errorResponse(
        "Failed to retrieve cache service credentials",
        500
      );
    }

    if (!redisUrl || !redisToken) {
      console.error("Redis credentials are null");
      return errorResponse(
        "Cache service credentials not configured",
        500
      );
    }

    console.log("✅ Redis credentials retrieved from Vault");

    // =========================================================================
    // PARSE AND VALIDATE REQUEST
    // =========================================================================

    let payload: CacheRequest;
    try {
      payload = await req.json();
    } catch (error) {
      return errorResponse("Invalid JSON in request body", 400);
    }

    const { operation, key, value, ttl = 3600 } = payload;

    // Validate operation
    const validOperations = ["get", "set", "delete", "incr", "expire", "exists", "ttl"];
    if (!operation || !validOperations.includes(operation)) {
      return errorResponse(
        `Invalid operation. Must be one of: ${validOperations.join(", ")}`,
        400
      );
    }

    // Validate key
    if (!key || typeof key !== "string" || key.length === 0) {
      return errorResponse("Missing or invalid cache key", 400);
    }

    // Security: Ensure key is scoped to user to prevent cross-user access
    const userPrefix = `user:${user.id}:`;
    if (!key.startsWith(userPrefix)) {
      return errorResponse(
        `Invalid cache key. Must be scoped to user: ${userPrefix}`,
        403
      );
    }

    console.log(`Operation: ${operation}, Key: ${key}`);

    // =========================================================================
    // EXECUTE REDIS OPERATION
    // =========================================================================

    const redisHeaders = {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    };

    let result: any;

    try {
      switch (operation) {
        case "get": {
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["GET", key]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis GET failed: ${JSON.stringify(data)}`);
          }

          result = { value: data.result };
          break;
        }

        case "set": {
          if (value === undefined) {
            return errorResponse("Missing value for set operation", 400);
          }

          // Use SETEX to set with expiration
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["SETEX", key, ttl, value]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis SET failed: ${JSON.stringify(data)}`);
          }

          result = { success: data.result === "OK", ttl };
          break;
        }

        case "delete": {
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["DEL", key]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis DEL failed: ${JSON.stringify(data)}`);
          }

          result = { deleted: data.result };
          break;
        }

        case "incr": {
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["INCR", key]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis INCR failed: ${JSON.stringify(data)}`);
          }

          result = { value: data.result };
          break;
        }

        case "expire": {
          if (!ttl || ttl <= 0) {
            return errorResponse("Invalid TTL for expire operation", 400);
          }

          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["EXPIRE", key, ttl]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis EXPIRE failed: ${JSON.stringify(data)}`);
          }

          result = { success: data.result === 1, ttl };
          break;
        }

        case "exists": {
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["EXISTS", key]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis EXISTS failed: ${JSON.stringify(data)}`);
          }

          result = { exists: data.result === 1 };
          break;
        }

        case "ttl": {
          const response = await fetch(redisUrl, {
            method: "POST",
            headers: redisHeaders,
            body: JSON.stringify(["TTL", key]),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(`Redis TTL failed: ${JSON.stringify(data)}`);
          }

          // TTL returns:
          // - positive number: seconds until expiration
          // - -1: key exists but has no expiration
          // - -2: key does not exist
          result = { ttl: data.result };
          break;
        }

        default:
          return errorResponse("Invalid operation", 400);
      }
    } catch (error) {
      console.error("Redis operation failed:", error);
      return errorResponse(
        "Cache operation failed",
        500,
        error instanceof Error ? error.message : undefined
      );
    }

    // =========================================================================
    // SUCCESS RESPONSE
    // =========================================================================

    const response: CacheResponse = {
      success: true,
      operation,
      result,
      user_id: user.id,
    };

    console.log(`✅ Cache operation successful: ${operation}`);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Unexpected error in cache-operation:", error);
    return errorResponse(
      "Internal server error",
      500,
      error instanceof Error ? error.message : undefined
    );
  }
});

/**
 * Helper function to create error responses
 */
function errorResponse(
  message: string,
  status: number = 500,
  details?: string
): Response {
  const errorBody: ErrorResponse = {
    error: message,
    status,
  };

  if (details) {
    errorBody.details = details;
  }

  return new Response(JSON.stringify(errorBody), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
