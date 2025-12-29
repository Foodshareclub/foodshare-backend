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

// WhatsApp Cloud API configuration
export const WHATSAPP_ACCESS_TOKEN = requireEnv("WHATSAPP_ACCESS_TOKEN");
export const WHATSAPP_PHONE_NUMBER_ID = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
export const WHATSAPP_VERIFY_TOKEN = requireEnv("WHATSAPP_VERIFY_TOKEN");
export const WHATSAPP_BUSINESS_ACCOUNT_ID = optionalEnv("WHATSAPP_BUSINESS_ACCOUNT_ID", "");
export const WHATSAPP_APP_SECRET = optionalEnv("WHATSAPP_APP_SECRET", "");

// WhatsApp API base URL
export const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}`;

// Core configuration
export const APP_URL = validateUrl(optionalEnv("APP_URL", "https://foodshare.club"), "APP_URL");
export const SUPABASE_URL = validateUrl(requireEnv("SUPABASE_URL"), "SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// Configuration object for easy access
export const config = {
  whatsapp: {
    accessToken: WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: WHATSAPP_VERIFY_TOKEN,
    businessAccountId: WHATSAPP_BUSINESS_ACCOUNT_ID,
    appSecret: WHATSAPP_APP_SECRET,
    apiUrl: WHATSAPP_API_URL,
  },
  appUrl: APP_URL,
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
  isProduction: Deno.env.get("DENO_ENV") === "production",
} as const;
