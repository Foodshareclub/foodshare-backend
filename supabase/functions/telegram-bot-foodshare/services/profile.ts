/**
 * Profile management service with error classification
 */

import { logger } from "../../_shared/logger.ts";
import type { Profile } from "../types/index.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";

/**
 * Database error types for proper error handling
 */
export enum DatabaseErrorType {
  NOT_FOUND = "NOT_FOUND",
  TRANSIENT = "TRANSIENT", // Retryable errors (connection issues, timeouts)
  PERMANENT = "PERMANENT", // Non-retryable errors (constraint violations)
  UNKNOWN = "UNKNOWN",
}

export interface DatabaseResult<T> {
  data: T | null;
  error: {
    type: DatabaseErrorType;
    message: string;
    code?: string;
  } | null;
}

/**
 * Classify database errors for proper handling
 */
function classifyError(error: { code?: string; message?: string }): DatabaseErrorType {
  const code = error.code || "";
  const message = (error.message || "").toLowerCase();

  // Not found errors
  if (code === "PGRST116" || message.includes("no rows")) {
    return DatabaseErrorType.NOT_FOUND;
  }

  // Transient errors (retryable)
  if (
    code.startsWith("08") || // Connection errors
    code.startsWith("53") || // Insufficient resources
    code.startsWith("57") || // Operator intervention
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("network") ||
    message.includes("temporarily")
  ) {
    return DatabaseErrorType.TRANSIENT;
  }

  // Permanent errors (non-retryable)
  if (
    code.startsWith("22") || // Data exception
    code.startsWith("23") || // Integrity constraint violation
    code.startsWith("42") // Syntax error
  ) {
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
  context: Record<string, unknown> = {},
): void {
  const errorType = classifyError(error);
  const logFn = errorType === DatabaseErrorType.TRANSIENT ? logger.warn : logger.error;
  logFn(`Database ${operation} failed`, {
    errorType,
    errorCode: error.code,
    errorMessage: error.message,
    ...context,
  });
}

export async function getProfileByTelegramId(telegramId: number): Promise<Profile | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();

  if (error) {
    const errorType = classifyError(error);
    if (errorType !== DatabaseErrorType.NOT_FOUND) {
      logDatabaseError("getProfileByTelegramId", error, { telegramId });
    }
    return null;
  }

  return data as Profile;
}

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

export function requiresEmailVerification(profile: Profile): boolean {
  return !profile.email_verified;
}

export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function createProfile(data: {
  id: string;
  telegram_id: number;
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
    logDatabaseError("createProfile", error, { telegramId: data.telegram_id });
    return null;
  }

  return profile as Profile;
}

export async function updateProfile(
  profileId: string,
  updates: Partial<Profile>,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("profiles").update(updates).eq("id", profileId);

  if (error) {
    logDatabaseError("updateProfile", error, { profileId });
    return false;
  }

  return true;
}

export async function deleteProfile(profileId: string): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("profiles").delete().eq("id", profileId);

  if (error) {
    logDatabaseError("deleteProfile", error, { profileId });
    return false;
  }

  return true;
}
