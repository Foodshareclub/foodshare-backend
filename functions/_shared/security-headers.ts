/**
 * Security Headers Middleware
 *
 * Implements modern security headers for Edge Functions:
 * - Content Security Policy (CSP)
 * - Permissions Policy
 * - HSTS (Strict Transport Security)
 * - X-Content-Type-Options
 * - X-Frame-Options
 * - Referrer-Policy
 * - Cross-Origin headers
 *
 * @module
 */

// =============================================================================
// Types
// =============================================================================

export interface SecurityHeadersConfig {
  /** Content Security Policy directives */
  csp?: CSPDirectives;
  /** Permissions Policy directives */
  permissions?: PermissionsPolicyDirectives;
  /** HSTS configuration */
  hsts?: HSTSConfig;
  /** X-Frame-Options value */
  frameOptions?: "DENY" | "SAMEORIGIN";
  /** Referrer-Policy value */
  referrerPolicy?: ReferrerPolicy;
  /** Enable COEP (Cross-Origin-Embedder-Policy) */
  coep?: boolean;
  /** Enable COOP (Cross-Origin-Opener-Policy) */
  coop?: boolean;
  /** Enable CORP (Cross-Origin-Resource-Policy) */
  corp?: "same-origin" | "same-site" | "cross-origin";
  /** Custom headers */
  custom?: Record<string, string>;
}

export interface CSPDirectives {
  "default-src"?: string[];
  "script-src"?: string[];
  "style-src"?: string[];
  "img-src"?: string[];
  "font-src"?: string[];
  "connect-src"?: string[];
  "media-src"?: string[];
  "object-src"?: string[];
  "frame-src"?: string[];
  "frame-ancestors"?: string[];
  "form-action"?: string[];
  "base-uri"?: string[];
  "upgrade-insecure-requests"?: boolean;
  "block-all-mixed-content"?: boolean;
}

export interface PermissionsPolicyDirectives {
  accelerometer?: string[];
  camera?: string[];
  "display-capture"?: string[];
  "encrypted-media"?: string[];
  fullscreen?: string[];
  geolocation?: string[];
  gyroscope?: string[];
  magnetometer?: string[];
  microphone?: string[];
  midi?: string[];
  payment?: string[];
  "picture-in-picture"?: string[];
  "publickey-credentials-get"?: string[];
  "screen-wake-lock"?: string[];
  usb?: string[];
  "web-share"?: string[];
  "xr-spatial-tracking"?: string[];
}

export interface HSTSConfig {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

export type ReferrerPolicy =
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: SecurityHeadersConfig = {
  csp: {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"], // Needed for some frameworks
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    "connect-src": ["'self'", "https://*.supabase.co", "https://*.supabase.in"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "upgrade-insecure-requests": true,
  },
  permissions: {
    camera: [],
    microphone: [],
    geolocation: ["self"],
    payment: [],
    usb: [],
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  frameOptions: "DENY",
  referrerPolicy: "strict-origin-when-cross-origin",
  coep: false, // Can break third-party resources
  coop: true,
  corp: "same-origin",
};

// API-specific configuration (more permissive for JSON APIs)
const API_CONFIG: SecurityHeadersConfig = {
  csp: {
    "default-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  },
  permissions: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  frameOptions: "DENY",
  referrerPolicy: "no-referrer",
  coep: false,
  coop: false,
  corp: "cross-origin", // Allow cross-origin API access
};

// =============================================================================
// Header Builders
// =============================================================================

function buildCSPHeader(directives: CSPDirectives): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(directives)) {
    if (value === true) {
      parts.push(key);
    } else if (value === false) {
      continue;
    } else if (Array.isArray(value) && value.length > 0) {
      parts.push(`${key} ${value.join(" ")}`);
    }
  }

  return parts.join("; ");
}

function buildPermissionsPolicyHeader(directives: PermissionsPolicyDirectives): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(directives)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        parts.push(`${key}=()`);
      } else {
        const values = value.map((v) => (v === "self" ? "self" : `"${v}"`)).join(" ");
        parts.push(`${key}=(${values})`);
      }
    }
  }

  return parts.join(", ");
}

