// Supabase Edge Function: get-server-key
// Returns the server's public encryption key for client-side encryption

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface ServerKeyConfig {
  publicKey: string;
  keyId: string;
  expiresAt: string;
  minAppVersion: string;
  algorithm: string;
}

serve(async (req) => {
  // CORS headers
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    // In production, fetch from secure key management service (KMS)
    // For now, use environment variable
    const publicKey = Deno.env.get("SERVER_PUBLIC_KEY");
    const keyId = Deno.env.get("SERVER_KEY_ID") || "prod-v1";

    if (!publicKey) {
      throw new Error("Server public key not configured");
    }

    const config: ServerKeyConfig = {
      publicKey,
      keyId,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
      minAppVersion: "3.0.0",
      algorithm: "X25519",
    };

    return new Response(
      JSON.stringify(config),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600", // Cache for 1 hour
        },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
