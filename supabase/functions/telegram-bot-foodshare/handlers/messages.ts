/**
 * Message handlers for text, photo, and location messages
 */

import { logger } from "../../_shared/logger.ts";
import { scheduleGroupMessageDeletion, sendMessage } from "../services/telegram-api.ts";
import { getUserState, setUserState } from "../services/user-state.ts";
import { getProfileByTelegramId, updateProfile } from "../services/profile.ts";
import { trackMessage } from "../services/tracking.ts";
import { getUserLanguage, t } from "../lib/i18n.ts";
import { getMainMenuKeyboard, getMenuActionAllLangs } from "../lib/keyboards.ts";
import * as emoji from "../lib/emojis.ts";
import * as msg from "../lib/messages.ts";
import type { TelegramMessage, TelegramUser } from "../types/index.ts";
import { safeExecute } from "../utils/errors.ts";
import {
  handleFindCommand,
  handleHelpCommand,
  handleImpactCommand,
  handleLanguageCommand,
  handleLeaderboardCommand,
  handleNearbyCommand,
  handleProfileCommand,
  handleShareCommand,
  handleShareViaChat,
  handleStartCommand,
  handleStatsCommand,
} from "./commands.ts";
import { handleEmailInput, handleVerificationCode } from "./auth.ts";

// Actions that require authorization
const PROTECTED_ACTIONS = new Set(["share", "nearby", "profile", "impact", "stats", "language"]);
// Public actions that don't require auth (kept for documentation)
const _PUBLIC_ACTIONS = new Set(["find", "help", "leaderboard"]);

/**
 * Check if user is authorized (has verified email)
 * If not, sends a friendly prompt to register
 */
export async function requireAuth(
  telegramUserId: number,
  chatId: number,
  lang: string,
  action?: string,
): Promise<{
  authorized: boolean;
  profile?: ReturnType<typeof getProfileByTelegramId> extends Promise<infer T> ? T : never;
}> {
  const profile = await getProfileByTelegramId(telegramUserId);

  if (!profile || !profile.email_verified) {
    const actionMessages: Record<string, string> = {
      share: `${emoji.FOOD} To share food with the community, please register first!`,
      nearby: `${emoji.LOCATION} To find food nearby, please register first!`,
      profile: `${emoji.USER} To view your profile, please register first!`,
      impact: `${emoji.LEAF} To see your environmental impact, please register first!`,
      stats: `${emoji.CHART} To view your activity stats, please register first!`,
      language: `${emoji.GLOBE} To change your language, please register first!`,
    };

    const message = actionMessages[action || ""] ||
      `${emoji.LOCK} Please complete registration to use this feature!`;

    await sendMessage(
      chatId,
      msg.infoMessage(
        t(lang, "auth.registrationRequired") || "Registration Required",
        `${message}\n\n` +
          `${emoji.INFO} Use /start to register or sign in.\n\n` +
          `${emoji.SPARKLES} It only takes a minute!`,
      ),
      { reply_markup: getMainMenuKeyboard(lang) },
    );

    return { authorized: false };
  }

  return { authorized: true, profile };
}

/**
 * Greet new members who join a group chat
 */
export async function handleNewChatMembers(
  chatId: number,
  newMembers: TelegramUser[],
): Promise<void> {
  // Skip bots joining
  const humans = newMembers.filter((m) => !m.is_bot);
  if (humans.length === 0) return;

  const names = humans.map((m) => m.first_name).join(", ");

  const greeting = `${emoji.WAVE} <b>Welcome, ${names}!</b>\n\n` +
    `${emoji.SPARKLES} Glad to have you in the FoodShare community!\n\n` +
    `${emoji.FOOD} <b>Share Food</b> - Share surplus food\n` +
    `${emoji.SEARCH} <b>Find Food</b> - Discover free food nearby\n` +
    `${emoji.LEAF} <b>Reduce Waste</b> - Help the planet\n\n` +
    `${emoji.INFO} Message me directly to get started or use /start`;

  const msgId = await sendMessage(chatId, greeting);
  if (msgId) scheduleGroupMessageDeletion(chatId, msgId);
  logger.info("Greeted new members in group", { chatId, members: humans.map((m) => m.id) });
}

