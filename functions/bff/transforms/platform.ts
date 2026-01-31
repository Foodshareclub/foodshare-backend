/**
 * Platform-Specific Response Transforms
 *
 * Shapes API responses based on client platform (iOS/Android/Web).
 * Adds platform-specific fields, removes unused data, and optimizes payloads.
 *
 * Features:
 * - iOS: ProMotion 120Hz hints, haptics, rich media support
 * - Android: Bandwidth optimization, Material Design hints, notification channels
 * - Web: SEO support, canonical URLs, service worker hints
 *
 * @version 2.0.0
 */

export type Platform = "ios" | "android" | "web" | "unknown";

/**
 * Base response data that can be transformed per-platform
 */
export interface TransformableData {
  [key: string]: unknown;
}

/**
 * Image size preset based on platform and use case
 */
export interface ImageSizePreset {
  width: number;
  height: number;
  quality: number;
  format: "webp" | "jpeg" | "avif" | "heic";
}

/**
 * Animation hints for smooth UI
 */
export interface AnimationHints {
  preferredFPS: 60 | 120;
  useSpringAnimations: boolean;
  reduceMotion: boolean;
  enableHaptics: boolean;
  transitionDuration: number; // ms
}

/**
 * Platform-specific response hints
 */
export interface PlatformHints {
  // Animation & Performance
  animation?: AnimationHints;

  // iOS-specific
  hapticFeedback?: boolean;
  deepLinkScheme?: string;
  proMotionEnabled?: boolean;
  dynamicIsland?: boolean;
  liveActivity?: boolean;

  // Android-specific
  vibration?: boolean;
  notificationChannelId?: string;
  materialYou?: boolean;
  adaptiveIcon?: boolean;
  predictiveBack?: boolean;

  // Web-specific
  analyticsEnabled?: boolean;
  serviceWorkerHint?: string;
  prefetchHint?: string[];
  canonicalUrl?: string;

  // Image optimization
  imagePreset?: ImageSizePreset;

  // Refresh behavior
  refreshAfterMs?: number;
  pullToRefresh?: boolean;
  infiniteScroll?: boolean;
}

/**
 * Platform capability detection
 */
export interface PlatformCapabilities {
  supportsHaptics: boolean;
  supportsHighRefreshRate: boolean;
  supportsPushNotifications: boolean;
  supportsBackgroundFetch: boolean;
  supportsOffline: boolean;
  maxImageSize: number; // pixels
  preferredImageFormat: "webp" | "jpeg" | "avif" | "heic";
  networkOptimization: "none" | "moderate" | "aggressive";
}

/**
 * Platform capabilities configuration
 */
const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  ios: {
    supportsHaptics: true,
    supportsHighRefreshRate: true, // ProMotion
    supportsPushNotifications: true,
    supportsBackgroundFetch: true,
    supportsOffline: true,
    maxImageSize: 2048,
    preferredImageFormat: "heic",
    networkOptimization: "moderate",
  },
  android: {
    supportsHaptics: true,
    supportsHighRefreshRate: true, // Most modern devices
    supportsPushNotifications: true,
    supportsBackgroundFetch: true,
    supportsOffline: true,
    maxImageSize: 1536,
    preferredImageFormat: "webp",
    networkOptimization: "aggressive", // More bandwidth conscious
  },
  web: {
    supportsHaptics: false,
    supportsHighRefreshRate: true,
    supportsPushNotifications: true,
    supportsBackgroundFetch: false,
    supportsOffline: true, // Service Worker
    maxImageSize: 1920,
    preferredImageFormat: "webp",
    networkOptimization: "none",
  },
  unknown: {
    supportsHaptics: false,
    supportsHighRefreshRate: false,
    supportsPushNotifications: false,
    supportsBackgroundFetch: false,
    supportsOffline: false,
    maxImageSize: 1024,
    preferredImageFormat: "jpeg",
    networkOptimization: "aggressive",
  },
};

/**
 * Get platform capabilities
 */
export function getPlatformCapabilities(platform: Platform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform];
}

/**
 * Deep link configuration per platform
 */
