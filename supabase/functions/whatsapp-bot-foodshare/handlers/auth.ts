/**
 * Authentication handler for WhatsApp Bot
 * Email verification flow
 */

import {
  getProfileByWhatsAppPhone,
  getProfileByEmail,
  createProfile,
  updateProfile,
  generateVerificationCode,
} from "../services/profile.ts";
import { sendVerificationEmail } from "../services/email.ts";
import { setUserState, getUserState } from "../services/user-state.ts";
import { sendTextMessage, sendButtonMessage } from "../services/whatsapp-api.ts";
import { t, getUserLanguage } from "../lib/i18n.ts";
import { getAuthButtons, getMainMenuButtons, getWelcomeMessage } from "../lib/interactive.ts";
import { isValidEmail, isValidVerificationCode } from "../utils/validation.ts";
import * as emoji from "../lib/emojis.ts";
import { VERIFICATION_CODE_EXPIRY_MS } from "../config/constants.ts";

/**
 * Handle new user or returning user
 */
export async function handleStart(phoneNumber: string, contactName?: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (profile && profile.email_verified) {
    // Verified user - show welcome back
    const message = getWelcomeMessage(profile.first_name || contactName, lang);
    await sendButtonMessage(
      phoneNumber,
      message,
      getMainMenuButtons(lang),
      t(lang, "welcome.welcomeBack")
    );
    return;
  }

  if (profile && !profile.email_verified) {
    // Unverified user - prompt for verification
    await sendTextMessage(
      phoneNumber,
      `${emoji.EMAIL} ${t(lang, "auth.verifyEmailTitle")}\n\n${t(lang, "auth.sendEmailToSignIn")}`
    );
    await setUserState(phoneNumber, { action: "awaiting_email", data: {} });
    return;
  }

  // New user - ask for email
  const welcomeMsg = `${emoji.WAVE} *${t(lang, "welcome.title")}*\n\n${t(lang, "welcome.subtitle")}\n\n${emoji.EMAIL} ${t(lang, "auth.sendEmailToRegister")}`;
  await sendTextMessage(phoneNumber, welcomeMsg);
  await setUserState(phoneNumber, { action: "awaiting_email", data: {} });
}

/**
 * Handle email input
 */
