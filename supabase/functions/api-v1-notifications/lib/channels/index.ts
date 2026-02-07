/**
 * Channel Registry
 *
 * Central registry for all notification channels.
 * Provides unified access to email, push, SMS, and in-app adapters.
 *
 * @module api-v1-notifications/channels
 */

import { EmailChannelAdapter } from "./email.ts";
import { PushChannelAdapter } from "./push.ts";
import { SmsChannelAdapter } from "./sms.ts";
import { InAppChannelAdapter } from "./in-app.ts";
import type { ChannelAdapter, NotificationChannel } from "../types.ts";

// =============================================================================
// Channel Registry
// =============================================================================

const channelAdapters = new Map<NotificationChannel, ChannelAdapter>([
  ["email", new EmailChannelAdapter()],
  ["push", new PushChannelAdapter()],
  ["sms", new SmsChannelAdapter()],
  ["in_app", new InAppChannelAdapter()],
]);

/**
 * Get channel adapter by name
 */
export function getChannelAdapter(channel: NotificationChannel): ChannelAdapter | undefined {
  return channelAdapters.get(channel);
}

/**
 * Get all channel adapters
 */
export function getAllChannelAdapters(): ChannelAdapter[] {
  return Array.from(channelAdapters.values());
}

/**
 * Check if channel is available
 */
export function isChannelAvailable(channel: NotificationChannel): boolean {
  return channelAdapters.has(channel);
}

/**
 * Get health status for all channels
 */
export async function getAllChannelHealth(): Promise<
  Record<
    string,
    {
      healthy: boolean;
      latencyMs?: number;
      error?: string;
    }
  >
> {
  const health: Record<string, { healthy: boolean; latencyMs?: number; error?: string }> = {};

  await Promise.all(
    Array.from(channelAdapters.entries()).map(async ([name, adapter]) => {
      if (adapter.healthCheck) {
        health[name] = await adapter.healthCheck();
      } else {
        health[name] = { healthy: true };
      }
    })
  );

  return health;
}

// Export individual adapters for direct use
export { EmailChannelAdapter, PushChannelAdapter, SmsChannelAdapter, InAppChannelAdapter };