const DEEP_LINK_CONFIG = {
  ios: {
    scheme: "foodshare://",
    universalPrefix: "https://foodshare.club",
  },
  android: {
    scheme: "foodshare://",
    intentPrefix: "intent://foodshare.club",
  },
  web: {
    baseUrl: "https://foodshare.club",
  },
} as const;

/**
 * Generate a deep link for a specific resource
 */
export function generateDeepLink(
  platform: Platform,
  resourceType: "listing" | "profile" | "chat" | "notification",
  resourceId: string
): string {
  const path = `/${resourceType}/${resourceId}`;

  switch (platform) {
    case "ios":
      return `${DEEP_LINK_CONFIG.ios.scheme}${path}`;
    case "android":
      return `${DEEP_LINK_CONFIG.android.scheme}${path}`;
    case "web":
    default:
      return `${DEEP_LINK_CONFIG.web.baseUrl}${path}`;
  }
}

/**
 * Transform listing data for platform-specific needs
 */
export function transformListing<T extends TransformableData>(
  listing: T,
  platform: Platform
): T & { deepLink?: string; platformHints?: PlatformHints } {
  const listingId = listing.id as string;
  const deepLink = generateDeepLink(platform, "listing", listingId);

  const result = {
    ...listing,
    deepLink,
    platformHints: getPlatformHints(platform),
  };

  // Platform-specific field adjustments
  switch (platform) {
    case "ios":
      // iOS clients may need specific image formats
      return result;

    case "android":
      // Android may need notification channel hints
      return {
        ...result,
        platformHints: {
          ...result.platformHints,
          notificationChannelId: "listings",
        },
      };

    case "web":
      // Web may need analytics hooks
      return {
        ...result,
        platformHints: {
          ...result.platformHints,
          analyticsEnabled: true,
        },
      };

    default:
      return result;
  }
}

/**
 * Transform feed data with platform-specific optimizations
 */
export function transformFeed<T extends TransformableData>(
  data: {
    listings: T[];
    [key: string]: unknown;
  },
  platform: Platform
): typeof data & { platformHints: PlatformHints } {
  return {
    ...data,
    listings: data.listings.map((listing) => transformListing(listing, platform)),
    platformHints: getPlatformHints(platform),
  };
}

/**
 * Transform user profile for platform-specific needs
 */
export function transformProfile<T extends TransformableData>(
  profile: T,
  platform: Platform
): T & { deepLink?: string; platformHints?: PlatformHints } {
  const profileId = profile.id as string;
  const deepLink = generateDeepLink(platform, "profile", profileId);

  return {
    ...profile,
    deepLink,
    platformHints: getPlatformHints(platform),
  };
}

/**
 * Get platform-specific animation hints
 */
export function getAnimationHints(platform: Platform): AnimationHints {
  const capabilities = getPlatformCapabilities(platform);

  switch (platform) {
    case "ios":
      return {
        preferredFPS: 120, // ProMotion
        useSpringAnimations: true,
        reduceMotion: false,
        enableHaptics: true,
        transitionDuration: 350, // Slightly longer for spring animations
      };

    case "android":
      return {
        preferredFPS: 120, // Most modern Android devices support 90-120Hz
        useSpringAnimations: true, // Material 3 uses spring physics
        reduceMotion: false,
        enableHaptics: true,
        transitionDuration: 300, // Material motion spec
      };

    case "web":
      return {
        preferredFPS: 60, // Most browsers cap at 60
        useSpringAnimations: false,
        reduceMotion: false, // Should respect prefers-reduced-motion
        enableHaptics: false,
        transitionDuration: 200, // Snappier for web
      };

    default:
      return {
        preferredFPS: 60,
        useSpringAnimations: false,
        reduceMotion: true,
        enableHaptics: false,
        transitionDuration: 150,
      };
  }
}

/**
 * Get image size preset based on platform and use case
 */
