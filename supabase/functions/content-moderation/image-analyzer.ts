/**
 * Image Content Analyzer
 *
 * Analyzes images for policy violations including:
 * - NSFW content detection
 * - Violence/gore detection
 * - Non-food content detection
 * - Image quality assessment
 * - Text extraction (OCR) for further analysis
 */

// Image analysis categories
export type ImageCategory =
  | "food"
  | "non_food"
  | "nsfw"
  | "violence"
  | "text_heavy"
  | "low_quality"
  | "unknown";

// Image analysis result
export interface ImageAnalysisResult {
  isAcceptable: boolean;
  category: ImageCategory;
  confidence: number;
  flags: ImageFlag[];
  metadata: ImageMetadata;
  recommendations: string[];
}

// Individual image flag
export interface ImageFlag {
  type: ImageFlagType;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  region?: { x: number; y: number; width: number; height: number };
  description: string;
}

export type ImageFlagType =
  | "nsfw"
  | "violence"
  | "non_food"
  | "text_content"
  | "low_resolution"
  | "blurry"
  | "watermark"
  | "stock_photo"
  | "screenshot"
  | "prohibited_item";

// Image metadata
export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
  hasExif: boolean;
  dominantColors: string[];
  aspectRatio: number;
}

// Minimum requirements for food listing images
const IMAGE_REQUIREMENTS = {
  minWidth: 200,
  minHeight: 200,
  maxWidth: 10000,
  maxHeight: 10000,
  maxSizeBytes: 20 * 1024 * 1024, // 20MB
  allowedFormats: ["jpeg", "jpg", "png", "webp", "heic"],
  minAspectRatio: 0.25, // 1:4
  maxAspectRatio: 4.0, // 4:1
};

// Food-related color ranges (for basic heuristics)
const FOOD_COLOR_HINTS = [
  { name: "warm_brown", min: [100, 50, 20], max: [180, 140, 80] },
  { name: "green", min: [40, 100, 40], max: [120, 180, 120] },
  { name: "red", min: [150, 30, 30], max: [255, 100, 100] },
  { name: "orange", min: [200, 100, 30], max: [255, 180, 80] },
  { name: "yellow", min: [200, 180, 50], max: [255, 255, 150] },
];

/**
 * Analyze an image for content moderation
 * Note: In production, this would integrate with ML services like:
 * - Google Cloud Vision API
 * - AWS Rekognition
 * - Azure Computer Vision
 * - OpenAI Vision API
 */
export async function analyzeImage(
  imageData: Uint8Array,
  mimeType: string
): Promise<ImageAnalysisResult> {
  const flags: ImageFlag[] = [];
  const recommendations: string[] = [];

  // Get basic metadata
  const metadata = await getImageMetadata(imageData, mimeType);

  // Check image requirements
  const requirementFlags = checkImageRequirements(metadata);
  flags.push(...requirementFlags);

  // Check for screenshots (common pattern)
  if (isLikelyScreenshot(metadata)) {
    flags.push({
      type: "screenshot",
      severity: "low",
      confidence: 0.7,
      description: "Image appears to be a screenshot",
    });
    recommendations.push("Please use actual photos of the food item");
  }

  // Check aspect ratio for unusual images
  if (metadata.aspectRatio < IMAGE_REQUIREMENTS.minAspectRatio ||
      metadata.aspectRatio > IMAGE_REQUIREMENTS.maxAspectRatio) {
    flags.push({
      type: "low_quality",
      severity: "low",
      confidence: 0.8,
      description: "Unusual aspect ratio",
    });
  }

  // Simulate ML-based content analysis
  // In production, this would call external ML services
  const contentAnalysis = await simulateContentAnalysis(imageData, metadata);
  flags.push(...contentAnalysis.flags);

  // Determine overall category
  const category = determineCategory(flags, contentAnalysis);
  const isAcceptable = isImageAcceptable(flags, category);

  // Generate recommendations
  recommendations.push(...generateImageRecommendations(flags));

  return {
    isAcceptable,
    category,
    confidence: calculateOverallConfidence(flags, contentAnalysis),
    flags,
    metadata,
    recommendations,
  };
}

/**
 * Quick check for obvious issues
 */