export async function handleEmailInput(
  phoneNumber: string,
  email: string,
  contactName?: string
): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const normalizedEmail = email.toLowerCase().trim();

  // Validate email format
  if (!isValidEmail(normalizedEmail)) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.ERROR} *${t(lang, "auth.invalidEmailTitle")}*\n\n${t(lang, "auth.invalidEmailMessage")}`
    );
    return;
  }

  // Check if email exists
  const existingProfile = await getProfileByEmail(normalizedEmail);

  if (existingProfile) {
    // Check if already linked to another WhatsApp
    if (existingProfile.whatsapp_phone && existingProfile.whatsapp_phone !== phoneNumber) {
      await sendTextMessage(
        phoneNumber,
        `${emoji.ERROR} *${t(lang, "auth.emailAlreadyLinkedTitle")}*\n\n${t(lang, "auth.emailAlreadyLinkedMessage")}`
      );
      await setUserState(phoneNumber, null);
      return;
    }

    // Generate and send verification code
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MS).toISOString();

    await updateProfile(existingProfile.id, {
      verification_code: code,
      verification_code_expires_at: expiresAt,
    });

    const emailSent = await sendVerificationEmail(normalizedEmail, code);

    if (!emailSent) {
      await sendTextMessage(
        phoneNumber,
        `${emoji.ERROR} *${t(lang, "auth.emailDeliveryFailedTitle")}*\n\n${t(lang, "auth.emailDeliveryFailedMessage")}`
      );
      return;
    }

    await sendButtonMessage(
      phoneNumber,
      `${emoji.SUCCESS} *${t(lang, "auth.accountFound")}*\n\n${t(lang, "auth.codeEmailSent")}\n\n${emoji.EMAIL} ${normalizedEmail}\n\n${t(lang, "auth.enterCodeToSignIn")}\n\n${emoji.CLOCK} ${t(lang, "auth.codeExpires")}`,
      getAuthButtons(lang),
      t(lang, "auth.checkInbox")
    );

    await setUserState(phoneNumber, {
      action: "awaiting_verification",
      data: {
        email: normalizedEmail,
        existing_profile_id: existingProfile.id,
      },
    });
    return;
  }

  // New user - create profile
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MS).toISOString();

  const newProfile = await createProfile({
    id: crypto.randomUUID(),
    whatsapp_phone: phoneNumber,
    first_name: contactName || "User",
    nickname: null,
    email: normalizedEmail,
    verification_code: code,
    verification_code_expires_at: expiresAt,
  });

  if (!newProfile) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.ERROR} *${t(lang, "auth.registrationFailedTitle")}*\n\n${t(lang, "auth.registrationFailedMessage")}`
    );
    return;
  }

  const emailSent = await sendVerificationEmail(normalizedEmail, code);

  if (!emailSent) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.ERROR} *${t(lang, "auth.emailDeliveryFailedTitle")}*\n\n${t(lang, "auth.emailDeliveryFailedMessage")}`
    );
    return;
  }

  await sendButtonMessage(
    phoneNumber,
    `${emoji.SUCCESS} *${t(lang, "auth.accountCreated")}*\n\n${t(lang, "auth.codeSentTo")}\n${emoji.EMAIL} ${normalizedEmail}\n\n${emoji.CLOCK} ${t(lang, "auth.codeExpires")}`,
    getAuthButtons(lang),
    t(lang, "auth.verifyEmailTitle")
  );

  await setUserState(phoneNumber, {
    action: "awaiting_verification",
    data: {
      email: normalizedEmail,
      profile_id: newProfile.id,
    },
  });
}

/**
 * Handle verification code input
 */
export async function handleVerificationCode(phoneNumber: string, code: string): Promise<boolean> {
  const lang = await getUserLanguage(phoneNumber);
  const state = await getUserState(phoneNumber);

  if (!state || state.action !== "awaiting_verification") {
    return false;
  }

  const trimmedCode = code.trim();

  if (!isValidVerificationCode(trimmedCode)) {
    await sendTextMessage(phoneNumber, `${emoji.ERROR} ${t(lang, "auth.invalidCode")}`);
    return true; // Handled, but invalid
  }

  const email = state.data.email;
  if (!email) {
    await setUserState(phoneNumber, null);
    return false;
  }

  const profile = await getProfileByEmail(email);

  if (!profile) {
    await sendTextMessage(phoneNumber, `${emoji.ERROR} Profile not found.`);
    await setUserState(phoneNumber, null);
    return true;
  }

  // Check code validity
  if (profile.verification_code !== trimmedCode) {
    await sendTextMessage(phoneNumber, `${emoji.ERROR} ${t(lang, "auth.invalidCode")}`);
    return true;
  }

  // Check expiration
  if (profile.verification_code_expires_at) {
    const expiresAt = new Date(profile.verification_code_expires_at);
    if (expiresAt < new Date()) {
      await sendTextMessage(phoneNumber, `${emoji.WARNING} ${t(lang, "auth.codeExpired")}`);
      return true;
    }
  }

  // Verify and link account
  await updateProfile(profile.id, {
    email_verified: true,
    whatsapp_phone: phoneNumber,
    verification_code: null,
    verification_code_expires_at: null,
  });

  await setUserState(phoneNumber, null);

  // Send success message with menu
  const welcomeMsg = getWelcomeMessage(profile.first_name || undefined, lang);
  await sendButtonMessage(
    phoneNumber,
    `${emoji.CELEBRATE} *${t(lang, "auth.verificationSuccess")}*\n\n${welcomeMsg}`,
    getMainMenuButtons(lang),
    t(lang, "welcome.accountReady")
  );

  return true;
}

/**
 * Handle resend code request
 */
export async function handleResendCode(phoneNumber: string): Promise<void> {
  const lang = await getUserLanguage(phoneNumber);
  const state = await getUserState(phoneNumber);

  if (!state || state.action !== "awaiting_verification" || !state.data.email) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.INFO} No pending verification. Send your email to start.`
    );
    return;
  }

  const profile = await getProfileByEmail(state.data.email);

  if (!profile) {
    await sendTextMessage(phoneNumber, `${emoji.ERROR} Profile not found.`);
    await setUserState(phoneNumber, null);
    return;
  }

  // Generate new code
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + VERIFICATION_CODE_EXPIRY_MS).toISOString();

  await updateProfile(profile.id, {
    verification_code: code,
    verification_code_expires_at: expiresAt,
  });

  const emailSent = await sendVerificationEmail(state.data.email, code);

  if (emailSent) {
    await sendTextMessage(
      phoneNumber,
      `${emoji.SUCCESS} New code sent to ${state.data.email}\n\n${emoji.CLOCK} ${t(lang, "auth.codeExpires")}`
    );
  } else {
    await sendTextMessage(
      phoneNumber,
      `${emoji.ERROR} ${t(lang, "auth.emailDeliveryFailedMessage")}`
    );
  }
}

/**
 * Check if user requires authentication
 */
export async function requireAuth(phoneNumber: string): Promise<boolean> {
  const profile = await getProfileByWhatsAppPhone(phoneNumber);

  if (!profile || !profile.email_verified) {
    const lang = await getUserLanguage(phoneNumber);
    await sendTextMessage(
      phoneNumber,
      `${emoji.LOCK} ${t(lang, "share.linkAccountFirst")}\n\n${emoji.EMAIL} ${t(lang, "auth.sendEmailToRegister")}`
    );
    await setUserState(phoneNumber, { action: "awaiting_email", data: {} });
    return false;
  }

  return true;
}
