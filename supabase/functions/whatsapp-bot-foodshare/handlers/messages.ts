/**
 * Message handlers for WhatsApp Bot
 * Handles text, photo, and location messages
 */

import { logger } from "../../_shared/logger.ts";
import type { WhatsAppMessage } from "../types/index.ts";
import { getUserState, setUserState } from "../services/user-state.ts";
import { getProfileByWhatsAppPhone, updateProfile } from "../services/profile.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";
import { geocodeAddress, extractCoordinates } from "../services/geocoding.ts";
import {
  sendTextMessage,
  sendButtonMessage,
  sendListMessage,
  getMediaUrl,
} from "../services/whatsapp-api.ts";
import { t, getUserLanguage } from "../lib/i18n.ts";
import {
  getMainMenuButtons,
  getExtendedMenuSections,
  getShareMethodButtons,
  getLocationButtons,
  getHelpMessage,
  getFoodCardMessage,
} from "../lib/interactive.ts";
import * as emoji from "../lib/emojis.ts";
import { APP_URL } from "../config/index.ts";
import { createPostGISPoint, sanitizeText } from "../utils/validation.ts";
import {
  handleStart,
  handleEmailInput,
  handleVerificationCode,
  handleResendCode,
  requireAuth,
} from "./auth.ts";

/**
 * Handle incoming text message
 */
export async function handleTextMessage(message: WhatsAppMessage): Promise<void> {
  const phoneNumber = message.from;
  const rawText = message.text?.body?.trim() || "";
  const text = sanitizeText(rawText);
  const lowerText = text.toLowerCase();

  // Check for menu keywords first
  if (["menu", "start", "hi", "hello", "hey"].includes(lowerText)) {
    await handleStart(phoneNumber);
    return;
  }

  if (["help", "?"].includes(lowerText)) {
    await handleHelp(phoneNumber);
    return;
  }

  if (lowerText === "cancel") {
    await handleCancel(phoneNumber);
    return;
  }

  if (lowerText === "resend") {
    await handleResendCode(phoneNumber);
    return;
  }

  // Check user state for multi-step flows
  const state = await getUserState(phoneNumber);

  if (state) {
    switch (state.action) {
      case "awaiting_email":
        await handleEmailInput(phoneNumber, text);
        return;

      case "awaiting_verification":
        const handled = await handleVerificationCode(phoneNumber, text);
        if (handled) return;
        break;

      case "sharing_food":
        await handleSharingFoodText(phoneNumber, text, state);
        return;
    }
  }

  // No state - show menu
  await handleStart(phoneNumber);
}

/**
 * Handle incoming photo message
 */
