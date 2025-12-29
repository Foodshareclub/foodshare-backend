/**
 * Internationalization (i18n) Helper for WhatsApp
 */

import { en } from "../locales/en.ts";
import { ru } from "../locales/ru.ts";
import { de } from "../locales/de.ts";
import { getSupabaseClient } from "../services/supabase.ts";

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
  let value: unknown = translations[lang] || translations.en;

  for (const k of keys) {
    value = (value as Record<string, unknown>)?.[k];
    if (value === undefined) {
      console.warn(`Translation missing: ${lang}.${key}`);
      // Fallback to English
      value = translations.en;
      for (const k of keys) {
        value = (value as Record<string, unknown>)?.[k];
      }
      break;
    }
  }

  if (typeof value !== "string") {
    return key;
  }

  let result: string = value;

  // Replace placeholders
  if (replacements) {
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(`\\{${placeholder}\\}`, "g"), String(replacement));
    }
  }

  return result;
}

/**
 * Detect user language
 */
export function detectLanguage(languageCode?: string): Language {
  if (!languageCode) return "en";

  const langMap: Record<string, Language> = {
    en: "en",
    ru: "ru",
    de: "de",
    uk: "ru",
    be: "ru",
    kk: "ru",
    at: "de",
    ch: "de",
  };

  return langMap[languageCode.toLowerCase()] || "en";
}

/**
 * Get user's language from database
 */
export async function getUserLanguage(phoneNumber: string): Promise<Language> {
  try {
    const supabase = getSupabaseClient();

    const { data } = await supabase
      .from("profiles")
      .select("language")
      .eq("whatsapp_phone", phoneNumber)
      .single();

    if (data?.language) {
      return data.language as Language;
    }
  } catch (error) {
    console.error("Error fetching user language preference:", error);
  }

  return "en";
}

/**
 * Save user's language preference
 */
export async function saveUserLanguage(phoneNumber: string, language: Language): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    await supabase.from("profiles").update({ language }).eq("whatsapp_phone", phoneNumber);

    console.log(
      `Saved language preference: ${language} for phone ${phoneNumber.substring(0, 4)}***`
    );
  } catch (error) {
    console.error("Error saving user language preference:", error);
  }
}

/**
 * Get all supported languages
 */
export function getSupportedLanguages(): Array<{ code: Language; name: string; flag: string }> {
  return [
    { code: "en", name: "English", flag: "🇬🇧" },
    { code: "ru", name: "Русский", flag: "🇷🇺" },
    { code: "de", name: "Deutsch", flag: "🇩🇪" },
  ];
}
