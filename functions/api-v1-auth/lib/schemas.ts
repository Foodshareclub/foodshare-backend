/**
 * Auth API Zod schemas
 *
 * Rate schemas migrated from api-v1-login-rate.
 * Verify schemas are new for email verification endpoints.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Rate Schemas
// =============================================================================

export const rateCheckSchema = z.object({
  email: z.string().email(),
  ipAddress: z.string().ip().optional(),
});

export const rateRecordSchema = z.object({
  email: z.string().email(),
  ipAddress: z.string().ip().optional(),
  userAgent: z.string().optional(),
  appPlatform: z.enum(["ios", "android", "web"]).optional(),
  appVersion: z.string().optional(),
  success: z.boolean(),
  failureReason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// =============================================================================
// Verify Schemas
// =============================================================================

export const verifySendSchema = z.object({
  email: z.string().email(),
});

export const verifyConfirmSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6).regex(/^\d{6}$/, "Code must be 6 digits"),
});

export const verifyResendSchema = z.object({
  email: z.string().email(),
});

// =============================================================================
// Inferred Types
// =============================================================================

export type RateCheckBody = z.infer<typeof rateCheckSchema>;
export type RateRecordBody = z.infer<typeof rateRecordSchema>;
export type VerifySendBody = z.infer<typeof verifySendSchema>;
export type VerifyConfirmBody = z.infer<typeof verifyConfirmSchema>;
export type VerifyResendBody = z.infer<typeof verifyResendSchema>;
