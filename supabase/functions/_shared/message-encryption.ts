/**
 * Message Encryption at Rest
 *
 * AES-256-GCM encryption/decryption for chat messages stored in the database.
 * Key is loaded from CHAT_ENCRYPTION_KEY environment variable (base64-encoded 32 bytes).
 *
 * Encrypted format: "enc:" + base64(12-byte nonce + ciphertext + 16-byte tag)
 * Non-prefixed strings are treated as plaintext (backward compatibility).
 *
 * Graceful degradation:
 * - Encryption failure → store plaintext (availability over confidentiality)
 * - Decryption failure → return "[Encrypted message]"
 */

import { logger } from "./logger.ts";

const ENCRYPTED_PREFIX = "enc:";
const NONCE_LENGTH = 12; // AES-GCM standard nonce size
const TAG_LENGTH = 16; // AES-GCM authentication tag size

let _cryptoKey: CryptoKey | null = null;
let _keyLoadAttempted = false;

/**
 * Lazily load the encryption key from environment.
 * Returns null if key is not configured (encryption disabled).
 */
async function getCryptoKey(): Promise<CryptoKey | null> {
  if (_keyLoadAttempted) return _cryptoKey;
  _keyLoadAttempted = true;

  const keyBase64 = Deno.env.get("CHAT_ENCRYPTION_KEY");
  if (!keyBase64) {
    logger.warn("CHAT_ENCRYPTION_KEY not set — message encryption disabled");
    return null;
  }

  try {
    const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
    if (keyBytes.length !== 32) {
      logger.error("CHAT_ENCRYPTION_KEY must be 32 bytes (256 bits)", new Error("Invalid key length"));
      return null;
    }

    _cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return _cryptoKey;
  } catch (error) {
    logger.error("Failed to load encryption key", error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Encrypt a plaintext message for storage.
 * Returns the encrypted string with "enc:" prefix, or the original plaintext on failure.
 */
export async function encryptMessage(plaintext: string): Promise<string> {
  const key = await getCryptoKey();
  if (!key) return plaintext; // No key configured — store plaintext

  try {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      encoded,
    );

    // Combine nonce + ciphertext (which includes the GCM tag)
    const combined = new Uint8Array(nonce.length + ciphertext.byteLength);
    combined.set(nonce, 0);
    combined.set(new Uint8Array(ciphertext), nonce.length);

    return ENCRYPTED_PREFIX + btoa(String.fromCharCode(...combined));
  } catch (error) {
    logger.error("Message encryption failed, storing plaintext", error instanceof Error ? error : new Error(String(error)));
    return plaintext;
  }
}

/**
 * Decrypt a stored message.
 * Handles both encrypted ("enc:" prefix) and plaintext messages for backward compat.
 */
export async function decryptMessage(stored: string): Promise<string> {
  // Not encrypted — return as-is
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored;
  }

  const key = await getCryptoKey();
  if (!key) {
    // Key not available but message is encrypted — cannot decrypt
    return "[Encrypted message]";
  }

  try {
    const base64Data = stored.slice(ENCRYPTED_PREFIX.length);
    const combined = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

    if (combined.length < NONCE_LENGTH + TAG_LENGTH) {
      return "[Encrypted message]";
    }

    const nonce = combined.slice(0, NONCE_LENGTH);
    const ciphertext = combined.slice(NONCE_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    );

    return new TextDecoder().decode(decrypted);
  } catch (error) {
    logger.error("Message decryption failed", error instanceof Error ? error : new Error(String(error)));
    return "[Encrypted message]";
  }
}
