/**
 * Input validation utilities
 */

import {
  EMAIL_REGEX,
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from "../config/constants.ts";

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Validate food description
 */
export function isValidDescription(description: string): boolean {
  const trimmed = description.trim();
  return trimmed.length >= MIN_DESCRIPTION_LENGTH && trimmed.length <= MAX_DESCRIPTION_LENGTH;
}

/**
 * Sanitize text input (remove potentially dangerous characters)
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/[<>]/g, "") // Remove HTML-like characters
    .trim()
    .substring(0, 2000); // Limit length
}

/**
 * Validate verification code format
 */
export function isValidVerificationCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}

/**
 * Validate phone number (WhatsApp format)
 */
export function isValidPhoneNumber(phone: string): boolean {
  // WhatsApp phone numbers are in format: country code + number, no + sign
  return /^\d{10,15}$/.test(phone);
}

/**
 * Normalize phone number for storage
 */
export function normalizePhoneNumber(phone: string): string {
  // Remove all non-digit characters
  return phone.replace(/\D/g, "");
}

/**
 * Validate geographic coordinates
 * Latitude: -90 to 90
 * Longitude: -180 to 180
 */
export function isValidCoordinates(latitude: number, longitude: number): boolean {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return false;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return false;
  }
  if (latitude < -90 || latitude > 90) {
    return false;
  }
  if (longitude < -180 || longitude > 180) {
    return false;
  }
  return true;
}

/**
 * Create safe PostGIS POINT string from validated coordinates
 */
export function createPostGISPoint(latitude: number, longitude: number): string | null {
  if (!isValidCoordinates(latitude, longitude)) {
    return null;
  }
  // Use fixed precision to prevent any injection attempts
  return `POINT(${longitude.toFixed(8)} ${latitude.toFixed(8)})`;
}