function buildHSTSHeader(config: HSTSConfig): string {
  const parts = [`max-age=${config.maxAge || 31536000}`];

  if (config.includeSubDomains) {
    parts.push("includeSubDomains");
  }

  if (config.preload) {
    parts.push("preload");
  }

  return parts.join("; ");
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Get security headers as a record
 */
export function getSecurityHeaders(config: SecurityHeadersConfig = DEFAULT_CONFIG): Record<string, string> {
  const headers: Record<string, string> = {};

  // Content Security Policy
  if (config.csp) {
    headers["Content-Security-Policy"] = buildCSPHeader(config.csp);
  }

  // Permissions Policy
  if (config.permissions) {
    headers["Permissions-Policy"] = buildPermissionsPolicyHeader(config.permissions);
  }

  // HSTS
  if (config.hsts) {
    headers["Strict-Transport-Security"] = buildHSTSHeader(config.hsts);
  }

  // X-Frame-Options
  if (config.frameOptions) {
    headers["X-Frame-Options"] = config.frameOptions;
  }

  // Referrer Policy
  if (config.referrerPolicy) {
    headers["Referrer-Policy"] = config.referrerPolicy;
  }

  // X-Content-Type-Options (always set)
  headers["X-Content-Type-Options"] = "nosniff";

  // X-DNS-Prefetch-Control
  headers["X-DNS-Prefetch-Control"] = "off";

  // X-Download-Options (IE)
  headers["X-Download-Options"] = "noopen";

  // X-Permitted-Cross-Domain-Policies
  headers["X-Permitted-Cross-Domain-Policies"] = "none";

  // Cross-Origin headers
  if (config.coep) {
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }

  if (config.coop) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
  }

  if (config.corp) {
    headers["Cross-Origin-Resource-Policy"] = config.corp;
  }

  // Custom headers
  if (config.custom) {
    Object.assign(headers, config.custom);
  }

  return headers;
}

/**
 * Get security headers for API endpoints
 */
export function getAPISecurityHeaders(customConfig?: Partial<SecurityHeadersConfig>): Record<string, string> {
  return getSecurityHeaders({ ...API_CONFIG, ...customConfig });
}

/**
 * Apply security headers to a Response
 */
export function applySecurityHeaders(
  response: Response,
  config: SecurityHeadersConfig = API_CONFIG
): Response {
  const securityHeaders = getSecurityHeaders(config);
  const newHeaders = new Headers(response.headers);

  for (const [key, value] of Object.entries(securityHeaders)) {
    // Don't override existing headers
    if (!newHeaders.has(key)) {
      newHeaders.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Security headers middleware for handlers
 */
export function withSecurityHeaders<T extends (...args: unknown[]) => Promise<Response>>(
  handler: T,
  config: SecurityHeadersConfig = API_CONFIG
): T {
  return (async (...args: unknown[]) => {
    const response = await handler(...args);
    return applySecurityHeaders(response, config);
  }) as T;
}

// =============================================================================
// Presets
// =============================================================================

export const SecurityPresets = {
  /** Default API security headers */
  api: API_CONFIG,

  /** Strict security for sensitive endpoints */
  strict: {
    ...API_CONFIG,
    csp: {
      "default-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'none'"],
      "base-uri": ["'none'"],
    },
    coep: true,
    coop: true,
    corp: "same-origin" as const,
  },

  /** Permissive for public APIs */
  public: {
    ...API_CONFIG,
    corp: "cross-origin" as const,
    coop: false,
  },

  /** For webhook endpoints (no CSP) */
  webhook: {
    hsts: API_CONFIG.hsts,
    frameOptions: "DENY" as const,
    referrerPolicy: "no-referrer" as const,
    corp: "cross-origin" as const,
  },
} as const;

// =============================================================================
// Rate Limit Headers Helper
// =============================================================================

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp
  retryAfter?: number; // Seconds
}

export function getRateLimitHeaders(info: RateLimitInfo): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": info.limit.toString(),
    "X-RateLimit-Remaining": info.remaining.toString(),
    "X-RateLimit-Reset": info.reset.toString(),
    "RateLimit-Limit": info.limit.toString(),
    "RateLimit-Remaining": info.remaining.toString(),
    "RateLimit-Reset": info.reset.toString(),
  };

  if (info.retryAfter !== undefined) {
    headers["Retry-After"] = info.retryAfter.toString();
  }

  return headers;
}
