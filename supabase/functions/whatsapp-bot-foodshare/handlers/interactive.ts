/**
 * Interactive message handlers for WhatsApp Bot
 * Handles button clicks and list selections
 */

import { setUserState } from "../services/user-state.ts";
import { getProfileByWhatsAppPhone } from "../services/profile.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";
import { getBadges, getUserImpactStats } from "../services/impact.ts";
import { sendButtonMessage, sendListMessage, sendTextMessage } from "../services/whatsapp-api.ts";
import { getUserLanguage, saveUserLanguage, t } from "../lib/i18n.ts";
import {
  getExtendedMenuSections,
  getFoodCardMessage,
  getHelpMessage,
  getImpactMessage,
  getLanguageButtons,
  getMainMenuButtons,
  getShareMethodButtons,
} from "../lib/interactive.ts";
import * as emoji from "../lib/emojis.ts";
import { APP_URL } from "../config/index.ts";
import { handleResendCode, handleStart, requireAuth } from "./auth.ts";

type Language = "en" | "ru" | "de";

/**
 * Handle button reply
 */
export async function handleButtonReply(phoneNumber: string, buttonId: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);

  switch (buttonId) {
    case "action_share":
      await handleShare(phoneNumber);
      break;

    case "action_find":
      await handleFind(phoneNumber);
      break;

    case "action_menu":
      await handleExtendedMenu(phoneNumber);
      break;

    case "action_nearby":
      await handleNearbyRequest(phoneNumber);
      break;

    case "action_profile":
      await handleProfile(phoneNumber);
      break;

    case "action_impact":
      await handleImpact(phoneNumber);
      break;

    case "action_stats":
      await handleStats(phoneNumber);
      break;

    case "action_leaderboard":
      await handleLeaderboard(phoneNumber);
      break;

    case "action_language":
      await handleLanguageSelect(phoneNumber);
      break;

    case "action_help":
      await handleHelp(phoneNumber);
      break;

    case "share_web":
      await handleShareWeb(phoneNumber);
      break;

    case "share_chat":
      await handleShareChat(phoneNumber);
      break;

    case "location_skip":
      await sendTextMessage(phoneNumber, "Type an address or 'skip' to use your profile location.");
      break;

    case "auth_resend":
      await handleResendCode(phoneNumber);
      break;

    case "auth_cancel":
      await setUserState(phoneNumber, null);
      await sendTextMessage(phoneNumber, `${emoji.SUCCESS} ${t(lang, "common.cancel")}`);
      await handleStart(phoneNumber);
      break;

    case "lang_en":
      await setLanguage(phoneNumber, "en");
      break;

    case "lang_ru":
      await setLanguage(phoneNumber, "ru");
      break;

    case "lang_de":
      await setLanguage(phoneNumber, "de");
      break;

    case "confirm_yes":
    case "confirm_no":
      // Handle in context
      break;

    default:
      // Check for dynamic button IDs
      if (buttonId.startsWith("view_")) {
        const postId = buttonId.replace("view_", "");
        await handleViewPost(phoneNumber, postId);
      } else if (buttonId.startsWith("claim_")) {
        const postId = buttonId.replace("claim_", "");
        await handleClaimPost(phoneNumber, postId);
      } else {
        await sendTextMessage(phoneNumber, `Unknown action: ${buttonId}`);
      }
  }
}

/**
 * Handle list reply
 */
export async function handleListReply(phoneNumber: string, listId: string): Promise<void> {
  // List replies use same IDs as buttons
  await handleButtonReply(phoneNumber, listId);
}

/**
 * Handle share action
 */
async function handleShare(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);

  await sendButtonMessage(
    phoneNumber,
    `${emoji.FOOD} *${t(lang, "share.title")}*\n\n${t(lang, "share.chooseMethod")}`,
    getShareMethodButtons(lang),
  );
}

/**
 * Handle share via web form
 */
async function handleShareWeb(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);

  const shareUrl = `${APP_URL}/share`;
  await sendTextMessage(
    phoneNumber,
    `${emoji.LINK} Open this link to share food:\n\n${shareUrl}\n\n${emoji.LIGHT_BULB} The web form is faster and easier!`,
  );

  await sendButtonMessage(phoneNumber, "What else would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle share via chat
 */
async function handleShareChat(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);

  await sendTextMessage(phoneNumber, t(lang, "share.step1Photo"));

  await setUserState(phoneNumber, {
    action: "sharing_food",
    step: "awaiting_photo",
    data: {},
  });
}

/**
 * Handle find action
 */
