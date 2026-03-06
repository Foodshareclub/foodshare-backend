/**
 * Shared types, interfaces, and Zod schemas for the Attestation API.
 *
 * @module api-v1-attestation/lib/types
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Trust & Request Types
// =============================================================================

export type TrustLevel = "unknown" | "trusted" | "verified" | "suspicious" | "blocked";
export type IOSRequestType = "attestation" | "assertion" | "device_check";
export type AndroidRequestType = "integrity" | "safetynet";
export type RequestType = IOSRequestType | AndroidRequestType;

// =============================================================================
// Android Verdicts
// =============================================================================

export type DeviceVerdict =
  | "MEETS_DEVICE_INTEGRITY"
  | "MEETS_BASIC_INTEGRITY"
  | "MEETS_STRONG_INTEGRITY"
  | "MEETS_VIRTUAL_INTEGRITY";
export type AppVerdict = "PLAY_RECOGNIZED" | "UNRECOGNIZED_VERSION" | "UNEVALUATED";
export type AccountVerdict = "LICENSED" | "UNLICENSED" | "UNEVALUATED";

// =============================================================================
// Response & Record Interfaces
// =============================================================================

export interface AttestationResponse {
  verified: boolean;
  trustLevel: TrustLevel;
  message?: string;
  expiresAt?: string;
  riskScore?: number;
  deviceId?: string;
  platform?: "ios" | "android";
  verdicts?: {
    device?: DeviceVerdict[];
    app?: AppVerdict;
    account?: AccountVerdict;
  };
}

export interface DeviceRecord {
  id: string;
  key_id: string;
  public_key: string | null;
  trust_level: TrustLevel;
  attestation_verified: boolean;
  assertion_counter: number;
  created_at: string;
  updated_at: string;
  last_seen: string;
  verification_count: number;
  risk_score: number;
  flags: Record<string, unknown>;
  platform?: string;
}

// =============================================================================
// Android Play Integrity Payload
// =============================================================================

export interface PlayIntegrityPayload {
  requestDetails: {
    requestPackageName: string;
    nonce: string;
    timestampMillis: string;
  };
  appIntegrity: {
    appRecognitionVerdict: AppVerdict;
    packageName?: string;
    certificateSha256Digest?: string[];
    versionCode?: string;
  };
  deviceIntegrity: {
    deviceRecognitionVerdict: DeviceVerdict[];
  };
  accountDetails: {
    appLicensingVerdict: AccountVerdict;
  };
}

// =============================================================================
// Request Schemas
// =============================================================================

export const iosAttestationSchema = z.object({
  type: z.enum(["attestation", "assertion", "device_check"]),
  keyId: z.string().optional(),
  attestation: z.string().optional(),
  assertion: z.string().optional(),
  clientDataHash: z.string().optional(),
  challenge: z.string().optional(),
  token: z.string().optional(),
  bundleId: z.string().optional(),
  timestamp: z.string().optional(),
});

export const androidAttestationSchema = z.object({
  type: z.enum(["integrity", "safetynet"]),
  integrityToken: z.string(),
  nonce: z.string().optional(),
  packageName: z.string().optional(),
  timestamp: z.string().optional(),
});

export const unifiedSchema = z.union([iosAttestationSchema, androidAttestationSchema]);
