/**
 * Enterprise Image API v1
 * 
 * Unified image processing endpoint for all features:
 * - Listings, Forum, Profiles, Challenges
 * 
 * Features:
 * - Smart compression (TinyPNG/Cloudinary)
 * - EXIF extraction (GPS, timestamp, camera)
 * - Thumbnail generation
 * - AI food detection (optional)
 * - Batch upload support
 * 
 * Routes:
 * - POST /upload        - Single image upload
 * - POST /batch         - Batch image upload
 * - GET  /health        - Health check
 * 
 * @module api-v1-images
 * @version 1.0.0
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractEXIF, getImageDimensions } from "./services/exif.ts";
import { compressImage, generateThumbnail } from "../_shared/compression/index.ts";
import { analyzeImage } from "./services/ai.ts";
import type {
  ImageUploadResponse,
  BatchUploadResponse,
} from "./types/index.ts";

const VERSION = "1.0.0";
const SERVICE = "api-v1-images";
const ALLOWED_BUCKETS = ["food-images", "profiles", "forum", "challenges", "rooms", "assets"];

function detectFormat(buffer: Uint8Array): string {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "webp";
  return "jpeg";
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 204 });
  }
  
  const url = new URL(req.url);
  const path = url.pathname;
  
  try {
    if (path.endsWith("/health")) {
      return jsonResponse({ status: "healthy", version: VERSION, service: SERVICE }, 200, corsHeaders);
    }
    
    if (path.endsWith("/upload") && req.method === "POST") {
      return await handleUpload(req, corsHeaders);
    }
    
    if (path.endsWith("/batch") && req.method === "POST") {
      return await handleBatchUpload(req, corsHeaders);
    }
    
    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  } catch (error) {
    console.error("API error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500,
      corsHeaders
    );
  }
});

async function handleUpload(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();
  
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string) || "food-images";
  const customPath = formData.get("path") as string | null;
  const generateThumb = formData.get("generateThumbnail") !== "false";
  const extractEXIFData = formData.get("extractEXIF") !== "false";
  const enableAI = formData.get("enableAI") === "true";
  
  if (!file) {
    return jsonResponse({ error: "No file provided" }, 400, corsHeaders);
  }
  
  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return jsonResponse({ error: `Invalid bucket: ${bucket}` }, 400, corsHeaders);
  }
  
  // Validate file size (max 10MB)
  if (file.size > 10 * 1024 * 1024) {
    return jsonResponse({ error: "File too large (max 10MB)" }, 400, corsHeaders);
  }
  
  const imageData = new Uint8Array(await file.arrayBuffer());
  const originalSize = imageData.length;
  
  const exif = extractEXIFData ? await extractEXIF(imageData) : null;
  const dimensions = getImageDimensions(imageData);
  const compressed = await compressImage(imageData, 800);
  
  let thumbnailBuffer: Uint8Array | null = null;
  if (generateThumb) {
    thumbnailBuffer = await generateThumbnail(imageData, 300);
  }
  
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  
  // Detect format from buffer
  const format = detectFormat(compressed.buffer);
  const filename = `${crypto.randomUUID()}.${format}`;
  const path = customPath || filename;
  
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(path, compressed.buffer, {
      contentType: `image/${format}`,
      cacheControl: "31536000",
      upsert: true,
    });
  
  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }
  
  const publicUrl = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  
  let thumbnailUrl: string | undefined;
  let thumbnailPath: string | undefined;
  if (thumbnailBuffer) {
    const thumbFilename = `${crypto.randomUUID()}_thumb.jpg`;
    const thumbPath = customPath ? `${customPath.replace(/\.[^.]+$/, '')}_thumb.jpg` : thumbFilename;
    
    const { error: thumbError } = await supabase.storage.from(bucket).upload(thumbPath, thumbnailBuffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: true,
    });
    
    if (!thumbError) {
      thumbnailUrl = supabase.storage.from(bucket).getPublicUrl(thumbPath).data.publicUrl;
      thumbnailPath = thumbPath;
    }
  }
  
  let ai = null;
  if (enableAI) {
    try {
      ai = await analyzeImage(publicUrl);
    } catch (error) {
      console.error("AI analysis failed:", error);
    }
  }
  
  const processingTime = Date.now() - startTime;
  
  const response: ImageUploadResponse = {
    success: true,
    data: {
      url: publicUrl,
      path,
      thumbnailUrl,
      thumbnailPath,
    },
    metadata: {
      originalSize,
      finalSize: compressed.compressedSize,
      savedBytes: compressed.savedPercent > 0 ? originalSize - compressed.compressedSize : 0,
      savedPercent: compressed.savedPercent,
      format: detectFormat(compressed.buffer),
      dimensions: dimensions || undefined,
      exif: exif || undefined,
      ai: ai || undefined,
      processingTime,
      compressionMethod: compressed.method,
    },
  };
  
  return jsonResponse(response, 200, corsHeaders);
}

async function handleBatchUpload(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
  const startTime = Date.now();
  
  const formData = await req.formData();
  const bucket = (formData.get("bucket") as string) || "food-images";
  
  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("file") && value instanceof File) {
      files.push(value);
    }
  }
  
  if (files.length === 0) {
    return jsonResponse({ error: "No files provided" }, 400, corsHeaders);
  }
  
  const results: ImageUploadResponse[] = [];
  let succeeded = 0;
  let failed = 0;
  let totalSavedBytes = 0;
  
  for (const file of files) {
    try {
      const imageData = new Uint8Array(await file.arrayBuffer());
      const mockReq = new Request(req.url, {
        method: "POST",
        body: (() => {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("bucket", bucket);
          return fd;
        })(),
      });
      
      const result = await handleUpload(mockReq, corsHeaders);
      const data = await result.json() as ImageUploadResponse;
      
      results.push(data);
      succeeded++;
      totalSavedBytes += data.metadata.savedBytes;
    } catch (error) {
      failed++;
      console.error("Batch upload error:", error);
    }
  }
  
  const response: BatchUploadResponse = {
    success: failed === 0,
    results,
    summary: {
      total: files.length,
      succeeded,
      failed,
      totalSavedBytes,
      processingTime: Date.now() - startTime,
    },
  };
  
  return jsonResponse(response, 200, corsHeaders);
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
  });
}
