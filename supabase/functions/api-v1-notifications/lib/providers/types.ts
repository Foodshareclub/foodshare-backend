/**
 * Push Provider Types
 */

export type Platform = "ios" | "android" | "web";

export interface IOSPayloadOptions {
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
  relevanceScore?: number;
  targetContentId?: string;
  subtitle?: string;
  category?: string;
  threadId?: string;
  liveActivityToken?: string;
}

export interface AndroidPayloadOptions {
  channelId?: "default" | "messages" | "listings" | "alerts" | "updates" | "social";
  visibility?: "private" | "public" | "secret";
  groupKey?: string;
  groupSummary?: boolean;
  ongoing?: boolean;
  autoCancel?: boolean;
  localOnly?: boolean;
  ticker?: string;
  vibrationPattern?: number[];
  lightColor?: string;
  smallIcon?: string;
  largeIcon?: string;
}

export interface WebPayloadOptions {
  requireInteraction?: boolean;
  renotify?: boolean;
  silent?: boolean;
  vibrate?: number[];
  timestamp?: number;
  dir?: "auto" | "ltr" | "rtl";
}

export interface DeepLinkConfig {
  entityType: "listing" | "profile" | "chat" | "notification";
  entityId: string;
}

export interface PushPayload {
  type: string;
  title: string;
  body: string;
  icon?: string;
  badge?: string | number;
  image?: string;
  url?: string;
  tag?: string;
  data?: Record<string, string>;
  sound?: string;
  priority?: "high" | "normal";
  ttl?: number;
  collapseKey?: string;
  actions?: Array<{ action: string; title: string; icon?: string }>;
  ios?: IOSPayloadOptions;
  android?: AndroidPayloadOptions;
  web?: WebPayloadOptions;
  deepLink?: DeepLinkConfig;
}

export interface DeviceToken {
  profile_id: string;
  token: string;
  platform: Platform;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
}

export interface SendResult {
  success: boolean;
  platform: Platform;
  token?: string;
  messageId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export const DEEP_LINK_CONFIG = {
  ios: { scheme: "foodshare://" },
  android: { scheme: "foodshare://" },
  web: { baseUrl: "https://foodshare.club" },
} as const;

export function generateDeepLink(platform: Platform, deepLink: DeepLinkConfig): string {
  const path = `/${deepLink.entityType}/${deepLink.entityId}`;
  switch (platform) {
    case "ios":
      return `${DEEP_LINK_CONFIG.ios.scheme}${path}`;
    case "android":
      return `${DEEP_LINK_CONFIG.android.scheme}${path}`;
    case "web":
      return `${DEEP_LINK_CONFIG.web.baseUrl}${path}`;
  }
}
