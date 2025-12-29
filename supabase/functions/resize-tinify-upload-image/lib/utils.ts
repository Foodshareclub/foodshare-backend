/**
 * Utility functions
 */

import { CONFIG, STORAGE_BUCKETS, StorageBucketKey } from "./config.ts";

export function detectFormat(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (data[0] === 0x89 && data[1] === 0x50) return "png";
  if (data[0] === 0x47 && data[1] === 0x49) return "gif";
  if (data[0] === 0x52 && data[1] === 0x49) return "webp";
  return "jpeg";
}

export function getBucketKey(bucket: string): StorageBucketKey {
  return (Object.keys(STORAGE_BUCKETS).find(
    (key) => STORAGE_BUCKETS[key as StorageBucketKey] === bucket
  ) || "POSTS") as StorageBucketKey;
}

export function getSmartWidth(originalSize: number): number {
  for (const tier of CONFIG.widthTiers) {
    if (originalSize <= tier.maxOriginalSize) {
      return tier.width;
    }
  }
  return 500;
}

export function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
