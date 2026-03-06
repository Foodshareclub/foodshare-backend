/**
 * Structured Logging Module
 *
 * Provides consistent JSON logging across all edge functions with:
 * - Automatic request context inclusion
 * - Log levels (debug, info, warn, error)
 * - Sensitive data redaction
 * - Performance timing
 */

import { getContext, getElapsedMs } from "./context.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Standard log entry format
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  requestId?: string;
  correlationId?: string;
  userId?: string;
  platform?: string;
  durationMs?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  [key: string]: unknown;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  minLevel: LogLevel;
  /** Service name to include in all logs */
  service?: string;
  /** Whether to include stack traces in error logs */
  includeStackTrace: boolean;
  /** Fields to redact from logs */
  redactFields: string[];
  /** Whether to pretty print (dev only) */
  prettyPrint: boolean;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_REDACT_FIELDS = [
  "password",
  "token",
  "apiKey",
  "api_key",
  "secret",
  "authorization",
  "bearer",
  "credential",
  "private_key",
  "privateKey",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
];

let config: LoggerConfig = {
  minLevel: "info",
  includeStackTrace: true,
  redactFields: DEFAULT_REDACT_FIELDS,
  prettyPrint: false,
};

/**
 * Configure the logger
 */
export function configureLogger(options: Partial<LoggerConfig>): void {
  config = { ...config, ...options };
}

/**
 * Redact sensitive fields from an object
 */
function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    // Check if it looks like a token/key
    if (obj.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(obj)) {
      return `[REDACTED:${obj.length}chars]`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (config.redactFields.some((field) => lowerKey.includes(field.toLowerCase()))) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitive(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Format an error for logging
 */
function formatError(error: unknown): LogEntry["error"] | undefined {
  if (!error) return undefined;

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: config.includeStackTrace ? error.stack : undefined,
      code: (error as Error & { code?: string }).code,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

/**
 * Check if log level should be output
 */
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[config.minLevel];
}

/**
 * Create a log entry with context
 */
function createLogEntry(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): LogEntry {
  const ctx = getContext();

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: config.service || ctx?.service,
    requestId: ctx?.requestId,
    correlationId: ctx?.correlationId,
    userId: ctx?.userId,
    platform: ctx?.platform,
    durationMs: ctx ? getElapsedMs() : undefined,
  };

  // Add additional data with redaction
  if (data) {
    const redacted = redactSensitive(data) as Record<string, unknown>;
    Object.assign(entry, redacted);
  }

  // Clean undefined values
  Object.keys(entry).forEach((key) => {
    if (entry[key] === undefined) {
      delete entry[key];
    }
  });

  return entry;
}

/**
 * Output a log entry
 */
function output(entry: LogEntry): void {
  const json = config.prettyPrint ? JSON.stringify(entry, null, 2) : JSON.stringify(entry);

  switch (entry.level) {
    case "error":
      console.error(json);
      break;
    case "warn":
      console.warn(json);
      break;
    default:
      console.log(json);
  }
}

/**
 * Log at debug level
 */
export function debug(message: string, data?: Record<string, unknown>): void {
  if (!shouldLog("debug")) return;
  output(createLogEntry("debug", message, data));
}

/**
 * Log at info level
 */
export function info(message: string, data?: Record<string, unknown>): void {
  if (!shouldLog("info")) return;
  output(createLogEntry("info", message, data));
}

/**
 * Log at warn level
 */
export function warn(message: string, data?: Record<string, unknown>): void {
  if (!shouldLog("warn")) return;
  output(createLogEntry("warn", message, data));
}

/**
 * Log at error level
 */
export function error(
  message: string,
  errorOrData?: Error | Record<string, unknown>,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog("error")) return;

  let logData = data || {};
  if (errorOrData instanceof Error) {
    logData = { ...logData, error: formatError(errorOrData) };
  } else if (errorOrData) {
    logData = { ...errorOrData, ...logData };
  }

  output(createLogEntry("error", message, logData));
}

/**
 * Log a request start
 */
export function logRequest(method: string, path: string, data?: Record<string, unknown>): void {
  info("Request received", { method, path, ...data });
}

/**
 * Log a request completion
 */
export function logResponse(
  statusCode: number,
  data?: Record<string, unknown>,
): void {
  const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
  const message = statusCode >= 400 ? "Request failed" : "Request completed";

  if (!shouldLog(level)) return;
  output(createLogEntry(level, message, { statusCode, ...data }));
}

/**
 * Log an external service call
 */
export function logExternalCall(
  service: string,
  operation: string,
  data?: Record<string, unknown>,
): void {
  info(`External call: ${service}`, { externalService: service, operation, ...data });
}

/**
 * Log with timing - returns a function to call when done
 *
 * @example
 * ```typescript
 * const done = logger.time("database query");
 * await db.query(...);
 * done({ rowCount: 42 });
 * ```
 */
export function time(operation: string): (data?: Record<string, unknown>) => void {
  const start = performance.now();

  return (data?: Record<string, unknown>) => {
    const durationMs = Math.round(performance.now() - start);
    info(`${operation} completed`, { operation, operationDurationMs: durationMs, ...data });
  };
}

/**
 * Create a child logger with additional context
 */
export function child(context: Record<string, unknown>): {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (
    message: string,
    errorOrData?: Error | Record<string, unknown>,
    data?: Record<string, unknown>,
  ) => void;
} {
  return {
    debug: (message: string, data?: Record<string, unknown>) =>
      debug(message, { ...context, ...data }),
    info: (message: string, data?: Record<string, unknown>) =>
      info(message, { ...context, ...data }),
    warn: (message: string, data?: Record<string, unknown>) =>
      warn(message, { ...context, ...data }),
    error: (
      message: string,
      errorOrData?: Error | Record<string, unknown>,
      data?: Record<string, unknown>,
    ) => error(message, errorOrData, { ...context, ...data }),
  };
}

/**
 * Default logger export for convenient use
 */
export const logger = {
  debug,
  info,
  warn,
  error,
  time,
  child,
  logRequest,
  logResponse,
  logExternalCall,
  configure: configureLogger,
};

export default logger;
