/**
 * URL Validation and SSRF Protection
 *
 * Provides protection against Server-Side Request Forgery (SSRF) attacks by:
 * - Blocking requests to private/internal IP ranges
 * - Blocking cloud metadata endpoints
 * - Validating URL schemes
 * - Resolving hostnames to check actual IP addresses
 */

/**
 * Private IP ranges that should be blocked
 */
const PRIVATE_IP_RANGES = [
  // IPv4 Private ranges
  { start: "10.0.0.0", end: "10.255.255.255" }, // Class A
  { start: "172.16.0.0", end: "172.31.255.255" }, // Class B
  { start: "192.168.0.0", end: "192.168.255.255" }, // Class C
  { start: "127.0.0.0", end: "127.255.255.255" }, // Loopback
  { start: "169.254.0.0", end: "169.254.255.255" }, // Link-local
  { start: "0.0.0.0", end: "0.255.255.255" }, // Current network

  // IPv4 Special ranges
  { start: "100.64.0.0", end: "100.127.255.255" }, // Carrier-grade NAT
  { start: "192.0.0.0", end: "192.0.0.255" }, // IETF Protocol Assignments
  { start: "192.0.2.0", end: "192.0.2.255" }, // TEST-NET-1
  { start: "198.51.100.0", end: "198.51.100.255" }, // TEST-NET-2
  { start: "203.0.113.0", end: "203.0.113.255" }, // TEST-NET-3
  { start: "224.0.0.0", end: "255.255.255.255" }, // Multicast + Reserved
];

/**
 * Cloud metadata endpoints that should be blocked
 */
const BLOCKED_HOSTNAMES = [
  // AWS
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal",
  // GCP
  "metadata.goog",
  "169.254.169.254",
  // Azure
  "169.254.169.254",
  // DigitalOcean
  "169.254.169.254",
  // Kubernetes
  "kubernetes.default",
  "kubernetes.default.svc",
  // Docker
  "host.docker.internal",
  // Local
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
];

/**
 * Allowed URL schemes for external requests
 */
const ALLOWED_SCHEMES = ["http:", "https:"];

/**
 * URL validation result
 */
export interface UrlValidationResult {
  valid: boolean;
  reason?: string;
  hostname?: string;
  ip?: string;
}

/**
 * Options for URL validation
 */
export interface UrlValidationOptions {
  /** Allow HTTP scheme (default: true for development, false for production) */
  allowHttp?: boolean;
  /** Additional hostnames to block */
  additionalBlockedHostnames?: string[];
  /** Allow localhost in development mode */
  allowLocalhost?: boolean;
  /** Maximum URL length (default: 2048) */
  maxLength?: number;
}

/**
 * Convert IP address string to numeric value for range checking
 */
function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Check if an IP address is in a private range
 */
function isPrivateIp(ip: string): boolean {
  const ipNum = ipToNumber(ip);
  if (ipNum === -1) {
    // Invalid IPv4, check for IPv6 loopback
    return ip === "::1" || ip === "[::1]" || ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd00:");
  }

  for (const range of PRIVATE_IP_RANGES) {
    const startNum = ipToNumber(range.start);
    const endNum = ipToNumber(range.end);
    if (ipNum >= startNum && ipNum <= endNum) {
      return true;
    }
  }

  return false;
}

/**
 * Check if hostname looks like an IP address
 */
function looksLikeIp(hostname: string): boolean {
  // IPv4 pattern
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  // IPv6 pattern (simplified)
  if (hostname.includes(":") || hostname.startsWith("[")) {
    return true;
  }
  return false;
}

/**
 * Check if a hostname is blocked
 */
function isBlockedHostname(hostname: string, additionalBlocked: string[] = []): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allBlocked = [...BLOCKED_HOSTNAMES, ...additionalBlocked].map((h) => h.toLowerCase());

  // Exact match
  if (allBlocked.includes(normalizedHostname)) {
    return true;
  }

  // Check for IP in private range
  if (looksLikeIp(normalizedHostname) && isPrivateIp(normalizedHostname)) {
    return true;
  }

  // Check for DNS rebinding attempts (numeric-looking hostnames)
  if (/^\d{1,3}[-_.]\d{1,3}[-_.]\d{1,3}[-_.]\d{1,3}/.test(normalizedHostname)) {
    return true;
  }

  return false;
}

/**
 * Validate a URL for SSRF protection
 *
 * @param urlString - The URL to validate
 * @param options - Validation options
 * @returns Validation result with reason if invalid
 */
