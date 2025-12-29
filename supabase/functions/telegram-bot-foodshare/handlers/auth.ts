/**
 * Authentication handlers with brute-force protection
 */

import { sendMessage } from "../services/telegram-api.ts";
import { getUserState, setUserState } from "../services/user-state.ts";
import {
  getProfileByTelegramId,
  getProfileByEmail,
  generateVerificationCode,
  createProfile,
  updateProfile,
} from "../services/profile.ts";
import { sendVerificationEmail } from "../services/email.ts";
import { t, getUserLanguage } from "../lib/i18n.ts";
import { getMainMenuKeyboard } from "../lib/keyboards.ts";
import * as emoji from "../lib/emojis.ts";
import * as msg from "../lib/messages.ts";
import type { TelegramUser } from "../types/index.ts";

// Brute-force protection constants
const MAX_VERIFICATION_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

// Rate limiting for resend code (3 requests per hour per user)
const RESEND_RATE_LIMIT_MAX = 3;
const RESEND_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const resendRateLimitMap = new Map<number, { count: number; resetAt: number }>();

/**
 * Check if user can resend verification code
 */
function checkResendRateLimit(userId: number): { allowed: boolean; remainingMinutes?: number } {
  const now = Date.now();
  const limit = resendRateLimitMap.get(userId);

  // Clean up expired entry
  if (limit && limit.resetAt < now) {
    resendRateLimitMap.delete(userId);
  }

  const current = resendRateLimitMap.get(userId);

  if (!current) {
    // First request in window
    resendRateLimitMap.set(userId, {
      count: 1,
      resetAt: now + RESEND_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true };
  }

  if (current.count >= RESEND_RATE_LIMIT_MAX) {
    const remainingMs = current.resetAt - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { allowed: false, remainingMinutes };
  }

  // Increment count
  current.count++;
  resendRateLimitMap.set(userId, current);
  return { allowed: true };
}

/**
 * Check if account is locked due to too many failed attempts
 */
function isAccountLocked(profile: {
  verification_attempts?: number;
  verification_locked_until?: string | null;
}): { locked: boolean; remainingMinutes?: number } {
  if (!profile.verification_locked_until) {
    return { locked: false };
  }

  const lockedUntil = new Date(profile.verification_locked_until);
  const now = new Date();

  if (lockedUntil > now) {
    const remainingMs = lockedUntil.getTime() - now.getTime();
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { locked: true, remainingMinutes };
  }

  return { locked: false };
}

/**
 * Increment failed verification attempts and lock if threshold exceeded
 */
async function incrementFailedAttempts(
  profileId: string,
  currentAttempts: number = 0
): Promise<void> {
  const newAttempts = currentAttempts + 1;

  if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    // Lock the account
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
    await updateProfile(profileId, {
      verification_attempts: newAttempts,
      verification_locked_until: lockedUntil.toISOString(),
    });
    console.log(
      JSON.stringify({
        level: "warn",
        message: "Account locked due to too many failed verification attempts",
        profileId,
        attempts: newAttempts,
        lockedUntil: lockedUntil.toISOString(),
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    await updateProfile(profileId, {
      verification_attempts: newAttempts,
    });
  }
}

/**
 * Reset verification attempts on successful verification
 */
async function _resetVerificationAttempts(profileId: string): Promise<void> {
  await updateProfile(profileId, {
    verification_attempts: 0,
    verification_locked_until: null,
  });
}

export async function handleEmailInput(
  email: string,
  telegramUser: TelegramUser,
  chatId: number,
  lang: string = "en"
): Promise<void> {
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    const keyboard = {
      inline_keyboard: [
        [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
      ],
    };

    await sendMessage(
      chatId,
      msg.errorMessage(
        t(lang, "auth.invalidEmailTitle"),
        t(lang, "auth.invalidEmailMessage") +
          "\n\n" +
          `${emoji.INFO} <b>${t(lang, "common.example")}:</b> <code>user@example.com</code>`
      ),
      { reply_markup: keyboard }
    );
    return;
  }

  // Check if this Telegram user already has a profile
  const telegramProfile = await getProfileByTelegramId(telegramUser.id);

  // Check if email already exists in database
  const existingProfile = await getProfileByEmail(email);

  // Case 1: Telegram user already has a verified profile - just update email if needed
  if (telegramProfile && telegramProfile.email_verified) {
    // If trying to use a different email that's already taken
    if (existingProfile && existingProfile.id !== telegramProfile.id) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailAlreadyLinkedTitle"),
          t(lang, "auth.emailAlreadyLinkedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }

    // Update email if different
    if (telegramProfile.email !== email) {
      await updateProfile(telegramProfile.id, { email });
    }

    await sendMessage(
      chatId,
      msg.successMessage(
        t(lang, "auth.accountReady"),
        `${emoji.EMAIL} <b>${t(lang, "common.email")}:</b> <code>${email}</code>\n\n` +
          `${emoji.SUCCESS} ${t(lang, "auth.alreadyVerified")}`
      )
    );
    return;
  }

  // Case 2: Email exists with verified account - Link Telegram to existing account
  if (existingProfile && existingProfile.email_verified) {
    // Check if already linked to another Telegram account
    if (existingProfile.telegram_id && existingProfile.telegram_id !== telegramUser.id) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailAlreadyLinkedTitle"),
          t(lang, "auth.emailAlreadyLinkedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }

    // Generate verification code to link Telegram account
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await updateProfile(existingProfile.id, {
      verification_code: code,
      verification_code_expires_at: expiresAt.toISOString(),
    });

    const emailSent = await sendVerificationEmail(email, code);

    if (emailSent) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.boxedHeader(`${emoji.KEY} ${t(lang, "auth.signInTitle")}`) +
          "\n\n" +
          `${emoji.SUCCESS} <b>${t(lang, "auth.accountFound")}</b>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          t(lang, "auth.signInMessage") +
          "\n\n" +
          `${emoji.EMAIL} <b>${t(lang, "common.email")}:</b> <code>${email}</code>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.EMAIL} <b>${t(lang, "auth.checkInbox")}</b>\n\n` +
          t(lang, "auth.codeEmailSent") +
          "\n\n" +
          `${emoji.KEY} ${t(lang, "auth.enterCodeToSignIn")}\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.CLOCK} ${t(lang, "auth.codeExpires")}\n` +
          `${emoji.REFRESH} ${t(lang, "auth.resendHint")}`,
        { reply_markup: keyboard }
      );

      await setUserState(telegramUser.id, {
        action: "awaiting_verification_link",
        data: {
          existing_profile_id: existingProfile.id,
          email: email,
        },
        language: lang,
      });
      return;
    } else {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailDeliveryFailedTitle"),
          t(lang, "auth.emailDeliveryFailedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }
  }

  // Case 3: Email exists but not verified - Complete Registration Flow
  if (existingProfile && !existingProfile.email_verified) {
    // Check if already linked to another Telegram account
    if (existingProfile.telegram_id && existingProfile.telegram_id !== telegramUser.id) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailAlreadyLinkedTitle"),
          t(lang, "auth.emailAlreadyLinkedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }

    // Update telegram_id if not set
    if (!existingProfile.telegram_id) {
      await updateProfile(existingProfile.id, {
        telegram_id: telegramUser.id,
        first_name: telegramUser.first_name,
        nickname: telegramUser.username || existingProfile.nickname,
      });
    }

    // Generate verification code to complete registration
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await updateProfile(existingProfile.id, {
      verification_code: code,
      verification_code_expires_at: expiresAt.toISOString(),
    });

    const emailSent = await sendVerificationEmail(email, code);

    if (emailSent) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.boxedHeader(`${emoji.EMAIL} ${t(lang, "auth.completeRegistrationTitle")}`) +
          "\n\n" +
          `${emoji.SUCCESS} <b>${t(lang, "auth.accountFound")}</b>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          t(lang, "auth.completeRegistrationMessage") +
          "\n\n" +
          `${emoji.EMAIL} <b>${t(lang, "common.email")}:</b> <code>${email}</code>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.KEY} ${t(lang, "auth.enterCodeToVerify")}\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.CLOCK} ${t(lang, "auth.codeExpires")}\n` +
          `${emoji.REFRESH} ${t(lang, "auth.resendHint")}`,
        { reply_markup: keyboard }
      );

      await setUserState(telegramUser.id, {
        action: "awaiting_verification_link",
        data: {
          existing_profile_id: existingProfile.id,
          email: email,
        },
        language: lang,
      });
      return;
    } else {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailDeliveryFailedTitle"),
          t(lang, "auth.emailDeliveryFailedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }
  }

  // Case 4: Telegram user exists but trying new email - Update existing profile
  if (telegramProfile && !telegramProfile.email_verified) {
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await updateProfile(telegramProfile.id, {
      email: email,
      verification_code: code,
      verification_code_expires_at: expiresAt.toISOString(),
    });

    const emailSent = await sendVerificationEmail(email, code);

    if (emailSent) {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.boxedHeader(`${emoji.EMAIL} ${t(lang, "auth.verifyEmailTitle")}`) +
          "\n\n" +
          `${emoji.SUCCESS} <b>${t(lang, "auth.accountCreated")}</b>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          t(lang, "auth.codeSentTo") +
          "\n\n" +
          `${emoji.EMAIL} <code>${email}</code>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.KEY} <b>${t(lang, "auth.enterCodeToVerify")}</b>\n\n` +
          `${emoji.INFO} <i>${t(lang, "common.example")}: 123456</i>\n\n` +
          msg.divider("─", 30) +
          "\n\n" +
          `${emoji.CLOCK} ${t(lang, "auth.codeExpires")}\n` +
          `${emoji.REFRESH} ${t(lang, "auth.resendHint")}`,
        { reply_markup: keyboard }
      );

      await setUserState(telegramUser.id, {
        action: "awaiting_verification",
        data: {
          profile_id: telegramProfile.id,
          email: email,
        },
        language: lang,
      });
      return;
    } else {
      const keyboard = {
        inline_keyboard: [
          [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
        ],
      };

      await sendMessage(
        chatId,
        msg.errorMessage(
          t(lang, "auth.emailDeliveryFailedTitle"),
          t(lang, "auth.emailDeliveryFailedMessage")
        ),
        { reply_markup: keyboard }
      );
      return;
    }
  }

  // Case 5: Completely new user - Create New Profile
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const profileId = crypto.randomUUID();

  const newProfile = await createProfile({
    id: profileId,
    telegram_id: telegramUser.id,
    first_name: telegramUser.first_name,
    nickname: telegramUser.username || null,
    email: email,
    verification_code: code,
    verification_code_expires_at: expiresAt.toISOString(),
  });

  if (!newProfile) {
    const keyboard = {
      inline_keyboard: [
        [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
      ],
    };

    await sendMessage(
      chatId,
      msg.errorMessage(
        t(lang, "auth.registrationFailedTitle"),
        t(lang, "auth.registrationFailedMessage")
      ),
      { reply_markup: keyboard }
    );
    return;
  }

  const emailSent = await sendVerificationEmail(email, code);

  if (emailSent) {
    const keyboard = {
      inline_keyboard: [
        [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
      ],
    };

    await sendMessage(
      chatId,
      msg.boxedHeader(`${emoji.EMAIL} ${t(lang, "auth.verifyEmailTitle")}`) +
        "\n\n" +
        `${emoji.SUCCESS} <b>${t(lang, "auth.accountCreated")}</b>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        t(lang, "auth.codeSentTo") +
        "\n\n" +
        `${emoji.EMAIL} <code>${email}</code>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.KEY} <b>${t(lang, "auth.enterCodeToVerify")}</b>\n\n` +
        `${emoji.INFO} <i>${t(lang, "common.example")}: 123456</i>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.CLOCK} ${t(lang, "auth.codeExpires")}\n` +
        `${emoji.REFRESH} ${t(lang, "auth.resendHint")}`,
      { reply_markup: keyboard }
    );

    await setUserState(telegramUser.id, {
      action: "awaiting_verification",
      data: {
        profile_id: newProfile.id,
        email: email,
      },
      language: lang,
    });
  } else {
    // Delete the profile if email failed
    await updateProfile(profileId, { email: null });

    const keyboard = {
      inline_keyboard: [
        [{ text: `${emoji.BACK} ${t(lang, "common.back")}`, callback_data: "back_to_start" }],
      ],
    };

    await sendMessage(
      chatId,
      msg.errorMessage(
        t(lang, "auth.emailDeliveryFailedTitle"),
        t(lang, "auth.emailDeliveryFailedMessage")
      ),
      { reply_markup: keyboard }
    );
  }
}

export async function handleVerificationCode(
  code: string,
  telegramUser: TelegramUser,
  chatId: number
): Promise<boolean> {
  const userState = await getUserState(telegramUser.id);

  // Validate code format (6 digits)
  if (!/^\d{6}$/.test(code)) {
    await sendMessage(
      chatId,
      msg.errorMessage(
        "Invalid Code Format",
        "Please enter a 6-digit code.\n\n" +
          `${emoji.INFO} <b>Example:</b> <code>123456</code>\n\n` +
          `${emoji.REFRESH} Type /resend to get a new code`
      )
    );
    return false;
  }

  // Case 1: Linking to existing profile (Sign In or Complete Registration)
  if (userState?.action === "awaiting_verification_link") {
    const { existing_profile_id, email } = userState.data;

    const existingProfile = await getProfileByTelegramId(telegramUser.id);

    if (!existingProfile) {
      await sendMessage(
        chatId,
        msg.errorMessage("Profile Not Found", "Please try signing in again with /start")
      );
      await setUserState(telegramUser.id, null);
      return false;
    }

    // Check if account is locked
    const lockStatus = isAccountLocked(existingProfile);
    if (lockStatus.locked) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Account Temporarily Locked",
          `Too many failed verification attempts.\n\n` +
            `${emoji.CLOCK} Please wait ${lockStatus.remainingMinutes} minutes before trying again.\n\n` +
            `${emoji.INFO} This is a security measure to protect your account.`
        )
      );
      return false;
    }

    // Check if code matches and hasn't expired
    if (existingProfile.verification_code !== code) {
      await incrementFailedAttempts(
        existing_profile_id,
        existingProfile.verification_attempts || 0
      );
      const attemptsLeft =
        MAX_VERIFICATION_ATTEMPTS - ((existingProfile.verification_attempts || 0) + 1);

      await sendMessage(
        chatId,
        msg.errorMessage(
          "Incorrect Code",
          "The code you entered doesn't match.\n\n" +
            `${emoji.INFO} Please check your email and try again.\n\n` +
            (attemptsLeft > 0
              ? `${emoji.WARNING} ${attemptsLeft} attempts remaining.\n\n`
              : `${emoji.WARNING} Account will be locked after next failed attempt.\n\n`) +
            `${emoji.REFRESH} Type /resend to get a new code`
        )
      );
      return false;
    }

    if (
      !existingProfile.verification_code_expires_at ||
      new Date(existingProfile.verification_code_expires_at) < new Date()
    ) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Code Expired",
          "Your verification code has expired.\n\n" +
            `${emoji.REFRESH} Type /resend to get a new code`
        )
      );
      return false;
    }

    // Link the Telegram account to the existing profile and reset attempts
    await updateProfile(existing_profile_id, {
      telegram_id: telegramUser.id,
      first_name: telegramUser.first_name,
      nickname: telegramUser.username || existingProfile.nickname,
      email_verified: true,
      verification_code: null,
      verification_code_expires_at: null,
      verification_attempts: 0,
      verification_locked_until: null,
    });

    const lang = await getUserLanguage(telegramUser.id);
    await sendMessage(
      chatId,
      msg.boxedHeader(`${emoji.CELEBRATE} Successfully Signed In!`) +
        "\n\n" +
        `${emoji.SUCCESS} <b>Your Telegram account is now linked!</b>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.EMAIL} <b>Email:</b> <code>${email}</code>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.ROCKET} <b>Ready to go!</b>\n\n` +
        `Use the menu below to get started:`,
      { reply_markup: getMainMenuKeyboard(lang) }
    );

    await setUserState(telegramUser.id, null);
    return true;
  }

  // Case 2: Normal email verification for new registration
  if (userState?.action === "awaiting_verification") {
    const { profile_id, email } = userState.data;

    const profile = await getProfileByTelegramId(telegramUser.id);

    if (!profile) {
      await sendMessage(
        chatId,
        msg.errorMessage("Profile Not Found", "Please try registering again with /start")
      );
      await setUserState(telegramUser.id, null);
      return false;
    }

    // Check if account is locked
    const lockStatus = isAccountLocked(profile);
    if (lockStatus.locked) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Account Temporarily Locked",
          `Too many failed verification attempts.\n\n` +
            `${emoji.CLOCK} Please wait ${lockStatus.remainingMinutes} minutes before trying again.\n\n` +
            `${emoji.INFO} This is a security measure to protect your account.`
        )
      );
      return false;
    }

    if (profile.verification_code !== code) {
      await incrementFailedAttempts(profile_id, profile.verification_attempts || 0);
      const attemptsLeft = MAX_VERIFICATION_ATTEMPTS - ((profile.verification_attempts || 0) + 1);

      await sendMessage(
        chatId,
        msg.errorMessage(
          "Incorrect Code",
          "The code you entered doesn't match.\n\n" +
            `${emoji.INFO} Please check your email and try again.\n\n` +
            (attemptsLeft > 0
              ? `${emoji.WARNING} ${attemptsLeft} attempts remaining.\n\n`
              : `${emoji.WARNING} Account will be locked after next failed attempt.\n\n`) +
            `${emoji.REFRESH} Type /resend to get a new code`
        )
      );
      return false;
    }

    if (
      !profile.verification_code_expires_at ||
      new Date(profile.verification_code_expires_at) < new Date()
    ) {
      await sendMessage(
        chatId,
        msg.errorMessage(
          "Code Expired",
          "Your verification code has expired.\n\n" +
            `${emoji.REFRESH} Type /resend to get a new code`
        )
      );
      return false;
    }

    // Verify email, clear verification code, and reset attempts
    await updateProfile(profile_id, {
      email_verified: true,
      verification_code: null,
      verification_code_expires_at: null,
      verification_attempts: 0,
      verification_locked_until: null,
    });

    const lang = await getUserLanguage(telegramUser.id);
    await sendMessage(
      chatId,
      msg.boxedHeader(`${emoji.CELEBRATE} Email Verified!`) +
        "\n\n" +
        `${emoji.SUCCESS} <b>Welcome to FoodShare!</b>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.EMAIL} <b>Verified:</b> <code>${email}</code>\n\n` +
        msg.divider("─", 30) +
        "\n\n" +
        `${emoji.ROCKET} <b>Let's get started!</b>\n\n` +
        `Use the menu below to share or find food:`,
      { reply_markup: getMainMenuKeyboard(lang) }
    );

    await setUserState(telegramUser.id, null);
    return true;
  }

  // No active verification state
  await sendMessage(
    chatId,
    msg.errorMessage(
      "No Active Verification",
      "You don't have an active verification process.\n\n" + `${emoji.INFO} Use /start to begin.`
    )
  );
  return false;
}

