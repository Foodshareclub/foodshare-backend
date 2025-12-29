/**
 * Configuration and environment variables with validation
 */

/**
 * Get required environment variable with validation
 * @throws Error if the variable is missing or empty
 */
function requireEnv(name: string, fallbackName?: string): string {
  const value = Deno.env.get(name) || (fallbackName ? Deno.env.get(fallbackName) : undefined);
  if (!value || value.trim() === "") {
    const varNames = fallbackName ? `${name} or ${fallbackName}` : name;
    throw new Error(`Missing required environment variable: ${varNames}`);
  }
  return value.trim();
}

/**
 * Get optional environment variable with default
 */
function optionalEnv(name: string, defaultValue: string): string {
  const value = Deno.env.get(name);
  return value?.trim() || defaultValue;
}

/**
 * Validate URL format
 */
function validateUrl(url: string, name: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    throw new Error(`Invalid URL format for ${name}: ${url}`);
  }
}

// Core configuration with validation
export const BOT_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN", "BOT_TOKEN");
export const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
export const APP_URL = validateUrl(optionalEnv("APP_URL", "https://foodshare.club"), "APP_URL");
export const SUPABASE_URL = validateUrl(requireEnv("SUPABASE_URL"), "SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// Optional webhook secret for security (recommended in production)
export const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

// Configuration object for easy access
export const config = {
  botToken: BOT_TOKEN,
  telegramApi: TELEGRAM_API,
  appUrl: APP_URL,
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
  webhookSecret: WEBHOOK_SECRET,
  isProduction: Deno.env.get("DENO_ENV") === "production",
} as const;
