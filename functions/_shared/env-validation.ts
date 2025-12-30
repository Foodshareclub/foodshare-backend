/**
 * Environment Variable Validation Utility
 *
 * Provides startup validation for required environment variables.
 * Prevents silent failures from missing configuration.
 *
 * @module env-validation
 */

import { logger } from "./logger.ts";

export interface EnvConfig {
  /** Variable name */
  name: string;
  /** Whether the variable is required (default: true) */
  required?: boolean;
  /** Default value if not set */
  defaultValue?: string;
  /** Custom validator function */
  validate?: (value: string) => boolean;
  /** Error message for validation failure */
  errorMessage?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  values: Record<string, string>;
}

/**
 * Common environment variable groups for different function types
 */
export const ENV_GROUPS = {
  /** Core Supabase variables (required by most functions) */
  SUPABASE_CORE: [
    { name: "SUPABASE_URL", required: true },
    { name: "SUPABASE_SERVICE_ROLE_KEY", required: true },
  ],

  /** Auth-related (for user-facing functions) */
  SUPABASE_AUTH: [
    { name: "SUPABASE_URL", required: true },
    { name: "SUPABASE_ANON_KEY", required: true },
  ],

  /** iOS push notifications */
  APNS: [
    { name: "APPLE_TEAM_ID", required: true },
    { name: "APP_BUNDLE_ID", required: true },
    { name: "APNS_KEY_ID", required: true },
    { name: "APNS_PRIVATE_KEY", required: true },
  ],

  /** Android push notifications */
  FCM: [
    { name: "FCM_PROJECT_ID", required: true },
    { name: "FCM_CLIENT_EMAIL", required: true },
    { name: "FCM_PRIVATE_KEY", required: true },
  ],

  /** Web push notifications */
  VAPID: [
    { name: "VAPID_PUBLIC_KEY", required: true },
    { name: "VAPID_PRIVATE_KEY", required: true },
  ],

  /** Email providers */
  EMAIL: [
    { name: "RESEND_API_KEY", required: false },
    { name: "BREVO_API_KEY", required: false },
    { name: "MAILERSEND_API_KEY", required: false },
    { name: "AWS_ACCESS_KEY_ID", required: false },
    { name: "AWS_SECRET_ACCESS_KEY", required: false },
  ],

  /** WhatsApp bot */
  WHATSAPP: [
    { name: "WHATSAPP_ACCESS_TOKEN", required: true },
    { name: "WHATSAPP_PHONE_NUMBER_ID", required: true },
    { name: "WHATSAPP_VERIFY_TOKEN", required: true },
    { name: "WHATSAPP_APP_SECRET", required: true },
  ],

  /** Telegram bot */
  TELEGRAM: [
    { name: "TELEGRAM_BOT_TOKEN", required: true },
  ],
} as const;

/**
 * Validate environment variables
 *
 * @example
 * ```typescript
 * const result = validateEnv([
 *   { name: "SUPABASE_URL", required: true },
 *   { name: "API_KEY", required: true, validate: (v) => v.length >= 32 },
 * ]);
 *
 * if (!result.valid) {
 *   throw new Error(`Missing env vars: ${result.errors.join(", ")}`);
 * }
 * ```
 */
export function validateEnv(configs: EnvConfig[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: Record<string, string> = {};

  for (const config of configs) {
    const value = Deno.env.get(config.name);
    const required = config.required !== false;

    if (!value && !config.defaultValue) {
      if (required) {
        errors.push(`Missing required environment variable: ${config.name}`);
      } else {
        warnings.push(`Optional environment variable not set: ${config.name}`);
      }
      continue;
    }

    const finalValue = value || config.defaultValue || "";
    values[config.name] = finalValue;

    // Run custom validator if provided
    if (config.validate && !config.validate(finalValue)) {
      errors.push(
        config.errorMessage ||
          `Invalid value for environment variable: ${config.name}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    values,
  };
}

/**
 * Validate environment variables and throw if invalid
 *
 * @example
 * ```typescript
 * // At function startup
 * const env = requireEnv([...ENV_GROUPS.SUPABASE_CORE]);
 * // env.SUPABASE_URL is guaranteed to be defined
 * ```
 */
export function requireEnv(
  configs: EnvConfig[]
): Record<string, string> {
  const result = validateEnv(configs);

  if (result.warnings.length > 0) {
    logger.warn("Environment warnings", { warnings: result.warnings });
  }

  if (!result.valid) {
    logger.error("Environment validation failed", { errors: result.errors });
    throw new Error(`Environment validation failed: ${result.errors.join("; ")}`);
  }

  return result.values;
}

/**
 * Check if at least one of the given variables is set
 *
 * @example
 * ```typescript
 * // Ensure at least one email provider is configured
 * requireOneOf(["RESEND_API_KEY", "BREVO_API_KEY", "AWS_ACCESS_KEY_ID"]);
 * ```
 */
export function requireOneOf(names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name);
    if (value) {
      return name;
    }
  }

  throw new Error(
    `At least one of these environment variables must be set: ${names.join(", ")}`
  );
}

/**
 * Get environment variable with fallback
 */
export function getEnv(name: string, defaultValue?: string): string {
  return Deno.env.get(name) || defaultValue || "";
}

/**
 * Get required environment variable (throws if missing)
 */
export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Required environment variable not set: ${name}`);
  }
  return value;
}

/**
 * Parse boolean environment variable
 */
export function getBoolEnv(name: string, defaultValue = false): boolean {
  const value = Deno.env.get(name)?.toLowerCase();
  if (!value) return defaultValue;
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Parse integer environment variable
 */
export function getIntEnv(name: string, defaultValue: number): number {
  const value = Deno.env.get(name);
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}
