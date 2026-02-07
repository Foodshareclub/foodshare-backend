/**
 * Interactive message builders for WhatsApp
 * Buttons, lists, and menus
 */

import type { InteractiveListSection } from "../types/index.ts";
import * as emoji from "./emojis.ts";
import { t } from "./i18n.ts";

type Language = "en" | "ru" | "de";

/**
 * Build main menu buttons
 */
export function getMainMenuButtons(lang: Language): Array<{ id: string; title: string }> {
  return [
    { id: "action_share", title: t(lang, "menu.shareFood") },
    { id: "action_find", title: t(lang, "menu.findFood") },
    { id: "action_menu", title: "More Options" },
  ];
}

/**
 * Build extended menu list sections
 */
export function getExtendedMenuSections(lang: Language): InteractiveListSection[] {
  return [
    {
      title: "Food",
      rows: [
        { id: "action_share", title: t(lang, "menu.shareFood"), description: "Post surplus food" },
        { id: "action_find", title: t(lang, "menu.findFood"), description: "Search for food" },
        { id: "action_nearby", title: t(lang, "menu.nearby"), description: "Food near you" },
      ],
    },
    {
      title: "Profile",
      rows: [
        { id: "action_profile", title: t(lang, "menu.profile"), description: "View your profile" },
        { id: "action_impact", title: t(lang, "menu.impact"), description: "Environmental impact" },
        { id: "action_stats", title: t(lang, "menu.stats"), description: "Your statistics" },
      ],
    },
    {
      title: "Community",
      rows: [
        {
          id: "action_leaderboard",
          title: t(lang, "menu.leaderboard"),
          description: "Top contributors",
        },
        { id: "action_language", title: t(lang, "menu.language"), description: "Change language" },
        { id: "action_help", title: t(lang, "menu.help"), description: "Get help" },
      ],
    },
  ];
}

/**
 * Build language selection buttons
 */
export function getLanguageButtons(): Array<{ id: string; title: string }> {
  return [
    { id: "lang_en", title: "🇬🇧 English" },
    { id: "lang_ru", title: "🇷🇺 Русский" },
    { id: "lang_de", title: "🇩🇪 Deutsch" },
  ];
}

/**
 * Build share method buttons
 */
export function getShareMethodButtons(_lang: Language): Array<{ id: string; title: string }> {
  return [
    { id: "share_web", title: `${emoji.LINK} Open Form` },
    { id: "share_chat", title: `${emoji.CHAT} Use Chat` },
  ];
}

/**
 * Build confirmation buttons
 */
export function getConfirmButtons(_lang: Language): Array<{ id: string; title: string }> {
  return [
    { id: "confirm_yes", title: `${emoji.SUCCESS} Confirm` },
    { id: "confirm_no", title: `${emoji.ERROR} Cancel` },
  ];
}

/**
 * Build location options buttons
 */
export function getLocationButtons(_lang: Language): Array<{ id: string; title: string }> {
  return [
    { id: "location_gps", title: `${emoji.LOCATION} Share GPS` },
    { id: "location_skip", title: "Skip" },
  ];
}

/**
 * Build food item action buttons
 */
export function getFoodActionButtons(
  postId: string,
  _lang: Language
): Array<{ id: string; title: string }> {
  return [
    { id: `view_${postId}`, title: `${emoji.SEARCH} View Details` },
    { id: `claim_${postId}`, title: `${emoji.SHARE} Claim` },
  ];
}

/**
 * Build auth flow buttons
 */
export function getAuthButtons(_lang: Language): Array<{ id: string; title: string }> {
  return [
    { id: "auth_resend", title: `${emoji.REFRESH} Resend Code` },
    { id: "auth_cancel", title: `${emoji.ERROR} Cancel` },
  ];
}

/**
 * Build welcome message text
 */
export function getWelcomeMessage(name: string | undefined, _lang: Language): string {
  const greeting = name ? `Welcome, ${name}!` : "Welcome to FoodShare!";

  return `${emoji.WAVE} *${greeting}*

${emoji.SPARKLES} Your journey to reduce food waste starts here!

*What I can do:*
${emoji.FOOD} *Share Food* - Post surplus food
${emoji.SEARCH} *Find Food* - Discover nearby food
${emoji.EARTH} *Track Impact* - See your contribution
${emoji.TROPHY} *Community* - Join local food sharers

Use the buttons below to get started!`;
}

/**
 * Build help message text
 */
export function getHelpMessage(_lang: Language): string {
  return `${emoji.PLATE} *FoodShare Bot - Help*

*Food Sharing:*
${emoji.FOOD} Share - Post surplus food
${emoji.SEARCH} Find - Search for food
${emoji.NEARBY} Nearby - Food near you

*Profile:*
${emoji.USER} Profile - View your profile
${emoji.EARTH} Impact - Environmental impact
${emoji.STATS} Stats - Your statistics

*Community:*
${emoji.TROPHY} Leaderboard - Top contributors
${emoji.GLOBE} Language - Change language

Type "menu" anytime to see options!`;
}

/**
 * Build impact stats message
 */
export function getImpactMessage(stats: {
  foodsShared: number;
  foodsClaimed: number;
  kgSaved: number;
  co2Saved: number;
  moneySaved: number;
  memberSince: string;
  badges: string[];
}): string {
  let message = `${emoji.EARTH} *Your Environmental Impact*

${emoji.FOOD} Food Shared: *${stats.foodsShared}* items
${emoji.SHARE} Food Claimed: *${stats.foodsClaimed}* items
${emoji.RECYCLE} Waste Prevented: *${stats.kgSaved}kg*
${emoji.LEAF} CO2 Saved: *${stats.co2Saved}kg*
${emoji.CALENDAR} Member Since: ${stats.memberSince}`;

  if (stats.badges.length > 0) {
    message += `\n\n${emoji.BADGE} *Badges:* ${stats.badges.join(" | ")}`;
  }

  return message;
}

/**
 * Build food card message
 */
export function getFoodCardMessage(food: {
  name: string;
  description?: string;
  address?: string;
  distance?: number;
}): string {
  let message = `${emoji.FOOD} *${food.name}*\n`;

  if (food.description) {
    const desc =
      food.description.length > 100 ? food.description.substring(0, 100) + "..." : food.description;
    message += `\n${emoji.TEXT} ${desc}`;
  }

  if (food.address) {
    message += `\n${emoji.LOCATION} ${food.address}`;
  }

  if (food.distance !== undefined) {
    message += `\n${emoji.DISTANCE} ${food.distance.toFixed(1)}km away`;
  }

  return message;
}
