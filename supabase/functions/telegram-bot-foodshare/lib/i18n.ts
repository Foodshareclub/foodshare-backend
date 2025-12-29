/**
 * Internationalization (i18n) Helper
 */

import { en } from "../locales/en.ts";
import { ru } from "../locales/ru.ts";
import { de } from "../locales/de.ts";

type Translations = typeof en;
type Language = "en" | "ru" | "de";

const translations: Record<Language, Translations> = {
  en,
  ru,
  de,
};

/**
 * Get translation for a key with optional replacements
 */
export function t(
  lang: Language,
  key: string,
  replacements?: Record<string, string | number>
): string {
  const keys = key.split(".");
  let value: any = translations[lang] || translations.en;

  for (const k of keys) {
    value = value?.[k];
    if (value === undefined) {
      console.warn(`Translation missing: ${lang}.${key}`);
      // Fallback to English
      value = translations.en;
      for (const k of keys) {
        value = value?.[k];
      }
      break;
    }
  }

  if (typeof value !== "string") {
    return key;
  }

  // Replace placeholders
  if (replacements) {
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      value = value.replace(new RegExp(`\\{${placeholder}\\}`, "g"), String(replacement));
    }
  }

  return value;
}

/**
 * Detect user language from Telegram user data
 */
export function detectLanguage(languageCode?: string): Language {
  if (!languageCode) return "en";

  // Map language codes to supported languages
  const langMap: Record<string, Language> = {
    en: "en",
    ru: "ru",
    de: "de",
    uk: "ru", // Ukrainian users might prefer Russian
    be: "ru", // Belarusian users might prefer Russian
    kk: "ru", // Kazakh users might prefer Russian
    at: "de", // Austria uses German
    ch: "de", // Switzerland uses German (among others)
  };

  return langMap[languageCode.toLowerCase()] || "en";
}

/**
 * Get user's language from database or detect from Telegram
 */
export async function getUserLanguage(userId: number, languageCode?: string): Promise<Language> {
  // Try to get stored preference from profile
  if (userId) {
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (supabaseUrl && supabaseKey) {
        const { createClient } = await import("jsr:@supabase/supabase-js@^2.47.10");
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data } = await supabase
          .from("profiles")
          .select("language")
          .eq("telegram_id", userId)
          .single();

        if (data?.language) {
          return data.language as Language;
        }
      }
    } catch (error) {
      console.error("Error fetching user language preference:", error);
    }
  }

  // Fallback to Telegram language detection
  return detectLanguage(languageCode);
}

/**
 * Save user's language preference to profile
 */
export async function saveUserLanguage(userId: number, language: Language): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (supabaseUrl && supabaseKey) {
      const { createClient } = await import("jsr:@supabase/supabase-js@^2.47.10");
      const supabase = createClient(supabaseUrl, supabaseKey);

      await supabase.from("profiles").update({ language }).eq("telegram_id", userId);

      console.log(`✅ Saved language preference: ${language} for user ${userId}`);
    }
  } catch (error) {
    console.error("Error saving user language preference:", error);
  }
}
