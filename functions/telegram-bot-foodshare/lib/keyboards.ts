/**
 * Keyboard helpers for Telegram bot menus
 */

import { t } from "./i18n.ts";

/**
 * Get the main menu keyboard that persists at the bottom of the chat
 */
export function getMainMenuKeyboard(lang: string) {
  return {
    keyboard: [
      [
        { text: t(lang, "menu.shareFood") },
        { text: t(lang, "menu.findFood") },
        { text: t(lang, "menu.nearby") },
      ],
      [
        { text: t(lang, "menu.profile") },
        { text: t(lang, "menu.impact") },
        { text: t(lang, "menu.stats") },
      ],
      [
        { text: t(lang, "menu.help") },
        { text: t(lang, "menu.language") },
        { text: t(lang, "menu.leaderboard") },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Check if text matches any menu button and return the action name
 */
export function getMenuAction(text: string, lang: string): string | null {
  const menuMap: Record<string, string> = {
    [t(lang, "menu.shareFood")]: "share",
    [t(lang, "menu.findFood")]: "find",
    [t(lang, "menu.nearby")]: "nearby",
    [t(lang, "menu.profile")]: "profile",
    [t(lang, "menu.impact")]: "impact",
    [t(lang, "menu.stats")]: "stats",
    [t(lang, "menu.help")]: "help",
    [t(lang, "menu.language")]: "language",
    [t(lang, "menu.leaderboard")]: "leaderboard",
  };
  return menuMap[text] || null;
}

/**
 * Check if text matches any menu button across all supported languages
 * This handles the case where user's language setting differs from button text
 */
export function getMenuActionAllLangs(text: string): string | null {
  const languages = ["en", "ru", "de"];
  for (const lang of languages) {
    const action = getMenuAction(text, lang);
    if (action) return action;
  }
  return null;
}
