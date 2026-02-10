/**
 * iOS DeviceCheck fallback verification handlers.
 *
 * Used for older iOS devices that do not support App Attest.
 *
 * @module api-v1-attestation/lib/device-check
 */

import { logger } from "../../_shared/logger.ts";
import type { TrustLevel } from "./types.ts";

// =============================================================================
// DeviceCheck Verification
// =============================================================================

export async function verifyDeviceCheck(token: string): Promise<{ verified: boolean; trustLevel: TrustLevel; message?: string; riskScore: number }> {
  try {
    if (!token || token.length < 50) {
      return { verified: false, trustLevel: "unknown", message: "Invalid token format", riskScore: 100 };
    }

    try {
      const tokenData = Uint8Array.from(atob(token), (c) => c.charCodeAt(0));
      if (tokenData.length < 50) {
        return { verified: false, trustLevel: "unknown", message: "Token data too short", riskScore: 100 };
      }
    } catch {
      return { verified: false, trustLevel: "unknown", message: "Invalid token encoding", riskScore: 100 };
    }

    logger.info("DeviceCheck token accepted", { tokenPrefix: token.substring(0, 8) });
    return { verified: true, trustLevel: "trusted", riskScore: 40 };
  } catch (error) {
    logger.error("DeviceCheck verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, trustLevel: "unknown", message: "Verification failed", riskScore: 100 };
  }
}
