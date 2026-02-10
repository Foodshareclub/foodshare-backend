/**
 * Device record management for attestation state persistence.
 *
 * Handles creating, reading, and updating device attestation records
 * in the database. Shared across iOS and Android verification flows.
 *
 * @module api-v1-attestation/lib/device-record
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import type { TrustLevel, DeviceVerdict, AppVerdict, AccountVerdict, DeviceRecord } from "./types.ts";

// =============================================================================
// Device ID Generation
// =============================================================================

export async function generateDeviceId(keyId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`device:${keyId}:foodshare`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// Device Record CRUD
// =============================================================================

export async function getDeviceRecord(
  supabase: SupabaseClient,
  keyId: string
): Promise<DeviceRecord | null> {
  const { data } = await supabase
    .from("device_attestations")
    .select("*")
    .eq("key_id", keyId)
    .single();

  return data as DeviceRecord | null;
}

export async function updateDeviceRecord(
  supabase: SupabaseClient,
  keyId: string,
  verified: boolean,
  trustLevel: TrustLevel,
  publicKey: string | null,
  counter: number,
  riskScore: number,
  platform: "ios" | "android",
  verdicts?: { device?: DeviceVerdict[]; app?: AppVerdict; account?: AccountVerdict }
): Promise<string> {
  const now = new Date().toISOString();
  const deviceId = await generateDeviceId(keyId);

  const existing = await getDeviceRecord(supabase, keyId);

  if (existing) {
    await supabase
      .from("device_attestations")
      .update({
        attestation_verified: verified,
        trust_level: trustLevel,
        public_key: publicKey || existing.public_key,
        assertion_counter: counter,
        last_seen: now,
        updated_at: now,
        verification_count: (existing.verification_count || 0) + 1,
        risk_score: Math.min(riskScore, existing.risk_score || 100),
        platform,
        flags: {
          ...(existing.flags || {}),
          lastVerdicts: verdicts,
          lastVerifiedAt: now,
        },
      })
      .eq("key_id", keyId);
  } else {
    await supabase.from("device_attestations").insert({
      key_id: keyId,
      public_key: publicKey,
      attestation_verified: verified,
      trust_level: trustLevel,
      assertion_counter: counter,
      created_at: now,
      updated_at: now,
      last_seen: now,
      verification_count: 1,
      risk_score: riskScore,
      platform,
      flags: { verdicts },
    });
  }

  return deviceId;
}

// =============================================================================
// Trust Level Calculation
// =============================================================================

export function calculateTrustLevel(verified: boolean, riskScore: number, verificationCount: number): TrustLevel {
  if (!verified) return "suspicious";
  if (riskScore >= 80) return "suspicious";
  if (riskScore >= 50) return "unknown";
  if (verificationCount > 5 && riskScore < 20) return "verified";
  return "trusted";
}
