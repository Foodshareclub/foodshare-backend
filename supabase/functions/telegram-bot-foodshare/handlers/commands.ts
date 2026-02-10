/**
 * Command handlers for bot commands
 */

import { sendLocation, sendMessage, sendPhoto } from "../services/telegram-api.ts";
import { setUserState } from "../services/user-state.ts";
import { getProfileByTelegramId, requiresEmailVerification } from "../services/profile.ts";
import { getBadges, getUserImpactStats } from "../services/impact.ts";
import { extractCoordinates } from "../services/geocoding.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";
import { getCached, setCache } from "../services/cache.ts";
import { getUserLanguage, t } from "../lib/i18n.ts";
import { getMainMenuKeyboard } from "../lib/keyboards.ts";
import * as emoji from "../lib/emojis.ts";
import * as msg from "../lib/messages.ts";
import { APP_URL } from "../config/index.ts";
import { approximateLocation } from "../../_shared/location-privacy.ts";
import type { TelegramUser } from "../types/index.ts";

export async function handleStartCommand(
  chatId: number,
  userId: number,
  telegramUser: TelegramUser,
  languageCode?: string,
): Promise<void> {
  const lang = await getUserLanguage(userId, languageCode);
  const profile = await getProfileByTelegramId(telegramUser.id);

  // Save language preference if profile exists and language not set
  if (profile && !profile.language) {
    const { saveUserLanguage } = await import("../lib/i18n.ts");
    await saveUserLanguage(userId, lang);
  }

  // Case 1: Existing verified user - welcome back!
  if (profile && profile.email_verified) {
    const welcomeBackMsg = msg.boxedHeader(
      `${emoji.WAVE} ${
        t(lang, "welcome.welcomeBack", { name: profile.first_name || profile.nickname || "" })
      }`,
    ) +
      "\n\n" +
      `Hi <b>${profile.first_name || profile.nickname}</b>! ${emoji.SPARKLES}\n\n` +
      msg.divider("─", 30) +
      "\n\n" +
      `${emoji.SUCCESS} <b>${t(lang, "welcome.accountReady")}</b>\n\n` +
      msg.divider("─", 30) +
      "\n\n" +
      `${emoji.ROCKET} <b>${t(lang, "welcome.quickActions")}:</b>\n\n` +
      msg.bulletList([
        {
          emoji: emoji.FOOD,
          text: `<b>${t(lang, "welcome.shareAction")}</b> - ${t(lang, "welcome.shareDesc")}`,
        },
        {
          emoji: emoji.SEARCH,
          text: `<b>${t(lang, "welcome.findAction")}</b> - ${t(lang, "welcome.findDesc")}`,
        },
        {
          emoji: emoji.NEARBY,
          text: `<b>${t(lang, "welcome.nearbyAction")}</b> - ${t(lang, "welcome.nearbyDesc")}`,
        },
        {
          emoji: emoji.STATS,
          text: `<b>${t(lang, "welcome.impactAction")}</b> - ${t(lang, "welcome.impactDesc")}`,
        },
      ]) +
      "\n\n" +
      msg.divider("─", 30) +
      "\n\n" +
      `${emoji.LINK} <a href="${APP_URL}">Open FoodShare Website</a>\n\n` +
      `${emoji.LIGHT_BULB} <i>${t(lang, "welcome.helpHint")}</i>`;

    await sendMessage(chatId, welcomeBackMsg, { reply_markup: getMainMenuKeyboard(lang) });
    return;
  }

  // Case 2: Profile exists but not verified
  if (profile && !profile.email_verified && profile.email) {
    const welcomeMsg = msg.boxedHeader(`${emoji.WAVE} Welcome Back!`) +
      "\n\n" +
      `Hi <b>${profile.first_name || telegramUser.first_name}</b>! ${emoji.CELEBRATE}\n\n` +
      msg.divider("─", 30) +
      "\n\n" +
      `${emoji.INFO} <b>Your account needs verification</b>\n\n` +
      `${emoji.EMAIL} <b>Email:</b> <code>${profile.email}</code>\n\n` +
      msg.divider("─", 30) +
      "\n\n" +
      `${emoji.KEY} Send your email again to receive a new verification code.`;

    await sendMessage(chatId, welcomeMsg);
    await setUserState(userId, { action: "awaiting_email", data: {} });
    return;
  }

  // Case 3: New user
  const keyboard = {
    inline_keyboard: [
      [
        { text: `🇬🇧 English`, callback_data: "lang_en" },
        { text: `🇷🇺 Русский`, callback_data: "lang_ru" },
        { text: `🇩🇪 Deutsch`, callback_data: "lang_de" },
      ],
    ],
  };

  const welcomeMsg = msg.boxedHeader(`${emoji.WAVE} ${t(lang, "welcome.title")}`) +
    "\n\n" +
    `Hi <b>${telegramUser.first_name}</b>! ${emoji.CELEBRATE}\n\n` +
    msg.divider("─", 30) +
    "\n\n" +
    `${emoji.EARTH} <b>${t(lang, "auth.joinRevolution")}</b>\n\n` +
    msg.bulletList([
      { emoji: emoji.FOOD, text: t(lang, "auth.shareFood") },
      { emoji: emoji.SEARCH, text: t(lang, "auth.findFood") },
      { emoji: emoji.RECYCLE, text: t(lang, "auth.reduceWaste") },
      { emoji: emoji.STATS, text: t(lang, "auth.trackImpact") },
    ]) +
    "\n\n" +
    msg.divider("─", 30) +
    "\n\n" +
    `${emoji.KEY} <b>${t(lang, "auth.getStarted")}:</b>\n\n` +
    `${emoji.EMAIL} <b>${t(lang, "auth.newUser")}</b> ${t(lang, "auth.sendEmailToRegister")}\n` +
    `${emoji.INFO} <i>${t(lang, "common.example")}: user@example.com</i>\n\n` +
    `${emoji.KEY} <b>${t(lang, "auth.haveAccount")}</b> ${t(lang, "auth.sendEmailToSignIn")}\n\n` +
    msg.divider("─", 30) +
    "\n\n" +
    `${emoji.GLOBE} <b>${t(lang, "auth.selectLanguage")}:</b>`;

  await sendMessage(chatId, welcomeMsg, { reply_markup: keyboard });
  await setUserState(userId, { action: "awaiting_email", data: {} });
}