export function getImagePreset(
  platform: Platform,
  useCase: "thumbnail" | "card" | "detail" | "full" = "card"
): ImageSizePreset {
  const capabilities = getPlatformCapabilities(platform);

  const presets: Record<typeof useCase, Record<Platform, ImageSizePreset>> = {
    thumbnail: {
      ios: { width: 150, height: 150, quality: 80, format: "heic" },
      android: { width: 120, height: 120, quality: 75, format: "webp" },
      web: { width: 150, height: 150, quality: 80, format: "webp" },
      unknown: { width: 100, height: 100, quality: 70, format: "jpeg" },
    },
    card: {
      ios: { width: 400, height: 300, quality: 85, format: "heic" },
      android: { width: 360, height: 270, quality: 80, format: "webp" },
      web: { width: 400, height: 300, quality: 85, format: "webp" },
      unknown: { width: 300, height: 225, quality: 75, format: "jpeg" },
    },
    detail: {
      ios: { width: 800, height: 600, quality: 90, format: "heic" },
      android: { width: 720, height: 540, quality: 85, format: "webp" },
      web: { width: 800, height: 600, quality: 90, format: "webp" },
      unknown: { width: 600, height: 450, quality: 80, format: "jpeg" },
    },
    full: {
      ios: { width: 2048, height: 1536, quality: 95, format: "heic" },
      android: { width: 1536, height: 1152, quality: 90, format: "webp" },
      web: { width: 1920, height: 1440, quality: 95, format: "webp" },
      unknown: { width: 1024, height: 768, quality: 85, format: "jpeg" },
    },
  };

  return presets[useCase][platform];
}

/**
 * Get platform-specific hints/flags
 */
export function getPlatformHints(
  platform: Platform,
  options?: {
    resourceId?: string;
    resourceType?: "listing" | "profile" | "chat";
    useCase?: "thumbnail" | "card" | "detail" | "full";
  }
): PlatformHints {
  const baseHints: PlatformHints = {
    animation: getAnimationHints(platform),
    imagePreset: getImagePreset(platform, options?.useCase || "card"),
    pullToRefresh: platform !== "web",
    infiniteScroll: true,
    refreshAfterMs: platform === "ios" ? 60000 : 120000, // iOS can refresh more often
  };

  switch (platform) {
    case "ios":
      return {
        ...baseHints,
        hapticFeedback: true,
        deepLinkScheme: DEEP_LINK_CONFIG.ios.scheme,
        proMotionEnabled: true,
        dynamicIsland: true, // Enable Dynamic Island support for live activities
        liveActivity: true,
      };

    case "android":
      return {
        ...baseHints,
        vibration: true,
        notificationChannelId: "default",
        materialYou: true, // Enable Material You theming hints
        adaptiveIcon: true,
        predictiveBack: true, // Android 14+ predictive back gesture
      };

    case "web":
      return {
        ...baseHints,
        analyticsEnabled: true,
        serviceWorkerHint: "update-available",
        prefetchHint: options?.resourceId
          ? [`/api/listing/${options.resourceId}`]
          : [],
        canonicalUrl: options?.resourceId && options?.resourceType
          ? `${DEEP_LINK_CONFIG.web.baseUrl}/${options.resourceType}/${options.resourceId}`
          : undefined,
        pullToRefresh: false, // Web uses manual refresh
      };

    default:
      return baseHints;
  }
}

/**
 * Transform image URL with platform-specific optimization parameters
 */
