/**
 * Display Name Extraction Utility
 *
 * Production-grade utility for extracting human-friendly display names
 * from user profile data with intelligent fallbacks.
 *
 * Priority chain:
 * 1. display_name (explicitly set by user)
 * 2. first_name (most personal for greetings)
 * 3. Full name (first_name + second_name combined)
 * 4. nickname
 * 5. Smart extraction from email
 * 6. "there" as friendly fallback
 *
 * @example
 * ```ts
 * const name = extractDisplayName({
 *   firstName: "John",
 *   email: "john.doe@example.com"
 * });
 * // → "John"
 *
 * const name = extractDisplayName({
 *   email: "john.doe123@gmail.com"
 * });
 * // → "John"
 *
 * const name = extractDisplayName({
 *   email: "xk7user@gmail.com"
 * });
 * // → "there"
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export interface ProfileNameData {
  displayName?: string | null;
  firstName?: string | null;
  secondName?: string | null;
  lastName?: string | null; // Alias for secondName
  nickname?: string | null;
  email?: string | null;
}

export interface ExtractOptions {
  /**
   * Prefer first name only even when full name is available.
   * Better for casual greetings like "Hey John!"
   * @default true
   */
  preferFirstNameOnly?: boolean;

  /**
   * Minimum length for a name to be considered valid.
   * Names shorter than this will trigger fallback.
   * @default 2
   */
  minNameLength?: number;

  /**
   * Custom fallback text when no name can be extracted.
   * @default "there"
   */
  fallback?: string;

  /**
   * Attempt smart extraction from email username.
   * @default true
   */
  extractFromEmail?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Generic email usernames that should not be used as names.
 * These trigger the fallback response.
 */
const GENERIC_USERNAMES = new Set([
  // Service accounts
  "admin",
  "administrator",
  "info",
  "contact",
  "support",
  "help",
  "sales",
  "billing",
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "mailer",
  "postmaster",
  "webmaster",
  "hostmaster",
  "root",
  "system",
  "service",
  "services",
  "accounts",
  "account",
  "mail",
  "email",
  "hello",
  "hi",
  "hey",
  "team",
  "staff",
  "office",
  "enquiry",
  "enquiries",
  "inquiry",
  "feedback",
  "newsletter",
  "notifications",
  "alerts",
  "updates",
  "marketing",
  "pr",
  "press",
  "media",
  "jobs",
  "careers",
  "hr",
  "recruitment",
  "legal",
  "compliance",
  "security",
  "abuse",
  "spam",
  "test",
  "testing",
  "demo",
  "example",
  "user",
  "guest",
  "member",
  "customer",
  "client",
  "subscriber",
  "order",
  "orders",
  "shop",
  "store",
  "booking",
  "bookings",
  "reservation",
  "reservations",
  "auto",
  "automated",
  "bot",
  "robot",
  "api",
  "dev",
  "developer",
  "developers",
  "tech",
  "technical",
  "it",
  "itsupport",
  "helpdesk",
  "reception",
  "main",
  "general",
  "default",
  "anonymous",
  "unknown",
  "private",
  "personal",
  "me",
  "myself",
  "food",
  "foodshare",
  "share",
  "sharing",
]);

/**
 * Common name prefixes/titles to strip.
 */
const NAME_PREFIXES = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "prof",
  "sir",
  "madam",
  "mx",
]);

/**
 * Characters that commonly separate name parts in email usernames.
 */
const NAME_SEPARATORS = /[._\-+]/g;

/**
 * Pattern to match trailing numbers (e.g., "john123" → "john").
 */
const TRAILING_NUMBERS = /\d+$/;

/**
 * Pattern to match leading numbers (e.g., "123john" → invalid).
 */
const LEADING_NUMBERS = /^\d+/;

/**
 * Pattern to detect camelCase boundaries (e.g., "JohnDoe" → "John Doe").
 */
const CAMEL_CASE = /([a-z])([A-Z])/g;

/**
 * Pattern to match valid name characters (letters, spaces, hyphens, apostrophes).
 */
