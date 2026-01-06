/**
 * Batch Notification Sender
 *
 * Handles efficient batch sending of notifications with rate limiting,
 * retry logic, and parallel processing.
 */

import { NotificationPayload, DeliveryResult, PriorityLevel } from "./index.ts";
import { routeNotification, UserDevice } from "./delivery-router.ts";
import { calculatePriority } from "./priority-calculator.ts";

// Batch configuration
interface BatchConfig {
  maxConcurrent: number; // Max concurrent sends
  batchSize: number; // Notifications per batch
  retryAttempts: number; // Retry failed sends
  retryDelayMs: number; // Initial retry delay
  priorityQueues: boolean; // Process high priority first
}

const DEFAULT_CONFIG: BatchConfig = {
  maxConcurrent: 50,
  batchSize: 100,
  retryAttempts: 3,
  retryDelayMs: 1000,
  priorityQueues: true,
};

// Batch result
interface BatchResult {
  total: number;
  successful: number;
  failed: number;
  retried: number;
  results: DeliveryResult[];
  processingTimeMs: number;
}

/**
 * Batch notification sender with priority queuing and retry logic.
 */
export class BatchSender {
  private config: BatchConfig;
  private activeCount: number = 0;
  private queue: Array<{
    notification: NotificationPayload & { priority: PriorityLevel };
    resolve: (result: DeliveryResult) => void;
    retryCount: number;
  }> = [];

