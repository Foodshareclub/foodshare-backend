/**
 * Enterprise Image API Types
 * @module api-v1-images/types
 */

export interface ImageUploadRequest {
  file: Uint8Array;
  bucket: string;
  options?: ImageUploadOptions;
}

export interface ImageUploadOptions {
  generateThumbnail?: boolean;
  extractEXIF?: boolean;
  enableAI?: boolean;
  quality?: "low" | "medium" | "high";
  maxWidth?: number;
}

export interface ImageUploadResponse {
  success: boolean;
  data: {
    url: string;
    path: string;
    thumbnailUrl?: string;
    thumbnailPath?: string;
  };
  metadata: ImageMetadata;
}

export interface ImageMetadata {
  originalSize: number;
  finalSize: number;
  savedBytes: number;
  savedPercent: number;
  format: string;
  dimensions?: {
    width: number;
    height: number;
  };
  exif?: EXIFData;
  ai?: AIData;
  processingTime: number;
}

export interface EXIFData {
  gps?: {
    latitude: number;
    longitude: number;
  };
  timestamp?: string;
  camera?: {
    make?: string;
    model?: string;
  };
  orientation?: number;
}

export interface AIData {
  tags: string[];
  confidence: number[];
  category?: string;
}

export interface BatchUploadRequest {
  files: Uint8Array[];
  bucket: string;
  options?: ImageUploadOptions;
}

export interface BatchUploadResponse {
  success: boolean;
  results: ImageUploadResponse[];
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    totalSavedBytes: number;
    processingTime: number;
  };
}