async function handleFind(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const supabase = getSupabaseClient();

  const { data: posts, error } = await supabase
    .from("posts_with_location")
    .select("*")
    .eq("post_type", "food")
    .eq("is_active", true)
    .order("created_time", { ascending: false })
    .limit(5);

  if (error || !posts || posts.length === 0) {
    await sendTextMessage(phoneNumber, t(lang, "find.noFood"));
    await sendButtonMessage(phoneNumber, "What would you like to do?", getMainMenuButtons(lang));
    return;
  }

  await sendTextMessage(
    phoneNumber,
    `${emoji.FOOD} *${t(lang, "find.title", { count: posts.length })}*`,
  );

  for (const post of posts.slice(0, 3)) {
    const card = getFoodCardMessage({
      name: post.post_name || "Food",
      description: post.post_description,
      address: post.address,
    });

    await sendTextMessage(phoneNumber, card);
  }

  await sendButtonMessage(phoneNumber, "What would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle extended menu
 */
async function handleExtendedMenu(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);

  await sendListMessage(
    phoneNumber,
    "Choose an option from the menu:",
    "View Menu",
    getExtendedMenuSections(lang),
    `${emoji.MENU} FoodShare Menu`,
  );
}

/**
 * Handle nearby request
 */
async function handleNearbyRequest(phoneNumber: string): Promise<void> {
  await sendTextMessage(
    phoneNumber,
    `${emoji.LOCATION} *Nearby Food*\n\nShare your location to find food near you!\n\nTap the attachment button ${emoji.ARROW_RIGHT} Location`,
  );
}

/**
 * Handle profile view
 */
async function handleProfile(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (!profile) return;

  const profileUrl = `${APP_URL}/profile`;
  await sendTextMessage(
    phoneNumber,
    `${emoji.USER} *${
      t(lang, "profile.title")
    }*\n\n${emoji.EMAIL} ${profile.email}\n${emoji.VERIFIED} Verified\n\n${emoji.LINK} ${
      t(lang, "profile.manageOnWebsite")
    }\n${profileUrl}`,
  );

  await sendButtonMessage(phoneNumber, "What else would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle impact stats
 */
async function handleImpact(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (!profile) return;

  const stats = await getUserImpactStats(profile.id);
  const badges = getBadges(stats);

  const message = getImpactMessage({
    ...stats,
    badges,
  });

  await sendTextMessage(phoneNumber, message);

  await sendButtonMessage(phoneNumber, "What else would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle stats view
 */
async function handleStats(phoneNumber: string): Promise<void> {
  if (!(await requireAuth(phoneNumber))) return;

  const lang = await getUserLanguage(phoneNumber);

  await sendTextMessage(
    phoneNumber,
    `${emoji.STATS} *${t(lang, "stats.title")}*\n\n${t(lang, "stats.noStatsYet")}`,
  );

  await sendButtonMessage(phoneNumber, "What else would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle leaderboard
 */
async function handleLeaderboard(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const supabase = getSupabaseClient();

  // Get top contributors
  const { data: leaders, error } = await supabase
    .from("profiles")
    .select("first_name, nickname")
    .limit(10);

  if (error || !leaders || leaders.length === 0) {
    await sendTextMessage(phoneNumber, t(lang, "leaderboard.noData"));
    return;
  }

  let message = `${emoji.TROPHY} *${t(lang, "leaderboard.title")}*\n\n`;

  const medals = [emoji.GOLD_MEDAL, emoji.SILVER_MEDAL, emoji.BRONZE_MEDAL];

  leaders.slice(0, 10).forEach((leader, index) => {
    const medal = medals[index] || `${index + 1}.`;
    const name = leader.nickname || leader.first_name || "Anonymous";
    message += `${medal} ${name}\n`;
  });

  await sendTextMessage(phoneNumber, message);

  await sendButtonMessage(phoneNumber, "What else would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle language selection
 */
async function handleLanguageSelect(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);

  await sendButtonMessage(
    phoneNumber,
    `${emoji.GLOBE} *${t(lang, "language.selectTitle")}*\n\n${t(lang, "language.selectMessage")}`,
    getLanguageButtons(),
  );
}

/**
 * Set user language
 */
async function setLanguage(phoneNumber: string, newLang: Language): Promise<void> {
  await saveUserLanguage(phoneNumber, newLang);

  const langNames: Record<Language, string> = {
    en: "English",
    ru: "Русский",
    de: "Deutsch",
  };

  await sendTextMessage(
    phoneNumber,
    `${emoji.SUCCESS} *${t(newLang, "language.changed")}*\n\n${
      t(newLang, "language.selectedLanguage")
    }: ${langNames[newLang]}`,
  );

  await sendButtonMessage(phoneNumber, "What would you like to do?", getMainMenuButtons(newLang));
}

/**
 * Handle help
 */
async function handleHelp(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const helpMsg = getHelpMessage(lang);

  await sendListMessage(
    phoneNumber,
    helpMsg,
    "View Options",
    getExtendedMenuSections(lang),
    t(lang, "help.title"),
  );
}

/**
 * Handle view post
 */
async function handleViewPost(phoneNumber: string, postId: string): Promise<void> {
  const postUrl = `${APP_URL}/food/${postId}`;
  await sendTextMessage(phoneNumber, `${emoji.LINK} View post:\n${postUrl}`);
}

/**
 * Handle claim post
 */
async function handleClaimPost(phoneNumber: string, postId: string): Promise<void> {
  const postUrl = `${APP_URL}/food/${postId}`;

  await sendTextMessage(
    phoneNumber,
    `${emoji.SHARE} To claim this food, visit:\n${postUrl}\n\nYou can message the owner directly on FoodShare!`,
  );
}
