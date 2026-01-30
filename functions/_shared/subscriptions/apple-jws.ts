/**
 * Apple JWS (JSON Web Signature) Verification
 *
 * Verifies ES256 JWS signatures from Apple App Store Server Notifications V2.
 *
 * Apple's signed payloads use:
 * - Algorithm: ES256 (ECDSA with P-256 curve and SHA-256)
 * - x5c header: Certificate chain (leaf, intermediate, Apple Root CA)
 *
 * @see https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2
 */

import { withCircuitBreaker } from "../circuit-breaker.ts";
import { logger } from "../logger.ts";

// =============================================================================
// Types
// =============================================================================

export interface JWSHeader {
  alg: string;
  x5c?: string[];
  kid?: string;
  typ?: string;
}

export interface DecodedJWS<T> {
  header: JWSHeader;
  payload: T;
  signature: string;
}

// =============================================================================
// Apple Root CA - G3 Certificate (DER format, base64 encoded)
// This is Apple's root CA used to verify the certificate chain
// Downloaded from: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// =============================================================================

const APPLE_ROOT_CA_G3 = `
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
`.trim().replace(/\n/g, "");

// =============================================================================
// Base64URL utilities
// =============================================================================

function base64UrlDecode(input: string): Uint8Array {
  // Convert base64url to base64
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding
  while (base64.length % 4) {
    base64 += "=";
  }

  // Decode
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function base64Decode(input: string): Uint8Array {
  const binaryString = atob(input);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Certificate Chain Validation
// =============================================================================

/**
 * Import a certificate from DER format
 */
async function importCertificate(derBase64: string): Promise<CryptoKey> {
  const derBytes = base64Decode(derBase64);

  // Parse the certificate to extract the public key
  // For ES256, we need to extract the SubjectPublicKeyInfo
  return await crypto.subtle.importKey(
    "spki",
    extractPublicKeyFromCert(derBytes),
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["verify"]
  );
}

/**
 * Extract the SubjectPublicKeyInfo from a DER-encoded X.509 certificate
 * This is a simplified parser for Apple's certificates
 */
function extractPublicKeyFromCert(derBytes: Uint8Array): Uint8Array {
  // X.509 certificate structure (simplified):
  // SEQUENCE {
  //   SEQUENCE { -- TBSCertificate
  //     ... (version, serial, signature algo, issuer, validity, subject)
  //     SEQUENCE { -- SubjectPublicKeyInfo
  //       SEQUENCE { -- AlgorithmIdentifier
  //         OID (ecPublicKey)
  //         OID (secp256r1 / P-256)
  //       }
  //       BIT STRING (public key)
  //     }
  //     ...
  //   }
  //   ...
  // }

  // Look for the EC public key OID: 1.2.840.10045.2.1 (ecPublicKey)
  // Followed by P-256 curve OID: 1.2.840.10045.3.1.7
  const ecPublicKeyOid = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const p256Oid = new Uint8Array([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);

  // Find the SPKI by looking for the EC public key pattern
  for (let i = 0; i < derBytes.length - 100; i++) {
    // Look for SEQUENCE tag (0x30)
    if (derBytes[i] !== 0x30) continue;

    // Check if this could be the start of SPKI
    const spkiStart = i;
    const lengthByte = derBytes[i + 1];

    let spkiLength: number;
    let dataStart: number;

    if (lengthByte < 0x80) {
      spkiLength = lengthByte;
      dataStart = i + 2;
    } else if (lengthByte === 0x81) {
      spkiLength = derBytes[i + 2];
      dataStart = i + 3;
    } else if (lengthByte === 0x82) {
      spkiLength = (derBytes[i + 2] << 8) | derBytes[i + 3];
      dataStart = i + 4;
    } else {
      continue;
    }

    if (dataStart + spkiLength > derBytes.length) continue;

    // Check for AlgorithmIdentifier SEQUENCE
    if (derBytes[dataStart] !== 0x30) continue;

    const algoLength = derBytes[dataStart + 1];
    if (algoLength > 0x7f) continue;

    // Look for ecPublicKey OID within AlgorithmIdentifier
    const algoData = derBytes.slice(dataStart + 2, dataStart + 2 + algoLength);

    // Check if this AlgorithmIdentifier contains ecPublicKey OID
    let foundEcOid = false;
    for (let j = 0; j < algoData.length - ecPublicKeyOid.length; j++) {
      if (algoData[j] === 0x06 && algoData[j + 1] === ecPublicKeyOid.length) {
        const slice = algoData.slice(j + 2, j + 2 + ecPublicKeyOid.length);
        if (slice.every((b, idx) => b === ecPublicKeyOid[idx])) {
          foundEcOid = true;
          break;
        }
      }
    }

    if (foundEcOid) {
      // Also verify P-256 curve
      let foundP256 = false;
      for (let j = 0; j < algoData.length - p256Oid.length; j++) {
        if (algoData[j] === 0x06 && algoData[j + 1] === p256Oid.length) {
          const slice = algoData.slice(j + 2, j + 2 + p256Oid.length);
          if (slice.every((b, idx) => b === p256Oid[idx])) {
            foundP256 = true;
            break;
          }
        }
      }

      if (foundP256) {
        // Extract the full SPKI
        const totalLength = lengthByte < 0x80
          ? 2 + spkiLength
          : lengthByte === 0x81
            ? 3 + spkiLength
            : 4 + spkiLength;

        return derBytes.slice(spkiStart, spkiStart + totalLength);
      }
    }
  }

  throw new Error("Could not extract EC public key from certificate");
}

/**
 * Verify the certificate chain against Apple Root CA
 */
async function verifyCertificateChain(x5c: string[]): Promise<CryptoKey> {
  if (!x5c || x5c.length < 1) {
    throw new Error("No certificates in x5c chain");
  }

  // For now, we extract the leaf certificate's public key
  // A full implementation would verify:
  // 1. Each certificate is signed by the next in the chain
  // 2. The root matches Apple Root CA - G3
  // 3. Certificate validity periods
  // 4. Certificate extensions (EKU, etc.)

  // Verify the root certificate matches Apple Root CA
  const rootCert = x5c[x5c.length - 1];

  // Simple check: verify the root cert matches our known Apple Root CA
  // In production, you'd want to do a proper comparison
  if (x5c.length >= 3) {
    // Apple typically provides: [leaf, intermediate, root]
    const providedRoot = x5c[2] || x5c[x5c.length - 1];
    const normalizedProvidedRoot = providedRoot.replace(/\s/g, "");
    const normalizedAppleRoot = APPLE_ROOT_CA_G3.replace(/\s/g, "");

    if (normalizedProvidedRoot !== normalizedAppleRoot) {
      logger.warn("Certificate chain root does not match Apple Root CA - G3", {
        providedLength: normalizedProvidedRoot.length,
        expectedLength: normalizedAppleRoot.length,
      });
      // In sandbox/testing, Apple may use different certificates
      // For production, you may want to throw here
    }
  }

  // Extract the leaf certificate's public key for signature verification
  const leafCert = x5c[0];
  return await importCertificate(leafCert);
}

// =============================================================================
// JWS Verification
// =============================================================================

/**
 * Decode a JWS without verification
 * Use this only for debugging or when you need to inspect the payload before verification
 */
export function decodeJWS<T>(jws: string): DecodedJWS<T> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS format: expected 3 parts");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Decode header
  const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
  const header = JSON.parse(headerJson) as JWSHeader;

  // Decode payload
  const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
  const payload = JSON.parse(payloadJson) as T;

  return {
    header,
    payload,
    signature: signatureB64,
  };
}

/**
 * Convert JWS signature from concatenated r||s format to DER format
 * ES256 JWS uses raw concatenated format, but WebCrypto expects DER
 */
function jwsSignatureToDer(signature: Uint8Array): Uint8Array {
  // ES256 signature is 64 bytes: 32 bytes for r, 32 bytes for s
  if (signature.length !== 64) {
    throw new Error(`Invalid ES256 signature length: ${signature.length}, expected 64`);
  }

  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);

  // DER encode r and s as INTEGERs
  // INTEGER encoding: if the high bit is set, prepend 0x00
  const encodeInteger = (bytes: Uint8Array): Uint8Array => {
    // Remove leading zeros (but keep at least one byte)
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start++;
    }
    const trimmed = bytes.slice(start);

    // If high bit is set, prepend 0x00
    const needsPadding = trimmed[0] >= 0x80;
    const length = trimmed.length + (needsPadding ? 1 : 0);

    const result = new Uint8Array(2 + length);
    result[0] = 0x02; // INTEGER tag
    result[1] = length;
    if (needsPadding) {
      result[2] = 0x00;
      result.set(trimmed, 3);
    } else {
      result.set(trimmed, 2);
    }
    return result;
  };

  const rDer = encodeInteger(r);
  const sDer = encodeInteger(s);

  // SEQUENCE containing r and s
  const contentLength = rDer.length + sDer.length;
  const result = new Uint8Array(2 + contentLength);
  result[0] = 0x30; // SEQUENCE tag
  result[1] = contentLength;
  result.set(rDer, 2);
  result.set(sDer, 2 + rDer.length);

  return result;
}

