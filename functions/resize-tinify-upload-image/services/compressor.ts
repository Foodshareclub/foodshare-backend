/**
 * Smart Compression Orchestrator
 * Races TinyPNG and Cloudinary in parallel, first success wins
 */

import { CONFIG } from "../lib/config.ts";
import { log, formatBytes, formatDuration } from "../lib/logger.ts";
import { getSmartWidth } from "../lib/utils.ts";
import {
  canAttempt,
  getCircuitState,
  recordSuccess,
  recordFailure,
} from "../lib/circuit-breaker.ts";
import type { CompressResult, CompressionServices } from "../lib/types.ts";
import { compressWithTinyPNG } from "./tinypng.ts";
import { compressWithCloudinary } from "./cloudinary.ts";

// Retry helper with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  service: string,
  maxAttempts = CONFIG.retry.maxAttempts
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = Math.min(
          CONFIG.retry.baseDelayMs * Math.pow(2, attempt - 1),
          CONFIG.retry.maxDelayMs
        );
        log("warn", "Retry attempt failed", {
          service,
          attempt,
          maxAttempts,
          error: lastError.message,
          nextRetryMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        log("warn", "All retry attempts exhausted", {
          service,
          attempts: maxAttempts,
          error: lastError.message,
        });
      }
    }
  }

  throw lastError || new Error(`${service} failed after ${maxAttempts} attempts`);
}

// Wrap compression attempt for circuit breaker tracking
type RaceOutcome =
  | { success: true; result: CompressResult; finishTime: number }
  | { success: false; error: string; service: string; finishTime: number };

async function wrapCompressionAttempt(
  service: string,
  attempt: () => Promise<CompressResult>,
  raceStartTime: number
): Promise<RaceOutcome> {
  try {
    const result = await attempt();
    recordSuccess(service);
    return { success: true, result, finishTime: Date.now() - raceStartTime };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordFailure(service);
    return { success: false, error: errorMsg, service, finishTime: Date.now() - raceStartTime };
  }
}

// Race promises, return first success
async function raceForSuccess(
  promises: Promise<RaceOutcome>[]
): Promise<
  | { success: true; result: CompressResult; winnerTime: number }
  | { success: false; errors: string[] }
> {
  if (promises.length === 0) {
    return { success: false, errors: ["No compression services available"] };
  }

  const errors: string[] = [];
  let resolved = 0;
  const total = promises.length;
  let hasWinner = false;

  return new Promise((resolve) => {
    promises.forEach((promise) => {
      promise.then((outcome) => {
        resolved++;
        if (outcome.success && !hasWinner) {
          hasWinner = true;
          resolve({ success: true, result: outcome.result, winnerTime: outcome.finishTime });
        } else if (!outcome.success) {
          errors.push(`${outcome.service}: ${outcome.error}`);
          log("warn", "Race participant failed", {
            service: outcome.service,
            error: outcome.error,
            duration: formatDuration(outcome.finishTime),
          });
          if (resolved === total && !hasWinner) {
            resolve({ success: false, errors });
          }
        }
      });
    });
  });
}

export async function smartCompress(
  imageData: Uint8Array,
  services: CompressionServices
): Promise<CompressResult> {
  const raceStartTime = Date.now();
  const originalSize = imageData.length;
  const targetWidth = getSmartWidth(originalSize);

  log("info", "Starting compression race", {
    inputSize: formatBytes(originalSize),
    targetWidth,
    tinypngAvailable: !!services.tinifyApiKey && canAttempt("tinypng"),
    cloudinaryAvailable: !!services.cloudinaryConfig && canAttempt("cloudinary"),
    tinypngCircuit: getCircuitState("tinypng"),
    cloudinaryCircuit: getCircuitState("cloudinary"),
  });

  const compressionAttempts: Promise<RaceOutcome>[] = [];

  // Add TinyPNG if available and circuit allows
  if (services.tinifyApiKey && canAttempt("tinypng")) {
    compressionAttempts.push(
      wrapCompressionAttempt(
        "tinypng",
        () =>
          withRetry(
            () => compressWithTinyPNG(imageData, services.tinifyApiKey!, targetWidth),
            "tinypng"
          ),
        raceStartTime
      )
    );
  } else if (services.tinifyApiKey) {
    log("info", "Service skipped due to circuit breaker", {
      service: "tinypng",
      state: getCircuitState("tinypng"),
    });
  }

  // Add Cloudinary if available and circuit allows
  if (services.cloudinaryConfig && canAttempt("cloudinary")) {
    compressionAttempts.push(
      wrapCompressionAttempt(
        "cloudinary",
        () =>
          withRetry(
            () => compressWithCloudinary(imageData, services.cloudinaryConfig!, targetWidth),
            "cloudinary"
          ),
        raceStartTime
      )
    );
  } else if (services.cloudinaryConfig) {
    log("info", "Service skipped due to circuit breaker", {
      service: "cloudinary",
      state: getCircuitState("cloudinary"),
    });
  }

  if (compressionAttempts.length === 0) {
    log("error", "No compression services available", {
      tinypngConfigured: !!services.tinifyApiKey,
      cloudinaryConfigured: !!services.cloudinaryConfig,
      tinypngCircuit: getCircuitState("tinypng"),
      cloudinaryCircuit: getCircuitState("cloudinary"),
    });
    throw new Error("No compression services available (all circuits open or not configured)");
  }

  const outcome = await raceForSuccess(compressionAttempts);

  if (outcome.success) {
    const totalRaceTime = Date.now() - raceStartTime;
    log("info", "Compression race complete", {
      winner: outcome.result.service,
      winnerTime: formatDuration(outcome.winnerTime),
      totalRaceTime: formatDuration(totalRaceTime),
      inputSize: formatBytes(originalSize),
      outputSize: formatBytes(outcome.result.buffer.length),
      savedPercent: ((1 - outcome.result.buffer.length / originalSize) * 100).toFixed(1),
      racers: compressionAttempts.length,
    });
    return outcome.result;
  }

  log("error", "All compression services failed", { errors: outcome.errors });
  throw new Error(`All compression services failed: ${outcome.errors.join("; ")}`);
}
