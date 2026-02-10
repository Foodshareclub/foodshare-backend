/**
 * iOS Assertion verification for subsequent requests.
 *
 * Verifies CBOR-encoded assertions against stored public keys,
 * checks counter replay protection, and validates signatures.
 *
 * @module api-v1-attestation/lib/assertion
 */

import { logger } from "../../_shared/logger.ts";
import { decodeCBOR, parseAuthData, verifySignature } from "./app-attest.ts";

// =============================================================================
// Assertion Verification
// =============================================================================

export async function verifyAssertion(
  keyId: string,
  assertion: string,
  clientDataHash: string,
  storedCounter: number,
  storedPublicKey: string
): Promise<{ verified: boolean; newCounter: number; message?: string; riskScore: number }> {
  try {
    let assertionData: Uint8Array;
    try {
      assertionData = Uint8Array.from(atob(assertion), (c) => c.charCodeAt(0));
    } catch {
      return { verified: false, newCounter: storedCounter, message: "Invalid assertion encoding", riskScore: 100 };
    }

    if (assertionData.length < 50) {
      return { verified: false, newCounter: storedCounter, message: "Assertion data too short", riskScore: 100 };
    }

    const cbor = decodeCBOR(assertionData);
    if (!cbor) {
      return { verified: false, newCounter: storedCounter, message: "Invalid CBOR format", riskScore: 100 };
    }

    const authData = parseAuthData(cbor.authData);
    if (!authData) {
      return { verified: false, newCounter: storedCounter, message: "Invalid authenticator data", riskScore: 100 };
    }

    if (authData.signCount <= storedCounter) {
      return { verified: false, newCounter: storedCounter, message: "Counter replay detected", riskScore: 100 };
    }

    if (storedPublicKey && cbor.attStmt?.signature) {
      const clientDataHashBytes = Uint8Array.from(atob(clientDataHash), c => c.charCodeAt(0));

      const signatureValid = await verifySignature(
        cbor.authData,
        clientDataHashBytes,
        cbor.attStmt.signature as Uint8Array,
        storedPublicKey
      );

      if (!signatureValid) {
        return { verified: false, newCounter: storedCounter, message: "Signature verification failed", riskScore: 100 };
      }

      logger.info("Assertion verified with signature", { keyId: keyId.substring(0, 8), counter: authData.signCount });
      return { verified: true, newCounter: authData.signCount, riskScore: 5 };
    }

    logger.warn("Assertion verified without signature", { keyId: keyId.substring(0, 8) });
    return { verified: true, newCounter: authData.signCount, message: "Signature verification skipped", riskScore: 20 };
  } catch (error) {
    logger.error("Assertion verification error", error instanceof Error ? error : new Error(String(error)));
    return { verified: false, newCounter: storedCounter, message: "Verification failed", riskScore: 100 };
  }
}
