/**
 * Supabase client service with connection pooling and timeout
 */

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@^2.47.10";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../config/index.ts";

const SUPABASE_TIMEOUT_MS = 8000; // 8 seconds

let supabaseClient: SupabaseClient | null = null;

/**
 * Custom fetch with timeout support
 */
function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);

  return fetch(input, {
    ...init,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
      db: { schema: "public" },
      global: {
        fetch: fetchWithTimeout,
      },
    });
  }

  return supabaseClient;
}