export async function handleHelpCommand(chatId: number, lang: string = "en"): Promise<void> {
  const helpMsg = msg.boxedHeader(`${emoji.PLATE} FoodShare Bot Help`) +
    "\n\n" +
    `${emoji.FOOD} <b>Food Sharing:</b>\n` +
    msg.bulletList([
      { emoji: emoji.SHARE, text: "/share - Share surplus food" },
      { emoji: emoji.SEARCH, text: "/find [item] - Search for food" },
      { emoji: emoji.NEARBY, text: "/nearby - Food near your location" },
    ]) +
    "\n\n" +
    `${emoji.USER} <b>Profile:</b>\n` +
    msg.bulletList([
      { emoji: emoji.USER, text: "/profile - View/edit your profile" },
      { emoji: emoji.EARTH, text: "/impact - Your environmental impact" },
    ]) +
    "\n\n" +
    `${emoji.STATS} <b>Community:</b>\n` +
    msg.bulletList([
      { emoji: emoji.CHART, text: "/stats - Your activity statistics" },
      { emoji: emoji.TROPHY, text: "/leaderboard - Top contributors" },
    ]) +
    "\n\n" +
    `${emoji.INFO} <b>Other:</b>\n` +
    msg.bulletList([
      { emoji: emoji.GLOBE, text: "/language - Change language" },
      { emoji: emoji.INFO, text: "/help - Show this message" },
      { emoji: emoji.ERROR, text: "/cancel - Cancel current action" },
    ]) +
    "\n\n" +
    msg.divider("─", 25) +
    "\n\n" +
    `${emoji.LINK} <a href="${APP_URL}">Open FoodShare Website</a>\n\n` +
    `${emoji.LIGHT_BULB} <i>Use the menu buttons below for quick actions!</i>`;

  await sendMessage(chatId, helpMsg, { reply_markup: getMainMenuKeyboard(lang) });
}

