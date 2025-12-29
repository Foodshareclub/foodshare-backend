/**
 * TinyPNG Compression Service
 * https://tinypng.com/developers
 */

import { log, formatBytes, formatDuration } from "../lib/logger.ts";
import type { CompressResult } from "../lib/types.ts";

export async function compressWithTinyPNG(
  imageData: Uint8Array,
  apiKey: string,
  targetWidth: number
): Promise<CompressResult> {
  const startTime = Date.now();
  const authHeader = "Basic " + btoa(`api:${apiKey}`);

  // Step 1: Upload and compress
  const compressResponse = await fetch("https://api.tinify.com/shrink", {
    method: "POST",
    headers: { Authorization: authHeader },
    body: imageData,
  });

  if (!compressResponse.ok) {
    const error = await compressResponse.text();
    if (compressResponse.status === 429) {
      throw new Error(`TinyPNG rate limited: ${error}`);
    }
    throw new Error(`TinyPNG compress failed (${compressResponse.status}): ${error}`);
  }

  const compressResult = await compressResponse.json();
  const compressedUrl = compressResult.output.url;
  const compressionCount = compressResponse.headers.get("Compression-Count");

  log("debug", "TinyPNG initial compression", {
    service: "tinypng",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(compressResult.output.size),
    compressionCount: compressionCount ? parseInt(compressionCount) : null,
    duration: formatDuration(Date.now() - startTime),
  });

  // Step 2: Resize the compressed image
  const resizeResponse = await fetch(compressedUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      resize: {
        method: "fit",
        width: targetWidth,
        height: targetWidth,
      },
    }),
  });

  if (!resizeResponse.ok) {
    log("warn", "TinyPNG resize failed, using compressed only", {
      service: "tinypng",
      status: resizeResponse.status,
    });
    const downloadResponse = await fetch(compressedUrl, {
      headers: { Authorization: authHeader },
    });
    const buffer = new Uint8Array(await downloadResponse.arrayBuffer());
    return { buffer, method: "tinypng", service: "tinypng" };
  }

  const resizedBuffer = new Uint8Array(await resizeResponse.arrayBuffer());
  const totalDuration = Date.now() - startTime;

  log("info", "TinyPNG compression complete", {
    service: "tinypng",
    inputSize: formatBytes(imageData.length),
    outputSize: formatBytes(resizedBuffer.length),
    targetWidth,
    savedPercent: ((1 - resizedBuffer.length / imageData.length) * 100).toFixed(1),
    duration: formatDuration(totalDuration),
  });

  return {
    buffer: resizedBuffer,
    method: `tinypng@${targetWidth}px`,
    service: "tinypng",
  };
}
