/**
 * Callback query handlers for inline button interactions
 */

import { sendMessage, answerCallbackQuery } from "../services/telegram-api.ts";
import { setUserState } from "../services/user-state.ts";
import { getProfileByTelegramId, requiresEmailVerification } from "../services/profile.ts";
import * as emoji from "../lib/emojis.ts";
import * as msg from "../lib/messages.ts";
import { getUserLanguage } from "../lib/i18n.ts";
import type { TelegramCallbackQuery } from "../types/index.ts";
import {
  handleStartCommand,
  handleShareCommand,
  handleShareViaChat,
  handleFindCommand,
  handleNearbyCommand,
  handleProfileCommand,
  handleStatsCommand,
  handleLeaderboardCommand,
} from "./commands.ts";
import { requireAuth } from "./messages.ts";

// Callbacks that require authorization
const PROTECTED_CALLBACKS = new Set([
  "action_share",
  "share_via_chat",
  "action_nearby",
  "action_profile",
  "profile_location",
  "profile_radius",
  "action_stats",
]);

export async function handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  // Answer callback query to remove loading state
  await answerCallbackQuery(callbackQuery.id);

  // Check auth for protected callbacks
  if (PROTECTED_CALLBACKS.has(data)) {
    const lang = await getUserLanguage(userId, callbackQuery.from?.language_code);
    // Extract action name for friendly message (e.g., "action_share" -> "share")
    const actionName = data.replace("action_", "").replace("_via_chat", "");
    const auth = await requireAuth(userId, chatId, lang, actionName);
    if (!auth.authorized) return;
  }

  switch (data) {
    case "action_share":
      await handleShareCommand(
        chatId,
        userId,
        callbackQuery.from,
        callbackQuery.from?.language_code
      );
      break;

    case "share_via_chat":
      await handleShareViaChat(chatId, userId, callbackQuery.from);
      break;

    case "action_find":
      await handleFindCommand(chatId, "", callbackQuery.from?.language_code);
      break;

    case "action_nearby":
      await handleNearbyCommand(chatId, userId);
      break;

    case "action_profile":
      await handleProfileCommand(chatId, userId);
      break;

    case "profile_location":
      await handleProfileLocationUpdate(chatId, userId);
      break;

    case "profile_radius":
      await handleProfileRadiusUpdate(chatId, userId);
      break;

    case "action_stats":
      await handleStatsCommand(chatId, userId, callbackQuery.from?.language_code);
      break;

    case "action_leaderboard":
      await handleLeaderboardCommand(chatId, callbackQuery.from?.language_code);
      break;

    case "lang_en":
    case "lang_ru":
    case "lang_de":
      await handleLanguageSelection(chatId, userId, data.replace("lang_", ""), callbackQuery.from);
      break;

    case "back_to_start":
      await handleStartCommand(
        chatId,
        userId,
        callbackQuery.from,
        callbackQuery.from?.language_code
      );
      break;

    default:
      // Unknown callback
      break;
  }
}

async function handleLanguageSelection(
  chatId: number,
  userId: number,
  language: string,
  telegramUser: { id: number; first_name: string; language_code?: string }
): Promise<void> {
  const { saveUserLanguage } = await import("../lib/i18n.ts");

  // Save language preference
  await saveUserLanguage(userId, language as "en" | "ru" | "de");

  // Send confirmation
  await sendMessage(
    chatId,
    msg.successMessage(
      "Language Updated",
      `${emoji.SUCCESS} Your language preference has been saved!`
    )
  );

  // Show main menu in new language
  setTimeout(() => {
    handleStartCommand(chatId, userId, telegramUser, language);
  }, 1000);
}

async function handleProfileLocationUpdate(chatId: number, userId: number): Promise<void> {
  const profile = await getProfileByTelegramId(userId);

  if (!profile || requiresEmailVerification(profile)) {
    await sendMessage(
      chatId,
      msg.infoMessage("Verification Required", "Please verify your email to update your profile.")
    );
    return;
  }

  await sendMessage(
    chatId,
    `${emoji.LOCATION} <b>Send your new location</b>\n\nUse the attachment menu to send your current location.`
  );
  await setUserState(userId, { action: "updating_profile_location", data: {} });
}

async function handleProfileRadiusUpdate(chatId: number, userId: number): Promise<void> {
  const profile = await getProfileByTelegramId(userId);

  if (!profile || requiresEmailVerification(profile)) {
    await sendMessage(
      chatId,
      msg.infoMessage("Verification Required", "Please verify your email to update your profile.")
    );
    return;
  }

  await sendMessage(
    chatId,
    `${emoji.COMPASS} <b>Enter search radius (km)</b>\n\nType a number between 1 and 50.`
  );
  await setUserState(userId, { action: "setting_radius", data: {} });
}
