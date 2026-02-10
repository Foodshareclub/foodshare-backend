/**
 * Image storage utilities — rate limiting and upload with R2/Supabase fallback.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { logger } from "../../_shared/logger.ts";
import { ServerError } from "../../_shared/errors.ts";
import { isR2Configured, uploadToR2 } from "../../_shared/r2-storage.ts";

export const ALLOWED_BUCKETS = [
  "food-images",
  "profiles",
  "forum",
  "challenges",
  "rooms",
  "assets",
  "avatars",
  "posts",
];

// Rate limiting: 100 uploads per user per day
const RATE_LIMIT_KEY = "image_upload_count";
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 86400; // 24 hours

// deno-lint-ignore no-explicit-any
export async function checkRateLimit(
  userId: string,
  supabase: SupabaseClient<any, any, any>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_rate_limits")
    .select("count, reset_at")
    .eq("user_id", userId)
    .eq("key", RATE_LIMIT_KEY)
    .single();

  if (error || !data) {
    await supabase.from("user_rate_limits").insert({
      user_id: userId,
      key: RATE_LIMIT_KEY,
      count: 1,
      reset_at: new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString(),
    });
    return true;
  }

  if (new Date(data.reset_at) < new Date()) {
    await supabase.from("user_rate_limits")
      .update({
        count: 1,
        reset_at: new Date(Date.now() + RATE_LIMIT_WINDOW * 1000).toISOString(),
      })
      .eq("user_id", userId)
      .eq("key", RATE_LIMIT_KEY);
    return true;
  }

  if (data.count >= RATE_LIMIT_MAX) {
    return false;
  }

  await supabase.from("user_rate_limits")
    .update({ count: data.count + 1 })
    .eq("user_id", userId)
    .eq("key", RATE_LIMIT_KEY);

  return true;
}

export async function uploadWithFallback(
  // deno-lint-ignore no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  bucket: string,
  path: string,
  buffer: Uint8Array,
  contentType: string,
): Promise<{ publicUrl: string; storage: "r2" | "supabase" }> {
  if (isR2Configured()) {
    const r2Path = `${bucket}/${path}`;
    const result = await uploadToR2(buffer, r2Path, contentType);
    if (result.success) {
      return { publicUrl: result.publicUrl, storage: "r2" };
    }
    logger.error("R2 upload failed, falling back to Supabase", new Error(result.error));
  }

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType,
      cacheControl: "31536000",
      upsert: true,
    });

  if (uploadError) {
    throw new ServerError(`Upload failed: ${uploadError.message}`);
  }

  const publicUrl = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  return { publicUrl, storage: "supabase" };
}