export async function handleShareCommand(
  chatId: number,
  userId: number,
  telegramUser: TelegramUser,
  languageCode?: string,
): Promise<void> {
  const lang = await getUserLanguage(userId, languageCode);
  const profile = await getProfileByTelegramId(telegramUser.id);

  if (!profile || requiresEmailVerification(profile)) {
    await sendMessage(
      chatId,
      msg.infoMessage(
        "Email Verification Required",
        "To share food, you need to verify your email first.\n\n" +
          `${emoji.EMAIL} <b>Send your email address</b> to get started.\n` +
          `<i>Example: user@example.com</i>`,
      ),
    );

    await setUserState(userId, {
      action: "awaiting_email",
      data: { next_action: "share_food" },
    });
    return;
  }

  const webAppUrl = `${APP_URL}/telegram-webapp/share-food.html`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: t(lang, "share.openFormButton"),
          web_app: { url: webAppUrl },
        },
      ],
      [{ text: t(lang, "share.useChatButton"), callback_data: "share_via_chat" }],
    ],
  };

  await sendMessage(
    chatId,
    t(lang, "share.title") +
      "\n\n" +
      t(lang, "share.chooseMethod") +
      "\n\n" +
      t(lang, "share.webFormRecommended") +
      "\n" +
      t(lang, "share.chatAlternative") +
      "\n\n" +
      t(lang, "share.webFormFaster"),
    { reply_markup: keyboard },
  );
}

export async function handleShareViaChat(
  chatId: number,
  userId: number,
  telegramUser: TelegramUser,
): Promise<void> {
  const profile = await getProfileByTelegramId(telegramUser.id);

  if (!profile || requiresEmailVerification(profile)) {
    await sendMessage(
      chatId,
      msg.infoMessage(
        "Email Verification Required",
        "To share food, you need to verify your email first.\n\n" +
          `${emoji.EMAIL} <b>Send your email address</b> to get started.\n` +
          `<i>Example: user@example.com</i>`,
      ),
    );

    await setUserState(userId, {
      action: "awaiting_email",
      data: { next_action: "share_food" },
    });
    return;
  }

  const state = { action: "sharing_food", data: {}, step: "photo" };
  await setUserState(userId, state);

  const shareMsg = `${emoji.CAMERA} <b>Share Food - Step 1/3</b>\n\n` +
    msg.progressBar(1, 3, 12) +
    " 33%\n\n" +
    msg.divider("─", 25) +
    "\n\n" +
    `${emoji.PHOTO} Send me a photo of the food you want to share\n\n` +
    `${emoji.LIGHT_BULB} <i>Tip: Good photos attract more interest!</i>\n\n` +
    msg.divider("─", 25) +
    "\n\n" +
    `${emoji.INFO} Type /cancel to stop`;

  await sendMessage(chatId, shareMsg);
}