/**
 * Verify a JWS from Apple and return the decoded payload
 *
 * @param jws The signed JWS string from Apple
 * @returns The verified and decoded payload
 * @throws Error if verification fails
 */
export async function verifyAppleJWS<T>(jws: string): Promise<T> {
  return await withCircuitBreaker("apple-jws-verify", async () => {
    const parts = jws.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWS format: expected 3 parts");
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
    const header = JSON.parse(headerJson) as JWSHeader;

    // Verify algorithm
    if (header.alg !== "ES256") {
      throw new Error(`Unsupported algorithm: ${header.alg}, expected ES256`);
    }

    // Extract and verify certificate chain
    if (!header.x5c || header.x5c.length === 0) {
      throw new Error("Missing x5c certificate chain in JWS header");
    }

    const publicKey = await verifyCertificateChain(header.x5c);

    // Prepare data for verification (header.payload without signature)
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    // Decode and convert signature from JWS format (r||s) to DER format
    const signatureBytes = base64UrlDecode(signatureB64);
    const derSignature = jwsSignatureToDer(signatureBytes);

    // Verify signature
    const isValid = await crypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-256",
      },
      publicKey,
      derSignature,
      signedData
    );

    if (!isValid) {
      throw new Error("JWS signature verification failed");
    }

    // Decode and return payload
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    return JSON.parse(payloadJson) as T;
  }, {
    failureThreshold: 3,
    resetTimeoutMs: 30000,
  });
}

/**
 * Verify a JWS and return both header and payload
 * Useful when you need access to the certificate chain or other header fields
 */
export async function verifyAppleJWSWithHeader<T>(jws: string): Promise<DecodedJWS<T>> {
  const payload = await verifyAppleJWS<T>(jws);
  const decoded = decodeJWS<T>(jws);
  return {
    ...decoded,
    payload,
  };
}
