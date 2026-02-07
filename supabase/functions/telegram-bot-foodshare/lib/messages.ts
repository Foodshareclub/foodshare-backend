/**
 * Message Template Utilities for FoodShare Telegram Bot
 * Provides consistent, beautiful message formatting
 */

import * as emoji from "./emojis.ts";

/**
 * Calculate the display width of a string, accounting for emojis and Unicode
 * Emojis display as ~2 characters wide in monospace fonts
 * Regular characters (including Cyrillic) are 1 character wide
 */
function getDisplayWidth(str: string): number {
  let width = 0;

  // Use Unicode segmenter to properly handle grapheme clusters (emojis, combining characters)
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = Array.from(segmenter.segment(str));

  for (const segment of segments) {
    const char = segment.segment;
    const codePoint = char.codePointAt(0) || 0;

    // Check if it's an emoji or special symbol
    // Emojis are typically in these ranges:
    // - Emoticons: U+1F600 to U+1F64F
    // - Misc Symbols and Pictographs: U+1F300 to U+1F5FF
    // - Transport and Map: U+1F680 to U+1F6FF
    // - Misc Symbols: U+2600 to U+26FF
    // - Dingbats: U+2700 to U+27BF
    // - Various supplement blocks
    const isEmoji =
      (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) || // Various emoji blocks
      (codePoint >= 0x2600 && codePoint <= 0x26ff) || // Misc symbols
      (codePoint >= 0x2700 && codePoint <= 0x27bf) || // Dingbats
      (codePoint >= 0x1fa00 && codePoint <= 0x1faff) || // Extended-A
      char.length > 2 || // Multi-codepoint emojis (ZWJ sequences, flags)
      /\p{Emoji_Presentation}/u.test(char); // Unicode emoji property

    if (isEmoji) {
      width += 2; // Emojis display as 2 characters wide
    } else {
      width += 1; // Regular characters
    }
  }

  return width;
}

/**
 * Create a boxed header with proper width calculation
 */
export function boxedHeader(title: string): string {
  const displayWidth = getDisplayWidth(title);
  const line = "━".repeat(displayWidth + 4);
  return `┏${line}┓\n┃  ${title}  ┃\n┗${line}┛`;
}

/**
 * Create a simple divider
 */
export function divider(char: string = "─", length: number = 20): string {
  return char.repeat(length);
}

/**
 * Create a progress bar
 */
export function progressBar(current: number, total: number, width: number = 10): string {
  const filled = Math.floor((current / total) * width);
  const empty = width - filled;
  return "🔵".repeat(filled) + "🔘".repeat(empty);
}

/**
 * Create step indicator
 */
export function stepIndicator(current: number, total: number): string {
  const percentage = Math.floor((current / total) * 100);
  const bar = progressBar(current, total);
  return `Step ${current}/${total}\n${bar} ${percentage}%`;
}

/**
 * Format a success message
 */
export function successMessage(title: string, message: string, details?: string[]): string {
  let msg = `${emoji.SUCCESS} <b>${title}</b>\n\n${message}`;

  if (details && details.length > 0) {
    msg += "\n\n";
    msg += details.map((d) => `${emoji.CHECK_FILLED} ${d}`).join("\n");
  }

  return msg;
}

/**
 * Format an error message
 */
export function errorMessage(title: string, message: string, suggestion?: string): string {
  let msg = `${emoji.ERROR} <b>${title}</b>\n\n${message}`;

  if (suggestion) {
    msg += `\n\n${emoji.LIGHT_BULB} <i>${suggestion}</i>`;
  }

  return msg;
}

/**
 * Format an info message
 */
export function infoMessage(title: string, message: string): string {
  return `${emoji.INFO} <b>${title}</b>\n\n${message}`;
}

/**
 * Format a warning message
 */
export function warningMessage(title: string, message: string): string {
  return `${emoji.WARNING} <b>${title}</b>\n\n${message}`;
}

/**
 * Format a celebration message
 */
export function celebrationMessage(title: string, message: string): string {
  return `${emoji.CELEBRATE} <b>${title}</b>\n\n${message}\n\n${emoji.SPARKLES}`;
}

/**
 * Pad a string to a target display width, accounting for emojis
 */
function padEndDisplay(str: string, targetWidth: number): string {
  const currentWidth = getDisplayWidth(str);
  const padding = Math.max(0, targetWidth - currentWidth);
  return str + " ".repeat(padding);
}

/**
 * Create a card layout with proper width calculation
 */
export function card(header: string, content: string[], footer?: string): string {
  const width = 24;
  const topLine = "┏" + "━".repeat(width) + "┓";
  const midLine = "┣" + "━".repeat(width) + "┫";
  const botLine = "┗" + "━".repeat(width) + "┛";
  const emptyLine = "┃" + " ".repeat(width) + "┃";

  let msg = topLine + "\n";
  msg += `┃  ${padEndDisplay(header, width - 2)}┃\n`;
  msg += midLine + "\n";
  msg += emptyLine + "\n";

  content.forEach((line) => {
    // Handle multi-line content
    const lines = line.split("\n");
    lines.forEach((l) => {
      msg += `┃  ${padEndDisplay(l, width - 2)}┃\n`;
    });
  });

  msg += emptyLine + "\n";

  if (footer) {
    msg += midLine + "\n";
    msg += `┃  ${padEndDisplay(footer, width - 2)}┃\n`;
  }

  msg += botLine;

  return msg;
}

/**
 * Format a list with emojis
 */
export function bulletList(items: Array<{ emoji: string; text: string }>): string {
  return items.map((item) => `${item.emoji} ${item.text}`).join("\n");
}

/**
 * Format a food item card
 */
export function foodCard(food: {
  name: string;
  description?: string;
  address?: string;
  distance?: number;
  urgent?: boolean;
}): string {
  let msg = `${emoji.FOOD} <b>${food.name}</b>\n`;

  if (food.urgent) {
    msg += `${emoji.EXPIRING_SOON} <b>Expiring Soon!</b>\n`;
  }

  msg += `\n`;

  if (food.description) {
    msg += `${emoji.TEXT} ${food.description.substring(0, 100)}${food.description.length > 100 ? "..." : ""}\n`;
  }

  if (food.address) {
    msg += `${emoji.LOCATION} ${food.address}\n`;
  }

  if (food.distance !== undefined) {
    msg += `${emoji.DISTANCE} ${food.distance.toFixed(1)}km away\n`;
  }

  return msg;
}

/**
 * Format impact statistics
 */
export function impactStats(stats: {
  foodShared: number;
  foodClaimed: number;
  kgSaved: number;
  co2Saved: number;
}): string {
  return bulletList([
    { emoji: emoji.FOOD, text: `<b>${stats.foodShared}</b> items shared` },
    { emoji: emoji.RECYCLE, text: `<b>${stats.kgSaved}kg</b> waste prevented` },
    { emoji: emoji.EARTH, text: `<b>${stats.co2Saved}kg</b> CO2 saved` },
  ]);
}

/**
 * Create a welcome banner
 */
export function welcomeBanner(name?: string): string {
  const greeting = name ? `Welcome, ${name}!` : "Welcome to FoodShare!";

  return (
    `${emoji.WAVE} <b>${greeting}</b>\n\n` +
    `${emoji.SPARKLES} Your journey to reduce food waste starts here!\n\n` +
    boxedHeader(`${emoji.FOOD} Share ${emoji.SEARCH} Find ${emoji.EARTH} Save`) +
    "\n"
  );
}
