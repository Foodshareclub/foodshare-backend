/**
 * Cloudflare R2 Storage Client for Edge Functions
 *
 * S3-compatible object storage using the shared AWSV4Signer.
 * Used as primary storage with Supabase Storage as fallback.
 *
 * Environment variables (set in Supabase Dashboard → Edge Functions → Secrets):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *   R2_BUCKET_NAME, R2_PUBLIC_URL
 */

import { AWSV4Signer } from "./aws-signer.ts";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}

export interface R2UploadResult {
  success: boolean;
  path: string;
  publicUrl: string;
  error?: string;
}

let cachedConfig: R2Config | null | undefined;

/**
 * Load R2 config from environment variables. Returns null if not configured.
 * Result is cached for the lifetime of the function invocation.
 */
export function getR2Config(): R2Config | null {
  if (cachedConfig !== undefined) return cachedConfig;

  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucketName = Deno.env.get("R2_BUCKET_NAME");
  const publicUrl = Deno.env.get("R2_PUBLIC_URL");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
    cachedConfig = null;
    return null;
  }

  cachedConfig = { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl };
  return cachedConfig;
}

/**
 * Check if R2 is configured and available.
 */
export function isR2Configured(): boolean {
  return getR2Config() !== null;
}

/**
 * Upload a file to Cloudflare R2.
 *
 * @param buffer  - File contents
 * @param path    - Object key (e.g. "food-images/abc.jpg")
 * @param contentType - MIME type
 */
export async function uploadToR2(
  buffer: Uint8Array,
  path: string,
  contentType: string
): Promise<R2UploadResult> {
  const config = getR2Config();
  if (!config) {
    return { success: false, path, publicUrl: "", error: "R2 not configured" };
  }

  const signer = new AWSV4Signer("auto", "s3", config.accessKeyId, config.secretAccessKey);
  const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  const objectUrl = `${endpoint}/${config.bucketName}/${path}`;

  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-length": buffer.byteLength.toString(),
    "cache-control": "public, max-age=31536000, immutable",
  };

  const signedHeaders = await signer.signRequest("PUT", objectUrl, headers, buffer);

  const response = await fetch(objectUrl, {
    method: "PUT",
    headers: signedHeaders,
    body: buffer,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      success: false,
      path,
      publicUrl: "",
      error: `R2 upload failed (${response.status}): ${body.slice(0, 200)}`,
    };
  }

  return {
    success: true,
    path,
    publicUrl: getR2PublicUrl(path),
  };
}

/**
 * Build the public CDN URL for an R2 object.
 */
export function getR2PublicUrl(path: string): string {
  const config = getR2Config();
  if (!config) return "";
  // Trim trailing slash from publicUrl, ensure single slash before path
  const base = config.publicUrl.replace(/\/+$/, "");
  return `${base}/${path}`;
}
