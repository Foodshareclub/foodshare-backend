/**
 * Profile management service adapted for WhatsApp
 */

import { logger } from "../../_shared/logger.ts";
import type { Profile } from "../types/index.ts";
import { getSupabaseClient } from "./supabase.ts";

/**
 * Database error types for proper error handling
 */
export enum DatabaseErrorType {
  NOT_FOUND = "NOT_FOUND",
  TRANSIENT = "TRANSIENT",
  PERMANENT = "PERMANENT",
  UNKNOWN = "UNKNOWN",
}

/**
 * Classify database errors for proper handling
 */
function classifyError(error: { code?: string; message?: string }): DatabaseErrorType {
  const code = error.code || "";
  const message = (error.message || "").toLowerCase();

  if (code === "PGRST116" || message.includes("no rows")) {
    return DatabaseErrorType.NOT_FOUND;
  }

  if (
    code.startsWith("08") ||
    code.startsWith("53") ||
    code.startsWith("57") ||
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("network")
  ) {
    return DatabaseErrorType.TRANSIENT;
  }

  if (code.startsWith("22") || code.startsWith("23") || code.startsWith("42")) {
    return DatabaseErrorType.PERMANENT;
  }

  return DatabaseErrorType.UNKNOWN;
}

/**
 * Log database errors with context
 */
function logDatabaseError(
  operation: string,
  error: { code?: string; message?: string },
  context: Record<string, unknown> = {}
): void {
  const errorType = classifyError(error);
  const logContext = {
    errorType,
    errorCode: error.code,
    errorMessage: error.message,
    ...context,
  };

  if (errorType === DatabaseErrorType.TRANSIENT) {
    logger.warn(`Database ${operation} failed`, logContext);
  } else {
    logger.error(`Database ${operation} failed`, logContext);
  }
}

/**
 * Get profile by WhatsApp phone number
 */
export async function getProfileByWhatsAppPhone(phone: string): Promise<Profile | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("whatsapp_phone", phone)
    .single();

  if (error) {
    const errorType = classifyError(error);
    if (errorType !== DatabaseErrorType.NOT_FOUND) {
      logDatabaseError("getProfileByWhatsAppPhone", error, {
        phone: phone.substring(0, 4) + "***",
      });
    }
    return null;
  }

  return data as Profile;
}

/**
 * Get profile by email
 */
export async function getProfileByEmail(email: string): Promise<Profile | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("profiles").select("*").eq("email", email).single();

  if (error) {
    const errorType = classifyError(error);
    if (errorType !== DatabaseErrorType.NOT_FOUND) {
      logDatabaseError("getProfileByEmail", error, { email: email.substring(0, 3) + "***" });
    }
    return null;
  }

  return data as Profile;
}

/**
 * Check if profile requires email verification
 */
export function requiresEmailVerification(profile: Profile): boolean {
  return !profile.email_verified;
}

/**
 * Generate 6-digit verification code using cryptographically secure random
 */
export function generateVerificationCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  // Generate number between 100000 and 999999
  const code = 100000 + (array[0] % 900000);
  return code.toString();
}

/**
 * Create a new profile with WhatsApp phone
 */
export async function createProfile(data: {
  id: string;
  whatsapp_phone: string;
  first_name: string;
  nickname: string | null;
  email: string;
  verification_code: string;
  verification_code_expires_at: string;
}): Promise<Profile | null> {
  const supabase = getSupabaseClient();

  const { data: profile, error } = await supabase
    .from("profiles")
    .insert({
      ...data,
      email_verified: false,
    })
    .select()
    .single();

  if (error) {
    logDatabaseError("createProfile", error, {
      phone: data.whatsapp_phone.substring(0, 4) + "***",
    });
    return null;
  }

  return profile as Profile;
}

/**
 * Update an existing profile
 */
export async function updateProfile(
  profileId: string,
  updates: Partial<Profile>
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("profiles").update(updates).eq("id", profileId);

  if (error) {
    logDatabaseError("updateProfile", error, { profileId });
    return false;
  }

  return true;
}

/**
 * Link WhatsApp phone to existing profile
 */
export async function linkWhatsAppToProfile(
  profileId: string,
  whatsappPhone: string
): Promise<boolean> {
  return updateProfile(profileId, { whatsapp_phone: whatsappPhone } as Partial<Profile>);
}

/**
 * Get profile by ID
 */
export async function getProfileById(profileId: string): Promise<Profile | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.from("profiles").select("*").eq("id", profileId).single();

  if (error) {
    const errorType = classifyError(error);
    if (errorType !== DatabaseErrorType.NOT_FOUND) {
      logDatabaseError("getProfileById", error, { profileId });
    }
    return null;
  }

  return data as Profile;
}
