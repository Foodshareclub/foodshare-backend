/**
 * Type definitions for Telegram Bot
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message: TelegramMessage;
  data: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  thumb?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  location?: { latitude: number; longitude: number };
  caption?: string;
  reply_to_message?: TelegramMessage;
  new_chat_members?: TelegramUser[];
  entities?: TelegramMessageEntity[];
}

export interface TelegramMessageEntity {
  type: string; // "mention", "bot_command", "text_mention", etc.
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface UserStats {
  user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  message_count: number;
  first_message_date: string;
  last_message_date: string;
  total_characters: number;
  media_count: number;
  reply_count: number;
  active_days: string[];
  emoji_usage: Record<string, number>;
  most_used_words: Record<string, number>;
}

export interface Profile {
  id: string;
  telegram_id: number | null;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  nickname: string | null;
  location: string | null; // PostGIS geography point
  verification_code: string | null;
  verification_code_expires_at: string | null;
  search_radius_km?: number;
  created_time?: string;
}

export interface UserStateData {
  email?: string;
  profile_id?: string;
  existing_profile_id?: string;
  next_action?: string;
  photo?: string;
  description?: string;
  caption?: string;
  language?: string;
  [key: string]: string | undefined;
}

export interface UserState {
  action: string;
  data: UserStateData;
  step?: string;
  language?: string;
}

export interface ImpactStats {
  foodsShared: number;
  foodsClaimed: number;
  kgSaved: number;
  co2Saved: number;
  moneySaved: number;
  memberSince: string;
  activeDays: number;
}
