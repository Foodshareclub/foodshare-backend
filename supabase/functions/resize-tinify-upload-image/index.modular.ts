/**
 * Smart Image Compress Edge Function v9 (Modular Version)
 *
 * This is the modular/componentized version for development.
 * For deployment, use index.ts (bundled version).
 *
 * Features:
 * - Adaptive compression targeting < 100KB
 * - Smart width calculation based on file size
 * - Parallel race: TinyPNG vs Cloudinary (first success wins)
 * - Circuit breaker pattern for service resilience
 * - Structured JSON logging for monitoring
 *
 * Componentized architecture:
 * - lib/config.ts - Configuration constants
 * - lib/logger.ts - Structured logging
 * - lib/circuit-breaker.ts - Circuit breaker pattern
 * - lib/utils.ts - Utility functions
 * - lib/types.ts - Type definitions
 * - services/tinypng.ts - TinyPNG service
 * - services/cloudinary.ts - Cloudinary service
 * - services/compressor.ts - Compression orchestrator
 */

import {
  createClient as _createClient,
  SupabaseClient as _SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

import {
  CONFIG as _CONFIG,
  corsHeaders as _corsHeaders,
  STORAGE_BUCKETS as _STORAGE_BUCKETS,
  MAX_FILE_SIZES as _MAX_FILE_SIZES,
  StorageBucket as _StorageBucket,
} from "./lib/config.ts";
import {
  log as _log,
  formatBytes as _formatBytes,
  formatDuration as _formatDuration,
} from "./lib/logger.ts";
import {
  circuits as _circuits,
  getCircuitState as _getCircuitState,
} from "./lib/circuit-breaker.ts";
import {
  detectFormat as _detectFormat,
  getBucketKey as _getBucketKey,
  generateUUID as _generateUUID,
} from "./lib/utils.ts";
import { smartCompress as _smartCompress } from "./services/compressor.ts";
import type {
  CompressionResult as _CompressionResult,
  CompressionServices as _CompressionServices,
  BatchItem as _BatchItem,
} from "./lib/types.ts";

// Re-export for when this file is used
export const createClient = _createClient;
export type SupabaseClient = _SupabaseClient;
export const CONFIG = _CONFIG;
export const corsHeaders = _corsHeaders;
export const STORAGE_BUCKETS = _STORAGE_BUCKETS;
export const MAX_FILE_SIZES = _MAX_FILE_SIZES;
export type StorageBucket = _StorageBucket;
export const log = _log;
export const formatBytes = _formatBytes;
export const formatDuration = _formatDuration;
export const circuits = _circuits;
export const getCircuitState = _getCircuitState;
export const detectFormat = _detectFormat;
export const getBucketKey = _getBucketKey;
export const generateUUID = _generateUUID;
export const smartCompress = _smartCompress;
export type CompressionResult = _CompressionResult;
export type CompressionServices = _CompressionServices;
export type BatchItem = _BatchItem;

// ... rest of the modular implementation
// See index.ts for the bundled deployable version