  constructor(config: Partial<BatchConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Send a batch of notifications.
   */
  async sendBatch(
    notifications: NotificationPayload[],
    supabase: any
  ): Promise<DeliveryResult[]> {
    const startTime = Date.now();
    const results: DeliveryResult[] = [];

    // Add priority to each notification
    const prioritizedNotifications = await this.prioritizeNotifications(
      notifications,
      supabase
    );

    // Sort by priority if enabled
    if (this.config.priorityQueues) {
      this.sortByPriority(prioritizedNotifications);
    }

    // Process in batches
    const batches = this.chunkArray(prioritizedNotifications, this.config.batchSize);

    for (const batch of batches) {
      const batchResults = await this.processBatch(batch, supabase);
      results.push(...batchResults);
    }

    // Log batch metrics
    const processingTimeMs = Date.now() - startTime;
    console.log(`Batch complete: ${results.length} notifications in ${processingTimeMs}ms`);

    return results;
  }

  /**
   * Add priority to notifications.
   */
  private async prioritizeNotifications(
    notifications: NotificationPayload[],
    supabase: any
  ): Promise<Array<NotificationPayload & { priority: PriorityLevel }>> {
    // Get all user IDs
    const userIds = [...new Set(notifications.map((n) => n.userId))];

    // Fetch preferences in bulk
    const { data: preferences } = await supabase
      .from("notification_preferences")
      .select("*")
      .in("user_id", userIds);

    const prefsMap = new Map(preferences?.map((p: any) => [p.user_id, p]) ?? []);

    // Add priority to each notification
    return notifications.map((notification) => {
      const userPrefs = prefsMap.get(notification.userId) ?? {};
      const priority = notification.priority ?? calculatePriority(notification, userPrefs);
      return { ...notification, priority };
    });
  }

  /**
   * Sort notifications by priority (highest first).
   */
  private sortByPriority(
    notifications: Array<NotificationPayload & { priority: PriorityLevel }>
  ): void {
    const priorityOrder: Record<PriorityLevel, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    notifications.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  /**
   * Process a single batch with concurrency control.
   */
  private async processBatch(
    batch: Array<NotificationPayload & { priority: PriorityLevel }>,
    supabase: any
  ): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = [];
    const pending: Promise<void>[] = [];

    for (const notification of batch) {
      // Wait if at max concurrency
      while (this.activeCount >= this.config.maxConcurrent) {
        await Promise.race(pending);
      }

      // Start sending
      this.activeCount++;
      const promise = this.sendWithRetry(notification, supabase)
        .then((result) => {
          results.push(result);
        })
        .finally(() => {
          this.activeCount--;
        });

      pending.push(promise);
    }

    // Wait for all to complete
    await Promise.allSettled(pending);

    return results;
  }

  /**
   * Send a single notification with retry logic.
   */
  private async sendWithRetry(
    notification: NotificationPayload & { priority: PriorityLevel },
    supabase: any,
    attempt: number = 0
  ): Promise<DeliveryResult> {
    try {
      // Get user devices and preferences
      const [devices, preferences] = await Promise.all([
        this.getUserDevices(supabase, notification.userId),
        this.getUserPreferences(supabase, notification.userId),
      ]);

      // Check if notification should be sent
      if (!this.shouldSendNotification(notification, preferences)) {
        return {
          success: false,
          notificationId: notification.id ?? crypto.randomUUID(),
          deliveredTo: [],
          failedDevices: [],
          error: "blocked_by_preferences",
        };
      }

      // Route to delivery channels
      const result = await routeNotification(notification, devices, preferences);

      // Retry if all failed and attempts remain
      if (!result.success && attempt < this.config.retryAttempts) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await this.delay(delay);
        return this.sendWithRetry(notification, supabase, attempt + 1);
      }

      return result;
    } catch (error) {
      // Retry on error
      if (attempt < this.config.retryAttempts) {
        const delay = this.config.retryDelayMs * Math.pow(2, attempt);
        await this.delay(delay);
        return this.sendWithRetry(notification, supabase, attempt + 1);
      }

      return {
        success: false,
        notificationId: notification.id ?? crypto.randomUUID(),
        deliveredTo: [],
        failedDevices: [],
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get user devices from database.
   */
  private async getUserDevices(supabase: any, userId: string): Promise<UserDevice[]> {
    const { data } = await supabase
      .from("user_devices")
      .select("*")
      .eq("user_id", userId)
      .eq("is_active", true);

    return data ?? [];
  }

  /**
   * Get user notification preferences.
   */
  private async getUserPreferences(supabase: any, userId: string): Promise<any> {
    const { data } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", userId)
      .single();

    return data ?? this.getDefaultPreferences();
  }

  /**
   * Get default notification preferences.
   */
  private getDefaultPreferences(): any {
    return {
      push_enabled: true,
      email_enabled: true,
      quiet_hours_enabled: false,
      enabled_types: [
        "new_message",
        "arrangement_confirmed",
        "arrangement_cancelled",
        "challenge_complete",
        "review_received",
        "account_security",
      ],
    };
  }

  /**
   * Check if notification should be sent based on preferences.
   */
  private shouldSendNotification(
    notification: NotificationPayload & { priority: PriorityLevel },
    preferences: any
  ): boolean {
    // Always send critical notifications
    if (notification.priority === "critical") return true;

    // Check if push is enabled
    if (!preferences.push_enabled) return false;

    // Check if notification type is enabled
    if (
      preferences.enabled_types &&
      !preferences.enabled_types.includes(notification.type)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Chunk array into smaller arrays.
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Send notifications to a topic (broadcast).
 */
export async function sendToTopic(
  topic: string,
  notification: Omit<NotificationPayload, "userId">,
  supabase: any
): Promise<{ sent: boolean; error?: string }> {
  const fcmServerKey = Deno.env.get("FCM_SERVER_KEY");
  if (!fcmServerKey) {
    return { sent: false, error: "FCM not configured" };
  }

  try {
    const response = await fetch(
      "https://fcm.googleapis.com/fcm/send",
      {
        method: "POST",
        headers: {
          Authorization: `key=${fcmServerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: `/topics/${topic}`,
          notification: {
            title: notification.title,
            body: notification.body,
            image: notification.imageUrl,
          },
          data: {
            type: notification.type,
            ...(notification.data ?? {}),
          },
        }),
      }
    );

    if (response.ok) {
      return { sent: true };
    } else {
      const error = await response.text();
      return { sent: false, error };
    }
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send notification to multiple users by condition.
 */
export async function sendToCondition(
  condition: string, // e.g., "'TopicA' in topics && ('TopicB' in topics || 'TopicC' in topics)"
  notification: Omit<NotificationPayload, "userId">,
  supabase: any
): Promise<{ sent: boolean; error?: string }> {
  const fcmServerKey = Deno.env.get("FCM_SERVER_KEY");
  if (!fcmServerKey) {
    return { sent: false, error: "FCM not configured" };
  }

  try {
    const response = await fetch(
      "https://fcm.googleapis.com/fcm/send",
      {
        method: "POST",
        headers: {
          Authorization: `key=${fcmServerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          condition,
          notification: {
            title: notification.title,
            body: notification.body,
            image: notification.imageUrl,
          },
          data: {
            type: notification.type,
            ...(notification.data ?? {}),
          },
        }),
      }
    );

    if (response.ok) {
      return { sent: true };
    } else {
      const error = await response.text();
      return { sent: false, error };
    }
  } catch (error) {
    return {
      sent: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Subscribe user to topic.
 */
export async function subscribeToTopic(
  topic: string,
  tokens: string[]
): Promise<{ success: boolean; error?: string }> {
  const fcmServerKey = Deno.env.get("FCM_SERVER_KEY");
  if (!fcmServerKey) {
    return { success: false, error: "FCM not configured" };
  }

  try {
    const response = await fetch(
      `https://iid.googleapis.com/iid/v1:batchAdd`,
      {
        method: "POST",
        headers: {
          Authorization: `key=${fcmServerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: `/topics/${topic}`,
          registration_tokens: tokens,
        }),
      }
    );

    if (response.ok) {
      return { success: true };
    } else {
      const error = await response.text();
      return { success: false, error };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Unsubscribe user from topic.
 */
export async function unsubscribeFromTopic(
  topic: string,
  tokens: string[]
): Promise<{ success: boolean; error?: string }> {
  const fcmServerKey = Deno.env.get("FCM_SERVER_KEY");
  if (!fcmServerKey) {
    return { success: false, error: "FCM not configured" };
  }

  try {
    const response = await fetch(
      `https://iid.googleapis.com/iid/v1:batchRemove`,
      {
        method: "POST",
        headers: {
          Authorization: `key=${fcmServerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: `/topics/${topic}`,
          registration_tokens: tokens,
        }),
      }
    );

    if (response.ok) {
      return { success: true };
    } else {
      const error = await response.text();
      return { success: false, error };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export { BatchConfig, BatchResult };