const VALID_NAME_CHARS = /^[a-zA-ZÀ-ÿ\s'-]+$/;

/**
 * Pattern to match purely numeric strings.
 */
const PURELY_NUMERIC = /^\d+$/;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Capitalizes the first letter of each word (title case).
 */
function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      if (word.length === 0) return "";
      // Handle hyphenated names (e.g., "jean-pierre" → "Jean-Pierre")
      if (word.includes("-")) {
        return word
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("-");
      }
      // Handle apostrophes (e.g., "o'brien" → "O'Brien")
      if (word.includes("'")) {
        const parts = word.split("'");
        return parts
          .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
          .join("'");
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * Splits camelCase into separate words.
 * "JohnDoe" → "John Doe"
 * "johnDoe" → "john Doe"
 */
function splitCamelCase(str: string): string {
  return str.replace(CAMEL_CASE, "$1 $2");
}

/**
 * Validates and cleans a potential name string.
 * Returns null if the name is invalid.
 */
function validateName(name: string | null | undefined, minLength: number): string | null {
  if (!name || typeof name !== "string") {
    return null;
  }

  // Trim whitespace
  let cleaned = name.trim();

  // Check minimum length
  if (cleaned.length < minLength) {
    return null;
  }

  // Reject purely numeric strings
  if (PURELY_NUMERIC.test(cleaned)) {
    return null;
  }

  // Reject strings with mostly numbers
  const letterCount = (cleaned.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
  if (letterCount < minLength) {
    return null;
  }

  // Check for valid characters (allow international characters)
  if (!VALID_NAME_CHARS.test(cleaned)) {
    // Try removing invalid characters
    cleaned = cleaned.replace(/[^a-zA-ZÀ-ÿ\s'-]/g, "").trim();
    if (cleaned.length < minLength) {
      return null;
    }
  }

  return cleaned;
}

/**
 * Checks if a username is generic/service-related.
 */
function isGenericUsername(username: string): boolean {
  const normalized = username.toLowerCase().replace(TRAILING_NUMBERS, "").trim();
  return GENERIC_USERNAMES.has(normalized);
}

/**
 * Extracts a name from an email username.
 * Handles patterns like:
 * - john.doe → John
 * - john_doe123 → John
 * - JohnDoe → John
 * - j.doe → J (single letter)
 */
function extractNameFromEmail(email: string, minLength: number): string | null {
  if (!email || !email.includes("@")) {
    return null;
  }

  // Get username part
  let username = email.split("@")[0].toLowerCase();

  // Check for generic usernames first
  if (isGenericUsername(username)) {
    return null;
  }

  // Remove leading numbers (e.g., "123john" → invalid, numbers at start are suspicious)
  if (LEADING_NUMBERS.test(username)) {
    username = username.replace(LEADING_NUMBERS, "");
    if (username.length < minLength) {
      return null;
    }
  }

  // Remove trailing numbers (e.g., "john123" → "john")
  username = username.replace(TRAILING_NUMBERS, "");

  // Split by separators (dots, underscores, hyphens, plus signs)
  const parts = username.split(NAME_SEPARATORS).filter((p) => p.length > 0);

  if (parts.length === 0) {
    return null;
  }

  // Get the first part as the potential first name
  let firstName = parts[0];

  // Handle camelCase (e.g., "johndoe" might be "johnDoe" originally)
  if (parts.length === 1 && firstName.length > 3) {
    const splitName = splitCamelCase(firstName);
    if (splitName.includes(" ")) {
      firstName = splitName.split(" ")[0];
    }
  }

  // Strip common prefixes (mr, mrs, dr, etc.)
  if (NAME_PREFIXES.has(firstName.toLowerCase()) && parts.length > 1) {
    firstName = parts[1];
  }

  // Validate the extracted name
  const validatedName = validateName(firstName, minLength);
  if (!validatedName) {
    return null;
  }

  // Title case the result
  return toTitleCase(validatedName);
}

// =============================================================================
// Main Export
// =============================================================================

/**
 * Extracts the best available display name from profile data.
 *
 * Uses a smart priority chain:
 * 1. display_name (explicitly set by user)
 * 2. first_name (most personal for greetings)
 * 3. Full name (first_name + second_name)
 * 4. nickname
 * 5. Smart extraction from email
 * 6. Fallback text ("there" by default)
 *
 * @param profile - Profile data with name fields
 * @param options - Extraction options
 * @returns Human-friendly display name
 *
 * @example
 * ```ts
 * // With first name
 * extractDisplayName({ firstName: "John" }) // → "John"
 *
 * // With email only
 * extractDisplayName({ email: "john.doe@gmail.com" }) // → "John"
 *
 * // With generic email
 * extractDisplayName({ email: "info@company.com" }) // → "there"
 *
 * // Custom fallback
 * extractDisplayName({ email: "xk7@test.com" }, { fallback: "friend" }) // → "friend"
 * ```
 */
export function extractDisplayName(
  profile: ProfileNameData,
  options: ExtractOptions = {},
): string {
  const {
    preferFirstNameOnly = true,
    minNameLength = 2,
    fallback = "there",
    extractFromEmail = true,
  } = options;

  // 1. Check display_name (user's explicit preference)
  const displayName = validateName(profile.displayName, minNameLength);
  if (displayName) {
    // If preferFirstNameOnly, extract just the first word
    if (preferFirstNameOnly && displayName.includes(" ")) {
      const firstName = displayName.split(" ")[0];
      const validFirst = validateName(firstName, minNameLength);
      if (validFirst) {
        return toTitleCase(validFirst);
      }
    }
    return toTitleCase(displayName);
  }

  // 2. Check first_name
  const firstName = validateName(profile.firstName, minNameLength);
  if (firstName) {
    return toTitleCase(firstName);
  }

  // 3. Check full name (first + second/last)
  const secondName = profile.secondName || profile.lastName;
  if (profile.firstName && secondName) {
    const fullName = `${profile.firstName} ${secondName}`.trim();
    const validFull = validateName(fullName, minNameLength);
    if (validFull) {
      // Return just first name if preferFirstNameOnly
      if (preferFirstNameOnly) {
        const firstPart = validFull.split(" ")[0];
        const validFirst = validateName(firstPart, minNameLength);
        if (validFirst) {
          return toTitleCase(validFirst);
        }
      }
      return toTitleCase(validFull);
    }
  }

  // 4. Check nickname
  const nickname = validateName(profile.nickname, minNameLength);
  if (nickname) {
    // Extract first word from nickname if it contains spaces
    if (preferFirstNameOnly && nickname.includes(" ")) {
      const firstWord = nickname.split(" ")[0];
      const validFirst = validateName(firstWord, minNameLength);
      if (validFirst) {
        return toTitleCase(validFirst);
      }
    }
    return toTitleCase(nickname);
  }

  // 5. Smart extraction from email
  if (extractFromEmail && profile.email) {
    const emailName = extractNameFromEmail(profile.email, minNameLength);
    if (emailName) {
      return emailName;
    }
  }

  // 6. Fallback
  return fallback;
}

/**
 * Formats a greeting with the extracted display name.
 * Convenience wrapper around extractDisplayName.
 *
 * @param profile - Profile data with name fields
 * @param prefix - Greeting prefix (default: "Hey")
 * @param suffix - Greeting suffix (default: "!")
 * @param options - Extraction options
 * @returns Formatted greeting string
 *
 * @example
 * ```ts
 * formatGreeting({ firstName: "John" }) // → "Hey John!"
 * formatGreeting({ email: "info@test.com" }) // → "Hey there!"
 * formatGreeting({ firstName: "Sarah" }, "Hi", "!") // → "Hi Sarah!"
 * ```
 */
export function formatGreeting(
  profile: ProfileNameData,
  prefix = "Hey",
  suffix = "!",
  options: ExtractOptions = {},
): string {
  const name = extractDisplayName(profile, options);
  return `${prefix} ${name}${suffix}`;
}

/**
 * Checks if a name requires the fallback.
 * Useful for conditional formatting (e.g., skipping "there" in subject lines).
 *
 * @param profile - Profile data with name fields
 * @param options - Extraction options
 * @returns true if the fallback would be used
 */
export function isNameFallback(
  profile: ProfileNameData,
  options: ExtractOptions = {},
): boolean {
  const { fallback = "there" } = options;
  return extractDisplayName(profile, options) === fallback;
}

// =============================================================================
// Database Field Mapping Helper
// =============================================================================

/**
 * Maps database profile row to ProfileNameData.
 * Handles various column naming conventions.
 *
 * @param row - Database row with profile fields
 * @returns Normalized ProfileNameData object
 *
 * @example
 * ```ts
 * const row = { first_name: "John", second_name: "Doe", email: "john@example.com" };
 * const profile = mapDatabaseProfile(row);
 * const name = extractDisplayName(profile); // → "John"
 * ```
 */
export function mapDatabaseProfile(
  row: Record<string, unknown>,
): ProfileNameData {
  return {
    displayName: (row.display_name ?? row.displayName ?? row.name) as string | null,
    firstName: (row.first_name ?? row.firstName) as string | null,
    secondName: (row.second_name ?? row.secondName ?? row.last_name ?? row.lastName) as
      | string
      | null,
    nickname: row.nickname as string | null,
    email: row.email as string | null,
  };
}

// =============================================================================
// Default Export
// =============================================================================

export default {
  extractDisplayName,
  formatGreeting,
  isNameFallback,
  mapDatabaseProfile,
};