export async function quickImageCheck(
  imageData: Uint8Array,
  mimeType: string
): Promise<{ acceptable: boolean; reason?: string }> {
  // Check file size
  if (imageData.length > IMAGE_REQUIREMENTS.maxSizeBytes) {
    return { acceptable: false, reason: "Image file too large" };
  }

  // Check format
  const format = getFormatFromMime(mimeType);
  if (!IMAGE_REQUIREMENTS.allowedFormats.includes(format)) {
    return { acceptable: false, reason: "Unsupported image format" };
  }

  // Quick header check for corrupted files
  if (!hasValidImageHeader(imageData, format)) {
    return { acceptable: false, reason: "Invalid or corrupted image file" };
  }

  return { acceptable: true };
}

/**
 * Get image metadata
 */
async function getImageMetadata(
  imageData: Uint8Array,
  mimeType: string
): Promise<ImageMetadata> {
  const format = getFormatFromMime(mimeType);

  // Get dimensions from header
  const dimensions = getDimensionsFromHeader(imageData, format);

  return {
    width: dimensions.width,
    height: dimensions.height,
    format,
    sizeBytes: imageData.length,
    hasExif: hasExifData(imageData),
    dominantColors: extractDominantColors(imageData),
    aspectRatio: dimensions.width / dimensions.height,
  };
}

/**
 * Check if image meets requirements
 */
function checkImageRequirements(metadata: ImageMetadata): ImageFlag[] {
  const flags: ImageFlag[] = [];

  if (metadata.width < IMAGE_REQUIREMENTS.minWidth ||
      metadata.height < IMAGE_REQUIREMENTS.minHeight) {
    flags.push({
      type: "low_resolution",
      severity: "medium",
      confidence: 1.0,
      description: `Image too small (${metadata.width}x${metadata.height}). Minimum: ${IMAGE_REQUIREMENTS.minWidth}x${IMAGE_REQUIREMENTS.minHeight}`,
    });
  }

  if (metadata.width > IMAGE_REQUIREMENTS.maxWidth ||
      metadata.height > IMAGE_REQUIREMENTS.maxHeight) {
    flags.push({
      type: "low_quality",
      severity: "low",
      confidence: 1.0,
      description: "Image dimensions exceed maximum allowed",
    });
  }

  if (metadata.sizeBytes > IMAGE_REQUIREMENTS.maxSizeBytes) {
    flags.push({
      type: "low_quality",
      severity: "medium",
      confidence: 1.0,
      description: "Image file size too large",
    });
  }

  return flags;
}

/**
 * Simulate ML content analysis
 * In production, this would call actual ML services
 */
async function simulateContentAnalysis(
  _imageData: Uint8Array,
  metadata: ImageMetadata
): Promise<{ flags: ImageFlag[]; scores: Record<string, number> }> {
  const flags: ImageFlag[] = [];
  const scores: Record<string, number> = {
    food: 0.8, // Default to likely food
    nsfw: 0.05,
    violence: 0.02,
    text: 0.1,
  };

  // Check dominant colors for food likelihood
  const hasFoodColors = metadata.dominantColors.some((color) =>
    isFoodLikeColor(hexToRgb(color))
  );

  if (!hasFoodColors) {
    scores.food = 0.4;
    scores.non_food = 0.6;
    flags.push({
      type: "non_food",
      severity: "medium",
      confidence: 0.6,
      description: "Image may not contain food",
    });
  }

  return { flags, scores };
}

/**
 * Determine image category
 */
function determineCategory(
  flags: ImageFlag[],
  analysis: { scores: Record<string, number> }
): ImageCategory {
  // Check for critical flags first
  if (flags.some((f) => f.type === "nsfw" && f.severity === "critical")) {
    return "nsfw";
  }
  if (flags.some((f) => f.type === "violence" && f.severity === "critical")) {
    return "violence";
  }

  // Use scores
  const { scores } = analysis;
  if (scores.nsfw > 0.7) return "nsfw";
  if (scores.violence > 0.7) return "violence";
  if (scores.text > 0.8) return "text_heavy";
  if (scores.food > 0.5) return "food";
  if (scores.non_food > 0.6) return "non_food";

  // Check quality flags
  if (flags.some((f) => f.type === "low_resolution" || f.type === "blurry")) {
    return "low_quality";
  }

  return "food"; // Default assumption for food sharing app
}

/**
 * Check if image is acceptable
 */
function isImageAcceptable(flags: ImageFlag[], category: ImageCategory): boolean {
  // Critical flags always reject
  if (flags.some((f) => f.severity === "critical")) {
    return false;
  }

  // Certain categories are not acceptable
  if (["nsfw", "violence"].includes(category)) {
    return false;
  }

  // Multiple high-severity flags
  const highSeverityCount = flags.filter((f) => f.severity === "high").length;
  if (highSeverityCount >= 2) {
    return false;
  }

  return true;
}