export async function handleFindCommand(
  chatId: number,
  args: string,
  languageCode?: string,
): Promise<void> {
  const lang = await getUserLanguage(0, languageCode);
  const supabase = getSupabaseClient();
  const searchTerm = args || "";

  let query = supabase
    .from("posts")
    .select("id, post_name, post_description, post_address, location, images")
    .eq("post_type", "food")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(5);

  if (searchTerm) {
    query = query.ilike("post_name", `%${searchTerm}%`);
  }

  const { data: foods, error } = await query;

  if (error || !foods || foods.length === 0) {
    await sendMessage(
      chatId,
      searchTerm ? t(lang, "find.noMatch", { query: searchTerm }) : t(lang, "find.noFood"),
    );
    return;
  }

  await sendMessage(chatId, `${emoji.SEARCH} <b>Found ${foods.length} food items:</b>\n`);

  for (const food of foods) {
    const foodMsg = msg.foodCard({
      name: food.post_name,
      description: food.post_description || undefined,
      address: food.post_address || undefined,
    }) + `\n${emoji.LINK} <a href="${APP_URL}/product/${food.id}">View Details</a>`;

    if (food.images?.[0]) {
      await sendPhoto(chatId, food.images[0], foodMsg);
    } else {
      await sendMessage(chatId, foodMsg);
    }

    if (food.location) {
      const coords = await extractCoordinates(food.location);
      if (coords) {
        // SECURITY: Apply 200m approximation for privacy
        const approxCoords = approximateLocation(coords.latitude, coords.longitude, food.id);
        await sendLocation(chatId, approxCoords.latitude, approxCoords.longitude);
      }
    }
  }
}