export async function handlePhotoMessage(message: WhatsAppMessage): Promise<void> {
  const phoneNumber = message.from;
  const lang = await getUserLanguage(phoneNumber);
  const state = await getUserState(phoneNumber);

  // Check if in sharing flow
  if (state?.action === "sharing_food" && state.step === "awaiting_photo") {
    const mediaId = message.image?.id;

    if (!mediaId) {
      await sendTextMessage(
        phoneNumber,
        `${emoji.ERROR} Could not process photo. Please try again.`
      );
      return;
    }

    // Get media URL
    const mediaUrl = await getMediaUrl(mediaId);

    if (!mediaUrl) {
      await sendTextMessage(
        phoneNumber,
        `${emoji.ERROR} Could not download photo. Please try again.`
      );
      return;
    }

    // Store photo URL and move to next step
    await setUserState(phoneNumber, {
      action: "sharing_food",
      step: "awaiting_description",
      data: {
        ...state.data,
        photo: mediaUrl,
      },
    });

    await sendTextMessage(phoneNumber, t(lang, "share.step2Description"));
    return;
  }

  // Not in a flow - suggest sharing
  if (await requireAuth(phoneNumber)) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.PHOTO} Nice photo! Would you like to share food?\n\nTap the button below to start sharing.`
    );
    await sendButtonMessage(
      phoneNumber,
      "Share this food with the community?",
      getShareMethodButtons(lang)
    );
  }
}

/**
 * Handle incoming location message
 */
export async function handleLocationMessage(message: WhatsAppMessage): Promise<void> {
  const phoneNumber = message.from;
  const state = await getUserState(phoneNumber);

  const location = message.location;
  if (!location) return;

  const coords = extractCoordinates(location);

  // Check if in sharing flow
  if (state?.action === "sharing_food" && state.step === "awaiting_location") {
    await createFoodPost(phoneNumber, {
      ...state.data,
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
    return;
  }

  // Not in a flow - update profile location and show nearby
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (profile) {
    // Update profile location with validated coordinates
    const point = createPostGISPoint(coords.latitude, coords.longitude);
    if (point) {
      await updateProfile(profile.id, {
        location: point,
      });
    }

    await sendTextMessage(
      phoneNumber,
      `${emoji.SUCCESS} Location updated!\n\n${emoji.SEARCH} Looking for nearby food...`
    );

    await handleNearby(phoneNumber, coords.latitude, coords.longitude);
  }
}

/**
 * Handle help command
 */
async function handleHelp(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const helpMsg = getHelpMessage(lang);

  await sendListMessage(
    phoneNumber,
    helpMsg,
    "View Options",
    getExtendedMenuSections(lang),
    t(lang, "help.title")
  );
}

/**
 * Handle cancel command
 */
async function handleCancel(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  await setUserState(phoneNumber, null);
  await sendTextMessage(phoneNumber, `${emoji.SUCCESS} ${t(lang, "common.cancel")}`);
  await sendButtonMessage(phoneNumber, "What would you like to do?", getMainMenuButtons(lang));
}

/**
 * Handle sharing food text input
 */
async function handleSharingFoodText(
  phoneNumber: string,
  text: string,
  state: { action: string; step?: string; data: Record<string, string | undefined> }
): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);

  if (state.step === "awaiting_description") {
    // Sanitize and store description, then ask for location
    const sanitizedDescription = sanitizeText(text);
    await setUserState(phoneNumber, {
      action: "sharing_food",
      step: "awaiting_location",
      data: {
        ...state.data,
        description: sanitizedDescription,
      },
    });

    await sendButtonMessage(phoneNumber, t(lang, "share.step3Location"), getLocationButtons(lang));
    return;
  }

  if (state.step === "awaiting_location") {
    const lowerText = text.toLowerCase();

    if (lowerText === "skip") {
      // Use profile location
      const profile = await getProfileByWhatsAppPhone(phoneNumber);

      if (profile?.location) {
        // Parse PostGIS point
        const match = profile.location.match(/POINT\(([^ ]+) ([^)]+)\)/);

        if (match) {
          await createFoodPost(phoneNumber, {
            ...state.data,
            longitude: parseFloat(match[1]),
            latitude: parseFloat(match[2]),
          });
          return;
        }
      }

      // No profile location - create without
      await createFoodPost(phoneNumber, state.data);
      return;
    }

    // Try to geocode address
    await sendTextMessage(phoneNumber, t(lang, "share.lookingUpLocation"));

    const coords = await geocodeAddress(text);

    if (!coords) {
      await sendTextMessage(phoneNumber, t(lang, "share.locationNotFound"));
      return;
    }

    await createFoodPost(phoneNumber, {
      ...state.data,
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
  }
}

/**
 * Create food post in database
 */
async function createFoodPost(
  phoneNumber: string,
  data: Record<string, string | number | undefined>
): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (!profile) {
    await sendTextMessage(phoneNumber, `${emoji.ERROR} Profile not found.`);
    await setUserState(phoneNumber, null);
    return;
  }

  const supabase = getSupabaseClient();

  const postData: Record<string, unknown> = {
    profile_id: profile.id,
    post_type: "food",
    post_name: (data.description as string)?.substring(0, 100) || "Food",
    post_description: data.description,
    is_active: true,
  };

  if (data.latitude && data.longitude) {
    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    const point = createPostGISPoint(lat, lng);
    if (point) {
      postData.location = point;
    }
  }

  const { data: post, error } = await supabase.from("posts").insert(postData).select("id").single();

  if (error) {
    logger.error("Failed to create post", { error: String(error) });
    await sendTextMessage(phoneNumber, `${emoji.ERROR} Failed to create post. Please try again.`);
    await setUserState(phoneNumber, null);
    return;
  }

  await setUserState(phoneNumber, null);

  const postUrl = `${APP_URL}/food/${post.id}`;
  await sendTextMessage(
    phoneNumber,
    `${emoji.CELEBRATE} *${t(lang, "share.success")}*\n\n${emoji.LINK} ${postUrl}`
  );

  await sendButtonMessage(phoneNumber, "What's next?", getMainMenuButtons(lang));
}

/**
 * Handle nearby food search
 */
async function handleNearby(
  phoneNumber: string,
  _latitude: number,
  _longitude: number
): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const supabase = getSupabaseClient();

  // Find nearby posts
  const { data: posts, error } = await supabase
    .from("posts_with_location")
    .select("*")
    .eq("post_type", "food")
    .eq("is_active", true)
    .limit(5);

  if (error || !posts || posts.length === 0) {
    await sendTextMessage(phoneNumber, t(lang, "find.noFood"));
    return;
  }

  await sendTextMessage(
    phoneNumber,
    `${emoji.FOOD} *${t(lang, "find.title", { count: posts.length })}*`
  );

  for (const post of posts) {
    const card = getFoodCardMessage({
      name: post.post_name || "Food",
      description: post.post_description,
      address: post.address,
    });

    await sendTextMessage(phoneNumber, card);
  }
}