export async function handleResendCode(telegramUser: TelegramUser, chatId: number): Promise<void> {
  // Check rate limit first
  const rateLimit = checkResendRateLimit(telegramUser.id);
  if (!rateLimit.allowed) {
    await sendMessage(
      chatId,
      msg.errorMessage(
        "Too Many Requests",
        `You've requested too many verification codes.\n\n` +
          `${emoji.CLOCK} Please wait ${rateLimit.remainingMinutes} minutes before trying again.\n\n` +
          `${emoji.INFO} This limit helps prevent spam and protects your account.`
      )
    );
    return;
  }

  const userState = await getUserState(telegramUser.id);

  // Check if we're in a verification flow
  if (
    userState?.action !== "awaiting_verification" &&
    userState?.action !== "awaiting_verification_link"
  ) {
    await sendMessage(
      chatId,
      msg.infoMessage(
        "No Active Verification",
        "You don't have an active verification process.\n\n" + `${emoji.INFO} Use /start to begin.`
      )
    );
    return;
  }

  let email: string | null = null;
  let profileId: string | null = null;

  // Determine which profile to resend to
  if (userState.action === "awaiting_verification_link") {
    // Resending for sign in flow
    profileId = userState.data.existing_profile_id;
    email = userState.data.email;
  } else {
    // Resending for registration flow
    const profile = await getProfileByTelegramId(telegramUser.id);
    if (profile) {
      profileId = profile.id;
      email = profile.email || userState.data.email;
    } else {
      email = userState.data.email;
    }
  }

  if (!email || !profileId) {
    await sendMessage(
      chatId,
      msg.errorMessage("Email Not Found", "Please send your email address first.")
    );
    await setUserState(telegramUser.id, {
      action: "awaiting_email",
      data: {},
    });
    return;
  }

  // Generate new code
  const code = generateVerificationCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await updateProfile(profileId, {
    verification_code: code,
    verification_code_expires_at: expiresAt.toISOString(),
  });

  const emailSent = await sendVerificationEmail(email, code);

  if (emailSent) {
    await sendMessage(
      chatId,
      msg.successMessage(
        "Code Resent!",
        `A new 6-digit verification code has been sent to:\n\n` +
          `${emoji.EMAIL} <code>${email}</code>\n\n` +
          `${emoji.KEY} Please enter the code below.\n\n` +
          `${emoji.CLOCK} Code expires in 15 minutes.`
      )
    );
  } else {
    await sendMessage(
      chatId,
      msg.errorMessage(
        "Email Delivery Failed",
        "We couldn't send the verification email.\n\n" +
          `${emoji.INFO} Please try again in a moment.`
      )
    );
  }
}