export async function handleNearbyCommand(chatId: number, userId: number): Promise<void> {
  const supabase = getSupabaseClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("location, search_radius_km")
    .eq("telegram_id", userId)
    .single();

  if (!profile?.location) {
    await sendMessage(
      chatId,
      "📍 <b>Location Not Set</b>\n\n" +
        "Please set your location first using /profile\n" +
        "Or share your location now:",
      {
        reply_markup: {
          keyboard: [[{ text: "📍 Share Location", request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
    return;
  }

  const radius = profile.search_radius_km || 5;

  const { data: nearbyFoods, error } = await supabase.rpc("find_nearby_posts_geography", {
    user_location: profile.location,
    radius_km: radius,
    post_type: "food",
  });

  if (error || !nearbyFoods || nearbyFoods.length === 0) {
    await sendMessage(
      chatId,
      `📍 No food found within ${radius}km of your location.\n\n` +
        "Try increasing your search radius in /profile",
    );
    return;
  }

  await sendMessage(
    chatId,
    `📍 <b>Found ${nearbyFoods.length} food items within ${radius}km:</b>\n`,
  );

  for (const food of nearbyFoods.slice(0, 5)) {
    const text = `
🍎 <b>${food.post_name}</b>
📍 ${food.distance_km?.toFixed(1)}km away
📝 ${food.post_description?.substring(0, 100) || "No description"}

🔗 <a href="${APP_URL}/product/${food.id}">View & Claim</a>
    `.trim();

    if (food.images?.[0]) {
      await sendPhoto(chatId, food.images[0], text);
    } else {
      await sendMessage(chatId, text);
    }
  }
}

export async function handleProfileCommand(chatId: number, userId: number): Promise<void> {
  const supabase = getSupabaseClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("telegram_id", userId)
    .single();

  if (!profile) {
    await sendMessage(
      chatId,
      "👤 <b>Profile Not Found</b>\n\n" +
        "Link your Telegram account on FoodShare:\n" +
        `🔗 <a href="${APP_URL}/profile">Open Profile Settings</a>`,
    );
    return;
  }

  const stats = await getUserImpactStats(userId);

  const profileCard = msg.card(
    `${emoji.USER} Your FoodShare Profile`,
    [
      `<b>${profile.first_name || profile.nickname || "User"}</b>`,
      `${emoji.LOCATION} ${profile.location ? "Location Set" : "No location"}`,
      `${emoji.COMPASS} Search Radius: ${profile.search_radius_km || 5}km`,
      "",
      `<b>${emoji.STATS} Your Impact:</b>`,
      `${emoji.FOOD} Food Shared: ${stats.foodsShared}`,
      `${emoji.RECYCLE} Waste Prevented: ${stats.kgSaved}kg`,
      `${emoji.EARTH} CO2 Saved: ${stats.co2Saved}kg`,
    ],
    `${emoji.LINK} Edit on Website`,
  );

  const keyboard = {
    inline_keyboard: [
      [
        { text: `${emoji.LOCATION} Update Location`, callback_data: "profile_location" },
        { text: `${emoji.COMPASS} Set Radius`, callback_data: "profile_radius" },
      ],
      [{ text: `${emoji.LINK} Open Profile`, url: `${APP_URL}/profile/${profile.id}` }],
    ],
  };

  await sendMessage(chatId, profileCard, { reply_markup: keyboard });
}

export async function handleImpactCommand(chatId: number, userId: number): Promise<void> {
  const stats = await getUserImpactStats(userId);

  const impactMsg = msg.boxedHeader(`${emoji.EARTH} Your Environmental Impact`) +
    "\n\n" +
    msg.impactStats({
      foodShared: stats.foodsShared,
      foodClaimed: stats.foodsClaimed,
      kgSaved: stats.kgSaved,
      co2Saved: stats.co2Saved,
    }) +
    "\n\n" +
    msg.divider("─", 25) +
    "\n\n" +
    `${emoji.CALENDAR} <b>Member Since:</b> ${stats.memberSince}\n` +
    `${emoji.FIRE} <b>Active Days:</b> ${stats.activeDays}\n\n` +
    getBadges(stats) +
    "\n" +
    msg.divider("─", 25) +
    "\n\n" +
    `${emoji.SPARKLES} <i>Keep up the great work! Every share makes a difference.</i>`;

  await sendMessage(chatId, impactMsg);
}

export async function handleStatsCommand(
  chatId: number,
  userId: number,
  languageCode?: string,
): Promise<void> {
  const lang = await getUserLanguage(userId, languageCode);
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("telegram_user_activity")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    await sendMessage(chatId, t(lang, "stats.noStatsYet"));
    return;
  }

  const stats = `
📊 <b>Your Statistics</b>

💬 Messages: ${data.message_count}
📅 Active Days: ${data.active_days?.length || 0}
📝 Characters: ${data.total_characters}
🖼️ Media: ${data.media_count}
↩️ Replies: ${data.reply_count}

First seen: ${data.first_message_date}
Last active: ${data.last_message_date}
  `.trim();

  await sendMessage(chatId, stats);
}

export async function handleLeaderboardCommand(
  chatId: number,
  languageCode?: string,
): Promise<void> {
  const lang = await getUserLanguage(0, languageCode);

  const cached = getCached<string>("leaderboard");
  if (cached) {
    await sendMessage(chatId, cached);
    return;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("telegram_user_activity")
    .select("first_name, username, message_count")
    .order("message_count", { ascending: false })
    .limit(10);

  if (error || !data || data.length === 0) {
    await sendMessage(chatId, t(lang, "leaderboard.noData"));
    return;
  }

  let leaderboard = "🏆 <b>Top Contributors</b>\n\n";
  data.forEach((user, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
    const name = user.first_name || user.username || "Anonymous";
    leaderboard += `${medal} ${name}: ${user.message_count} messages\n`;
  });

  setCache("leaderboard", leaderboard, 300000);
  await sendMessage(chatId, leaderboard);
}

export async function handleLanguageCommand(chatId: number, userId: number): Promise<void> {
  const lang = await getUserLanguage(userId);

  const keyboard = {
    inline_keyboard: [
      [
        { text: `🇬🇧 English`, callback_data: "lang_en" },
        { text: `🇷🇺 Русский`, callback_data: "lang_ru" },
        { text: `🇩🇪 Deutsch`, callback_data: "lang_de" },
      ],
    ],
  };

  await sendMessage(
    chatId,
    msg.boxedHeader(`${emoji.GLOBE} ${t(lang, "language.selectTitle")}`) +
      "\n\n" +
      t(lang, "language.selectMessage"),
    { reply_markup: keyboard },
  );
}