/**
 * Check if image is likely a screenshot
 */
function isLikelyScreenshot(metadata: ImageMetadata): boolean {
  // Common screenshot dimensions
  const screenshotDimensions = [
    { w: 1170, h: 2532 }, // iPhone 12/13/14
    { w: 1284, h: 2778 }, // iPhone 12/13/14 Pro Max
    { w: 1080, h: 2340 }, // Common Android
    { w: 1080, h: 1920 }, // Common Android
    { w: 1920, h: 1080 }, // Desktop
    { w: 2560, h: 1440 }, // Desktop
  ];

  return screenshotDimensions.some(
    (dim) =>
      (metadata.width === dim.w && metadata.height === dim.h) ||
      (metadata.width === dim.h && metadata.height === dim.w)
  );
}

/**
 * Generate recommendations for image issues
 */
function generateImageRecommendations(flags: ImageFlag[]): string[] {
  const recommendations: string[] = [];
  const types = new Set(flags.map((f) => f.type));

  if (types.has("low_resolution")) {
    recommendations.push("Please upload a higher resolution image");
  }
  if (types.has("blurry")) {
    recommendations.push("Please upload a clearer image");
  }
  if (types.has("non_food")) {
    recommendations.push("Please upload an image of the food item");
  }
  if (types.has("screenshot")) {
    recommendations.push("Please take a photo of the actual food item");
  }
  if (types.has("text_content")) {
    recommendations.push("Images should primarily show the food, not text");
  }
  if (types.has("watermark")) {
    recommendations.push("Please use your own photos without watermarks");
  }

  return recommendations;
}

/**
 * Calculate overall confidence
 */
function calculateOverallConfidence(
  flags: ImageFlag[],
  analysis: { scores: Record<string, number> }
): number {
  if (flags.length === 0) {
    return Math.max(...Object.values(analysis.scores));
  }

  const avgFlagConfidence =
    flags.reduce((sum, f) => sum + f.confidence, 0) / flags.length;

  return Math.min(1.0, avgFlagConfidence);
}

// Helper functions

function getFormatFromMime(mimeType: string): string {
  const formatMap: Record<string, string> = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heic",
  };
  return formatMap[mimeType.toLowerCase()] || "unknown";
}

function hasValidImageHeader(data: Uint8Array, format: string): boolean {
  if (data.length < 8) return false;

  const signatures: Record<string, number[]> = {
    jpeg: [0xff, 0xd8, 0xff],
    jpg: [0xff, 0xd8, 0xff],
    png: [0x89, 0x50, 0x4e, 0x47],
    webp: [0x52, 0x49, 0x46, 0x46], // RIFF
  };

  const sig = signatures[format];
  if (!sig) return true; // Allow unknown formats through

  return sig.every((byte, i) => data[i] === byte);
}

function getDimensionsFromHeader(
  data: Uint8Array,
  format: string
): { width: number; height: number } {
  // Simplified dimension extraction
  // In production, use proper image parsing library
  if (format === "png" && data.length > 24) {
    const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
    const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
    return { width, height };
  }

  // Default fallback
  return { width: 800, height: 600 };
}

function hasExifData(data: Uint8Array): boolean {
  // Look for Exif marker in JPEG
  const exifMarker = [0x45, 0x78, 0x69, 0x66]; // "Exif"
  for (let i = 0; i < Math.min(data.length - 4, 100); i++) {
    if (exifMarker.every((b, j) => data[i + j] === b)) {
      return true;
    }
  }
  return false;
}

function extractDominantColors(_data: Uint8Array): string[] {
  // Simplified - in production use color quantization
  return ["#8B4513", "#228B22", "#FF6347"]; // Brown, green, tomato
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : [0, 0, 0];
}

function isFoodLikeColor(rgb: [number, number, number]): boolean {
  return FOOD_COLOR_HINTS.some(
    (hint) =>
      rgb[0] >= hint.min[0] &&
      rgb[0] <= hint.max[0] &&
      rgb[1] >= hint.min[1] &&
      rgb[1] <= hint.max[1] &&
      rgb[2] >= hint.min[2] &&
      rgb[2] <= hint.max[2]
  );
}

export { IMAGE_REQUIREMENTS };
