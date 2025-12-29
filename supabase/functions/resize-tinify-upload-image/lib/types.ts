/**
 * Shared type definitions
 */

export interface CompressResult {
  buffer: Uint8Array;
  method: string;
  service: string;
}

export interface CompressionResult {
  success: boolean;
  originalPath: string;
  compressedPath?: string;
  originalSize: number;
  compressedSize?: number;
  compressedFormat?: string;
  compressionMethod?: string;
  processingTimeMs: number;
  error?: string;
}

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface CompressionServices {
  tinifyApiKey?: string;
  cloudinaryConfig?: CloudinaryConfig;
}

export interface BatchItem {
  bucket: string;
  path: string;
  size: number;
}
