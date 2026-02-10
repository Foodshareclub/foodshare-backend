/**
 * Activity tracking service
 */

import { logger } from "../../_shared/logger.ts";
import { getSupabaseClient } from "../../_shared/supabase.ts";
import type { TelegramMessage } from "../types/index.ts";

export async function trackMessage(message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;

  if (!userId) return;

  const dateStr = new Date(message.date * 1000).toISOString().split("T")[0];

  // Build stats update
  const stats = {
    user_id: userId,
    username: message.from?.username || null,
    first_name: message.from?.first_name || null,
    last_name: message.from?.last_name || null,
    last_message_date: dateStr,
  };

  // Count message
  const textLength = message.text?.length || 0;

  // Extract emojis
  const emojiRegex = /[\p{Emoji_Presentation}\p{Emoji}]/gu;
  const emojis = message.text?.match(emojiRegex) || [];
  const emojiUsage: Record<string, number> = {};
  emojis.forEach((emoji) => {
    emojiUsage[emoji] = (emojiUsage[emoji] || 0) + 1;
  });

  // Extract words
  const words = message.text?.toLowerCase().split(/\s+/) || [];
  const wordUsage: Record<string, number> = {};
  words.forEach((word) => {
    if (word.length > 3) {
      wordUsage[word] = (wordUsage[word] || 0) + 1;
    }
  });

  // Track activity (optional - disabled if function doesn't exist)
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase.rpc("record_activity", {
      p_user_id: userId,
      p_username: stats.username,
      p_first_name: stats.first_name,
      p_last_name: stats.last_name,
      p_date: dateStr,
      p_message_count: 1,
      p_characters: textLength,
      p_media_count: message.photo || message.video ? 1 : 0,
      p_reply_count: message.reply_to_message ? 1 : 0,
      p_emoji_usage: emojiUsage,
      p_word_usage: wordUsage,
    });

    if (error) {
      // Silently fail - activity tracking is optional
      logger.debug("Activity tracking unavailable", { error: error.message });
    }
  } catch (e) {
    // Silently fail - activity tracking is optional
    logger.debug("Activity tracking error", { error: String(e) });
  }
}