export function optimizeImageUrl(
  url: string | null | undefined,
  platform: Platform,
  useCase: "thumbnail" | "card" | "detail" | "full" = "card"
): string | null {
  if (!url) return null;

  const preset = getImagePreset(platform, useCase);

  // Check if this is a Supabase storage URL that supports transforms
  if (url.includes("supabase.co/storage") || url.includes("supabase.in/storage")) {
    // Supabase storage image transformation
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}width=${preset.width}&height=${preset.height}&quality=${preset.quality}&format=${preset.format}`;
  }

  // For CDN URLs that support transforms (e.g., Cloudinary, imgix)
  if (url.includes("cloudinary.com")) {
    // Cloudinary transformation
    const transformations = `w_${preset.width},h_${preset.height},q_${preset.quality},f_${preset.format}`;
    return url.replace("/upload/", `/upload/${transformations}/`);
  }

  // Return original URL if no transformation is supported
  return url;
}

/**
 * Optimize an array of image URLs
 */
export function optimizeImageUrls(
  urls: (string | null | undefined)[] | null | undefined,
  platform: Platform,
  useCase: "thumbnail" | "card" | "detail" | "full" = "card"
): string[] {
  if (!urls || !Array.isArray(urls)) return [];

  return urls
    .map((url) => optimizeImageUrl(url, platform, useCase))
    .filter((url): url is string => url !== null);
}

/**
 * Compress field names for bandwidth optimization (Android)
 * Maps verbose field names to shorter versions
 */
const FIELD_COMPRESSION_MAP: Record<string, string> = {
  displayName: "dn",
  description: "desc",
  createdAt: "cAt",
  updatedAt: "uAt",
  expiresAt: "eAt",
  avatarUrl: "av",
  imageUrl: "img",
  thumbnailUrl: "th",
  notificationChannelId: "nCh",
  deepLink: "dl",
  latitude: "lat",
  longitude: "lng",
  distanceKm: "dist",
  isVerified: "v",
  platformHints: "ph",
};

/**
 * Compress field names for bandwidth-constrained platforms
 */
function compressFieldNames<T extends TransformableData>(data: T): T {
  if (typeof data !== "object" || data === null) return data;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const compressedKey = FIELD_COMPRESSION_MAP[key] || key;

    if (Array.isArray(value)) {
      result[compressedKey] = value.map((item) =>
        typeof item === "object" && item !== null
          ? compressFieldNames(item as TransformableData)
          : item
      );
    } else if (typeof value === "object" && value !== null) {
      result[compressedKey] = compressFieldNames(value as TransformableData);
    } else {
      result[compressedKey] = value;
    }
  }

  return result as T;
}

/**
 * Optimize payload size for mobile platforms
 * Removes fields not needed by mobile clients
 */
export function optimizeForMobile<T extends TransformableData>(
  data: T,
  platform: Platform,
  options?: {
    compressFields?: boolean;
    optimizeImages?: boolean;
    imageUseCase?: "thumbnail" | "card" | "detail" | "full";
  }
): T {
  const capabilities = getPlatformCapabilities(platform);

  // Web gets full payload
  if (platform === "web") {
    return data;
  }

  // Mobile platforms: remove potentially large fields if not essential
  const { __debug, __meta, __trace, __timing, ...rest } = data as T & {
    __debug?: unknown;
    __meta?: unknown;
    __trace?: unknown;
    __timing?: unknown;
  };

  let optimized = rest as T;

  // Optimize image URLs for platform
  if (options?.optimizeImages !== false) {
    optimized = optimizeImages(optimized, platform, options?.imageUseCase || "card");
  }

  // Compress field names for aggressive bandwidth optimization (Android with poor connection)
  if (options?.compressFields && capabilities.networkOptimization === "aggressive") {
    optimized = compressFieldNames(optimized);
  }

  return optimized;
}

/**
 * Recursively optimize image URLs in a data structure
 */
function optimizeImages<T extends TransformableData>(
  data: T,
  platform: Platform,
  useCase: "thumbnail" | "card" | "detail" | "full"
): T {
  if (typeof data !== "object" || data === null) return data;

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Detect image URL fields
    const isImageField =
      key.toLowerCase().includes("image") ||
      key.toLowerCase().includes("avatar") ||
      key.toLowerCase().includes("thumbnail") ||
      key.toLowerCase().includes("photo");

    if (isImageField && typeof value === "string") {
      result[key] = optimizeImageUrl(value, platform, useCase);
    } else if (isImageField && Array.isArray(value)) {
      result[key] = optimizeImageUrls(value, platform, useCase);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null
          ? optimizeImages(item as TransformableData, platform, useCase)
          : item
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = optimizeImages(value as TransformableData, platform, useCase);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Transform options
 */
export interface TransformOptions {
  resourceType?: "listing" | "profile" | "feed" | "dashboard" | "notification";
  imageUseCase?: "thumbnail" | "card" | "detail" | "full";
  compressFields?: boolean;
  includeCapabilities?: boolean;
  resourceId?: string;
}

/**
 * Apply all platform transforms to a response
 */
export function transformForPlatform<T extends TransformableData>(
  data: T,
  platform: Platform,
  resourceTypeOrOptions?: "listing" | "profile" | "feed" | TransformOptions
): T & {
  platformHints?: PlatformHints;
  capabilities?: PlatformCapabilities;
} {
  // Normalize options
  const options: TransformOptions =
    typeof resourceTypeOrOptions === "string"
      ? { resourceType: resourceTypeOrOptions }
      : resourceTypeOrOptions || {};

  const { resourceType, imageUseCase, compressFields, includeCapabilities, resourceId } = options;

  // Apply mobile optimizations
  const optimized = optimizeForMobile(data, platform, {
    compressFields,
    optimizeImages: true,
    imageUseCase: imageUseCase || (resourceType === "feed" ? "card" : "detail"),
  });

  // Get hints with resource context
  const hints = getPlatformHints(platform, {
    resourceId,
    resourceType: resourceType === "listing" || resourceType === "profile"
      ? resourceType
      : undefined,
    useCase: imageUseCase,
  });

  // Base result
  let result: T & { platformHints?: PlatformHints; capabilities?: PlatformCapabilities } = {
    ...optimized,
    platformHints: hints,
  };

  // Include capabilities if requested
  if (includeCapabilities) {
    result.capabilities = getPlatformCapabilities(platform);
  }

  // Apply resource-specific transforms
  switch (resourceType) {
    case "listing":
      return transformListing(result, platform) as typeof result;

    case "profile":
      return transformProfile(result, platform) as typeof result;

    case "feed":
      if ("listings" in result && Array.isArray(result.listings)) {
        return transformFeed(
          result as { listings: TransformableData[]; [key: string]: unknown },
          platform
        ) as typeof result;
      }
      return result;

    case "dashboard":
      // Dashboard-specific transforms
      return transformDashboard(result, platform) as typeof result;

    case "notification":
      // Notification-specific transforms
      return transformNotification(result, platform) as typeof result;

    default:
      return result;
  }
}

/**
 * Transform dashboard data with platform-specific optimizations
 */
export function transformDashboard<T extends TransformableData>(
  data: T,
  platform: Platform
): T & { platformHints?: PlatformHints } {
  const hints = getPlatformHints(platform, { useCase: "thumbnail" });

  // Add platform-specific dashboard hints
  const dashboardHints: PlatformHints = {
    ...hints,
    // Dashboard refreshes more frequently
    refreshAfterMs: platform === "ios" ? 30000 : 60000,
  };

  // For iOS, add Live Activity hint for active listings
  if (platform === "ios" && "stats" in data) {
    const stats = data.stats as Record<string, unknown>;
    if (stats && typeof stats.activeListings === "number" && stats.activeListings > 0) {
      dashboardHints.liveActivity = true;
    }
  }

  return {
    ...data,
    platformHints: dashboardHints,
  };
}

/**
 * Transform notification data with platform-specific optimizations
 */
export function transformNotification<T extends TransformableData>(
  data: T,
  platform: Platform
): T & { platformHints?: PlatformHints } {
  const baseHints = getPlatformHints(platform);

  const notificationHints: PlatformHints = {
    ...baseHints,
  };

  // Platform-specific notification handling
  switch (platform) {
    case "ios":
      notificationHints.hapticFeedback = true;
      break;

    case "android":
      // Determine notification channel based on type
      if ("type" in data) {
        const type = data.type as string;
        switch (type) {
          case "message":
            notificationHints.notificationChannelId = "messages";
            break;
          case "listing":
            notificationHints.notificationChannelId = "listings";
            break;
          case "alert":
            notificationHints.notificationChannelId = "alerts";
            break;
          default:
            notificationHints.notificationChannelId = "default";
        }
      }
      break;

    case "web":
      // Web notifications don't need special handling
      break;
  }

  return {
    ...data,
    platformHints: notificationHints,
  };
}

// Note: getAnimationHints, getImagePreset, optimizeImageUrl, optimizeImageUrls
// are exported at their function declarations above