export async function handleTextMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (!userId || !text || !message.from) return;

  // Track message activity
  await trackMessage(message);

  const lang = await getUserLanguage(userId, message.from?.language_code);
  const userState = await getUserState(userId);

  // Handle cancel command
  if (text === "/cancel" || text === "❌ Cancel") {
    await setUserState(userId, null);
    await sendMessage(chatId, t(lang, "common.cancel"), {
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  // Handle menu button clicks (check all languages)
  const menuAction = getMenuActionAllLangs(text);
  if (menuAction && !userState?.action) {
    // Check auth for protected actions
    if (PROTECTED_ACTIONS.has(menuAction)) {
      const auth = await requireAuth(userId, chatId, lang, menuAction);
      if (!auth.authorized) return;
    }

    switch (menuAction) {
      case "share":
        return handleShareCommand(chatId, userId, message.from!, message.from?.language_code);
      case "find":
        return handleFindCommand(chatId, "", message.from?.language_code);
      case "nearby":
        return handleNearbyCommand(chatId, userId);
      case "profile":
        return handleProfileCommand(chatId, userId);
      case "impact":
        return handleImpactCommand(chatId, userId);
      case "stats":
        return handleStatsCommand(chatId, userId, message.from?.language_code);
      case "help":
        return handleHelpCommand(chatId, message.from?.language_code);
      case "language":
        return handleLanguageCommand(chatId, userId);
      case "leaderboard":
        return handleLeaderboardCommand(chatId, message.from?.language_code);
    }
  }

  // Handle email input
  if (userState?.action === "awaiting_email") {
    await handleEmailInput(text, message.from, chatId, lang);
    return;
  }

  // Handle verification code input
  if (
    userState?.action === "awaiting_verification" ||
    userState?.action === "awaiting_verification_link"
  ) {
    const verified = await handleVerificationCode(text, message.from, chatId);
    if (verified) {
      // Check if there was a pending action
      // Use safeExecute to handle async errors in setTimeout
      if (userState?.data?.next_action === "share_food") {
        setTimeout(() => {
          safeExecute(
            () => handleShareViaChat(chatId, userId, message.from!),
            "post-verification-share",
          );
        }, 1000);
      } else {
        setTimeout(() => {
          safeExecute(
            () => handleStartCommand(chatId, userId, message.from!),
            "post-verification-start",
          );
        }, 1000);
      }
    }
    return;
  }

  // Handle radius setting
  if (userState?.action === "setting_radius") {
    const radius = parseFloat(text);
    if (isNaN(radius) || radius < 1 || radius > 805) {
      await sendMessage(
        chatId,
        msg.errorMessage("Invalid Radius", "Please enter a number between 1 and 805."),
      );
      return;
    }

    const profile = await getProfileByTelegramId(userId);
    if (profile) {
      await updateProfile(profile.id, { search_radius_km: radius });
      await sendMessage(
        chatId,
        msg.successMessage("Radius Updated", `Search radius set to ${radius}km.`),
      );
      await setUserState(userId, null);
      await handleProfileCommand(chatId, userId);
    }
    return;
  }

  // Handle food sharing description
  if (userState?.action === "sharing_food" && userState.step === "description") {
    userState.data.description = text;
    userState.step = "location";
    await setUserState(userId, userState);

    const locationMsg = `${emoji.SUCCESS} <b>Description Received!</b>\n\n` +
      `${emoji.LOCATION} <b>Share Food - Step 3/3</b>\n\n` +
      msg.progressBar(3, 3, 12) +
      " 100%\n\n" +
      msg.divider("─", 25) +
      "\n\n" +
      `${emoji.LOCATION} Share your location or type an address\n\n` +
      `${emoji.INFO} <i>Tap the 📎 button and select Location</i>\n\n` +
      msg.divider("─", 25);

    await sendMessage(chatId, locationMsg, {
      reply_markup: {
        keyboard: [[{ text: "📍 Share Location", request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  // Handle food sharing location (text address)
  if (userState?.action === "sharing_food" && userState.step === "location") {
    logger.info("Processing text address", { text });
    logger.debug("User state for location", { userState });

    const { extractCoordinates } = await import("../services/geocoding.ts");
    const { getSupabaseClient } = await import("../../_shared/supabase.ts");
    const { APP_URL } = await import("../config/index.ts");
    const { withTimeout } = await import("../utils/timeout.ts");

    await sendMessage(chatId, `${emoji.LOCATION} Looking up location...`);

    // Parallelize geocoding and photo upload
    const [coordsResult, uploadResult, profile] = await Promise.allSettled([
      withTimeout(extractCoordinates(text), 5000, "Geocoding timeout"),
      userState.data.photo
        ? (async () => {
          const { downloadAndUploadTelegramFile } = await import("../services/telegram-files.ts");
          return withTimeout(
            downloadAndUploadTelegramFile(userState.data.photo, userId),
            30000,
            "Photo upload timeout",
          );
        })()
        : Promise.resolve(null),
      getProfileByTelegramId(userId),
    ]);

    // Check geocoding result
    if (coordsResult.status === "rejected" || !coordsResult.value) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Location Not Found",
          `${emoji.ERROR} Couldn't find that location.\n\n` +
            `${emoji.INFO} Please try:\n` +
            `• A more specific address\n` +
            `• City and country (e.g., "Prague, Czech Republic")\n` +
            `• Or use the 📍 Share Location button`,
        ),
      );
      return;
    }

    const coords = coordsResult.value;

    // Check profile
    if (profile.status === "rejected" || !profile.value) {
      await sendMessage(
        chatId,
        msg.errorMessage("Profile Not Found", "Please start over with /start"),
      );
      await setUserState(userId, null);
      return;
    }

    // Handle photo upload result
    let imageUrls: string[] = [];
    let photoWarning = "";

    if (userState.data.photo) {
      if (uploadResult.status === "fulfilled" && uploadResult.value) {
        const { validateImageUrl } = await import("../utils/validation.ts");

        // Validate the URL is a proper Supabase Storage URL
        if (validateImageUrl(uploadResult.value)) {
          imageUrls = [uploadResult.value];
          logger.info("Photo uploaded and validated", { url: uploadResult.value });
        } else {
          logger.error("Invalid image URL returned", { url: uploadResult.value });
          photoWarning = `\n\n${emoji.WARNING} <i>Note: Photo upload failed validation.</i>`;
        }
      } else {
        logger.warn("Failed to upload photo", {
          reason: uploadResult.status === "rejected" ? String(uploadResult.reason) : "No result",
        });
        photoWarning =
          `\n\n${emoji.WARNING} <i>Note: Photo upload failed, but your post was created.</i>`;
      }
    }

    const supabase = getSupabaseClient();
    const point = `POINT(${coords.longitude} ${coords.latitude})`;

    const { data: post, error } = await supabase
      .from("posts")
      .insert({
        profile_id: profile.value.id,
        post_name: userState.data.description.split("\n")[0].substring(0, 100),
        post_description: userState.data.description,
        post_address: text,
        location: point,
        post_type: "food",
        is_active: true,
        images: imageUrls,
      })
      .select()
      .single();

    if (error || !post) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Failed to Create Post",
          `${emoji.ERROR} Something went wrong. Please try again with /share`,
        ),
      );
      await setUserState(userId, null);
      return;
    }

    await sendMessage(
      chatId,
      msg.successMessage(
        "Food Shared Successfully!",
        `${emoji.CELEBRATE} Your food is now available for the community!\n\n` +
          `${emoji.LINK} <a href="${APP_URL}/product/${post.id}">View Your Post</a>\n\n` +
          `${emoji.SPARKLES} Thank you for reducing food waste! 🌍${photoWarning}`,
      ),
      { reply_markup: { remove_keyboard: true } },
    );

    await setUserState(userId, null);
    return;
  }

  // Default response for unrecognized messages - always show menu
  // This ensures new users see the menu on ANY first interaction
  await sendMessage(
    chatId,
    msg.infoMessage(
      t(lang, "common.welcome") || "Welcome to FoodShare!",
      `${emoji.SPARKLES} Use the menu buttons below to get started!\n\n` +
        `${emoji.FOOD} <b>Share Food</b> - Share surplus food\n` +
        `${emoji.SEARCH} <b>Find Food</b> - Discover free food nearby\n` +
        `${emoji.USER} <b>Profile</b> - View your profile\n\n` +
        `${emoji.INFO} Or use /start to register or sign in.`,
    ),
    { reply_markup: getMainMenuKeyboard(lang) },
  );
}

export async function handlePhotoMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  const chatId = message.chat.id;

  if (!userId || !message.photo) return;

  // Track message activity
  await trackMessage(message);

  const userState = await getUserState(userId);

  if (userState?.action === "sharing_food") {
    // Get the largest photo
    const photo = message.photo[message.photo.length - 1];
    userState.data.photo = photo.file_id;
    userState.data.caption = message.caption || "";
    userState.step = "description";
    await setUserState(userId, userState);

    const descMsg = `${emoji.SUCCESS} <b>Photo Received!</b>\n\n` +
      `${emoji.TEXT} <b>Share Food - Step 2/3</b>\n\n` +
      msg.progressBar(2, 3, 12) +
      " 67%\n\n" +
      msg.divider("─", 25) +
      "\n\n" +
      "Tell people about your food:\n" +
      msg.bulletList([
        { emoji: emoji.FOOD, text: "What is it?" },
        { emoji: emoji.INFO, text: "How much?" },
        { emoji: emoji.CLOCK, text: "When to pick up?" },
      ]) +
      "\n\n" +
      msg.divider("─", 20) +
      "\n\n" +
      "<b>Example:</b>\n" +
      "<i>Fresh Apples from My Garden\n\n" +
      "About 2kg of organic apples.\n" +
      "Perfect for eating or baking.\n" +
      "Available for pickup today until 6pm.</i>\n\n" +
      msg.divider("─", 25);

    await sendMessage(chatId, descMsg);
  }
}

export async function handleLocationMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  const chatId = message.chat.id;

  if (!userId || !message.location) return;

  // Track message activity
  await trackMessage(message);

  const userState = await getUserState(userId);

  // Handle food sharing location (GPS)
  if (userState?.action === "sharing_food" && userState.step === "location") {
    const { getSupabaseClient } = await import("../../_shared/supabase.ts");
    const { APP_URL } = await import("../config/index.ts");
    const { withTimeout } = await import("../utils/timeout.ts");

    await sendMessage(chatId, `${emoji.LOCATION} Creating your post...`);

    // Parallelize photo upload and profile fetch
    const [uploadResult, profile] = await Promise.allSettled([
      userState.data.photo
        ? (async () => {
          const { downloadAndUploadTelegramFile } = await import("../services/telegram-files.ts");
          return withTimeout(
            downloadAndUploadTelegramFile(userState.data.photo, userId),
            30000,
            "Photo upload timeout",
          );
        })()
        : Promise.resolve(null),
      getProfileByTelegramId(userId),
    ]);

    // Check profile
    if (profile.status === "rejected" || !profile.value) {
      await sendMessage(
        chatId,
        msg.errorMessage("Profile Not Found", "Please start over with /start"),
      );
      await setUserState(userId, null);
      return;
    }

    // Handle photo upload result
    let imageUrls: string[] = [];
    let photoWarning = "";

    if (userState.data.photo) {
      if (uploadResult.status === "fulfilled" && uploadResult.value) {
        imageUrls = [uploadResult.value];
        logger.info("Photo uploaded", { url: uploadResult.value });
      } else {
        logger.warn("Failed to upload photo", {
          reason: uploadResult.status === "rejected" ? String(uploadResult.reason) : "No result",
        });
        photoWarning =
          `\n\n${emoji.WARNING} <i>Note: Photo upload failed, but your post was created.</i>`;
      }
    }

    const supabase = getSupabaseClient();
    const point = `POINT(${message.location.longitude} ${message.location.latitude})`;

    const { data: post, error } = await supabase
      .from("posts")
      .insert({
        profile_id: profile.value.id,
        post_name: userState.data.description.split("\n")[0].substring(0, 100),
        post_description: userState.data.description,
        location: point,
        post_type: "food",
        is_active: true,
        images: imageUrls,
      })
      .select()
      .single();

    if (error || !post) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Failed to Create Post",
          `${emoji.ERROR} Something went wrong. Please try again with /share`,
        ),
      );
      await setUserState(userId, null);
      return;
    }

    await sendMessage(
      chatId,
      msg.successMessage(
        "Food Shared Successfully!",
        `${emoji.CELEBRATE} Your food is now available for the community!\n\n` +
          `${emoji.LINK} <a href="${APP_URL}/product/${post.id}">View Your Post</a>\n\n` +
          `${emoji.SPARKLES} Thank you for reducing food waste! 🌍${photoWarning}`,
      ),
      { reply_markup: { remove_keyboard: true } },
    );

    await setUserState(userId, null);
    return;
  }

  // Handle profile location update
  if (userState?.action === "updating_profile_location") {
    const profile = await getProfileByTelegramId(userId);
    if (profile) {
      const point = `POINT(${message.location.longitude} ${message.location.latitude})`;
      await updateProfile(profile.id, { location: point });

      await sendMessage(
        chatId,
        msg.successMessage(
          "Location Updated",
          "Your profile location has been updated successfully!",
        ),
      );
      await setUserState(userId, null);
      await handleProfileCommand(chatId, userId);
    }
    return;
  }
}
