import { getAdminClient } from "./supabase.ts";
import { logger } from "./logger.ts";

/**
 * Secret interface from vault.secrets
 */
export interface VaultSecret {
  id: string;
  name: string;
  description: string;
  secret: string;
  key_id: string;
  nonce: Uint8Array;
  created_at: string;
  updated_at: string;
}

const cache = new Map<string, string>();
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a secret from the Supabase Vault.
 * Falls back to Deno.env if the secret is not found in the Vault.
 */
export async function getSecret(name: string): Promise<string | undefined> {
  // Check cache first
  if (cache.has(name) && (Date.now() - lastFetch < CACHE_TTL)) {
    return cache.get(name);
  }

  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("secrets")
      .select("secret")
      .eq("name", name)
      .schema("vault")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        // Not found in Vault, fall back to environment variable
        const envVal = Deno.env.get(name);
        if (envVal) {
          cache.set(name, envVal);
          return envVal;
        }
        return undefined;
      }
      throw error;
    }

    if (data?.secret) {
      cache.set(name, data.secret);
      return data.secret;
    }
  } catch (err) {
    logger.error("Failed to fetch secret from Vault", { name, error: err });
    // Emergency fallback to Deno.env
    return Deno.env.get(name);
  }

  return Deno.env.get(name);
}

/**
 * Pre-load all secrets from the Vault into cache.
 * Useful at startup to avoid multiple queries.
 */
export async function loadAllSecrets(): Promise<void> {
  try {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("secrets")
      .select("name, secret")
      .schema("vault");

    if (error) throw error;

    if (data) {
      for (const item of data) {
        if (item.name && item.secret) {
          cache.set(item.name, item.secret);
        }
      }
      lastFetch = Date.now();
      logger.info("Vault secrets loaded into cache", { count: data.length });
    }
  } catch (err) {
    logger.error("Failed to load all secrets from Vault", { error: err });
  }
}