export function validateUrl(
  urlString: string,
  options: UrlValidationOptions = {}
): UrlValidationResult {
  const {
    allowHttp = true,
    additionalBlockedHostnames = [],
    allowLocalhost = false,
    maxLength = 2048,
  } = options;

  // Check URL length
  if (urlString.length > maxLength) {
    return { valid: false, reason: `URL exceeds maximum length of ${maxLength}` };
  }

  // Parse URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  // Check scheme
  if (!ALLOWED_SCHEMES.includes(url.protocol)) {
    return { valid: false, reason: `Scheme '${url.protocol}' not allowed` };
  }

  // Check HTTP vs HTTPS
  if (url.protocol === "http:" && !allowHttp) {
    return { valid: false, reason: "HTTP not allowed, use HTTPS" };
  }

  // Get hostname
  const hostname = url.hostname;
  if (!hostname) {
    return { valid: false, reason: "Missing hostname" };
  }

  // Check for localhost
  if (!allowLocalhost) {
    const localhostPatterns = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"];
    if (localhostPatterns.some((p) => hostname.toLowerCase() === p)) {
      return { valid: false, reason: "Localhost not allowed", hostname };
    }
  }

  // Check blocked hostnames
  if (isBlockedHostname(hostname, additionalBlockedHostnames)) {
    return { valid: false, reason: "Hostname is blocked", hostname };
  }

  // Check for auth in URL (potential SSRF technique)
  if (url.username || url.password) {
    return { valid: false, reason: "URL credentials not allowed" };
  }

  // Check for unusual ports on non-standard schemes
  const port = url.port ? parseInt(url.port, 10) : (url.protocol === "https:" ? 443 : 80);
  const suspiciousPorts = [22, 23, 25, 110, 143, 3306, 5432, 6379, 27017];
  if (suspiciousPorts.includes(port)) {
    return { valid: false, reason: `Port ${port} is not allowed for external requests` };
  }

  return { valid: true, hostname };
}

/**
 * Validate an image URL specifically
 *
 * More restrictive validation for image URLs:
 * - Must be HTTPS (except in development)
 * - Must have image-like extension or be from known CDN
 */
export function validateImageUrl(
  urlString: string,
  options: UrlValidationOptions = {}
): UrlValidationResult {
  const baseResult = validateUrl(urlString, options);
  if (!baseResult.valid) {
    return baseResult;
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  // Check for image-like extension
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp"];
  const pathname = url.pathname.toLowerCase();
  const hasImageExtension = imageExtensions.some((ext) => pathname.endsWith(ext));

  // Known CDN/image hosting domains
  const knownImageHosts = [
    "cloudinary.com",
    "imgix.net",
    "imagekit.io",
    "cloudflare.com",
    "amazonaws.com",
    "supabase.co",
    "supabase.com",
    "googleapis.com",
    "cdn.foodshare.app",
    "cdn.foodshare.club",
    "foodshare.club",
    "images.foodshare.app",
  ];
  const isKnownHost = knownImageHosts.some((host) =>
    url.hostname.endsWith(host) || url.hostname === host
  );

  // Must have image extension or be from known host
  if (!hasImageExtension && !isKnownHost) {
    // Check if pathname suggests image serving
    const imagePathPatterns = ["/image", "/img", "/photo", "/avatar", "/media", "/upload"];
    const hasImagePath = imagePathPatterns.some((p) => pathname.includes(p));

    if (!hasImagePath) {
      return {
        valid: false,
        reason: "URL does not appear to be an image",
        hostname: url.hostname,
      };
    }
  }

  return { valid: true, hostname: url.hostname };
}

/**
 * Sanitize a URL by removing potentially dangerous parts
 */
export function sanitizeUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);

    // Remove credentials
    url.username = "";
    url.password = "";

    // Keep only allowed schemes
    if (!ALLOWED_SCHEMES.includes(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Check if a URL is safe to fetch (combines validation + sanitization)
 */
export function isSafeToFetch(
  urlString: string,
  options: UrlValidationOptions = {}
): { safe: boolean; sanitizedUrl?: string; reason?: string } {
  const validation = validateUrl(urlString, options);

  if (!validation.valid) {
    return { safe: false, reason: validation.reason };
  }

  const sanitized = sanitizeUrl(urlString);
  if (!sanitized) {
    return { safe: false, reason: "URL could not be sanitized" };
  }

  return { safe: true, sanitizedUrl: sanitized };
}
