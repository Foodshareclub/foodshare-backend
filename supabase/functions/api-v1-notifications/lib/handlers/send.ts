/**
 * Send Handlers
 *
 * Handlers for POST /send, POST /send/batch, POST /send/template
 *
 * @module api-v1-notifications/handlers/send
 */

import type {
  BatchDeliveryResult,
  BatchSendRequest,
  DeliveryResult,
  NotificationContext,
  SendRequest,
  TemplateSendRequest,
} from "../types.ts";
import { sendNotification } from "../orchestrator.ts";
import { logger } from "../../../_shared/logger.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  batchSendRequestSchema,
  sendRequestSchema,
  templateSendRequestSchema,
} from "../validation.ts";

/**
 * POST /send - Send single notification
 */
export async function handleSend(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: DeliveryResult; error?: string }> {
  try {
    // Validate request
    const request = sendRequestSchema.parse(body) as SendRequest;

    // Send notification
    const result = await sendNotification(request, context);

    return {
      success: result.success,
      data: result,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Validation error", {
        requestId: context.requestId,
        errors: error.errors,
      });
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }

    logger.error("Send handler error", error as Error, {
      requestId: context.requestId,
    });

    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * POST /send/batch - Send batch notifications
 */
export async function handleSendBatch(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: BatchDeliveryResult; error?: string }> {
  const startTime = performance.now();

  try {
    // Validate request
    const request = batchSendRequestSchema.parse(body) as BatchSendRequest;

    logger.info("Processing batch send", {
      requestId: context.requestId,
      count: request.notifications.length,
      parallel: request.options?.parallel,
    });

    const results: DeliveryResult[] = [];

    if (request.options?.parallel) {
      // Send in parallel
      const batchResults = await Promise.all(
        request.notifications.map((notification) =>
          sendNotification(notification, context).catch((error) => ({
            success: false,
            notificationId: crypto.randomUUID(),
            userId: notification.userId,
            channels: [],
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          }))
        ),
      );
      results.push(...batchResults);
    } else {
      // Send sequentially
      for (const notification of request.notifications) {
        try {
          const result = await sendNotification(notification, context);
          results.push(result);

          // Stop on error if requested
          if (request.options?.stopOnError && !result.success) {
            logger.warn("Batch send stopped on error", {
              requestId: context.requestId,
              processed: results.length,
              total: request.notifications.length,
            });
            break;
          }
        } catch (error) {
          const errorResult: DeliveryResult = {
            success: false,
            notificationId: crypto.randomUUID(),
            userId: notification.userId,
            channels: [],
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          };
          results.push(errorResult);

          if (request.options?.stopOnError) {
            break;
          }
        }
      }
    }

    const duration = performance.now() - startTime;

    const batchResult: BatchDeliveryResult = {
      success: true,
      total: request.notifications.length,
      delivered: results.filter((r) => r.success && !r.scheduled).length,
      failed: results.filter((r) => !r.success && !r.blocked).length,
      scheduled: results.filter((r) => r.scheduled).length,
      blocked: results.filter((r) => r.blocked).length,
      results,
      durationMs: Math.round(duration),
    };

    logger.info("Batch send completed", {
      requestId: context.requestId,
      ...batchResult,
    });

    return {
      success: true,
      data: batchResult,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }

    logger.error("Batch send handler error", error as Error, {
      requestId: context.requestId,
    });

    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * POST /send/template - Send notification using template
 */
export async function handleSendTemplate(
  body: unknown,
  context: NotificationContext,
): Promise<{ success: boolean; data?: DeliveryResult; error?: string }> {
  try {
    // Validate request
    const request = templateSendRequestSchema.parse(body) as TemplateSendRequest;

    logger.info("Sending template notification", {
      requestId: context.requestId,
      userId: request.userId,
      template: request.template,
    });

    // TODO: Load template from database or file system
    // For now, create a basic notification from template name
    const notification: SendRequest = {
      userId: request.userId,
      type: "system_announcement",
      title: `Template: ${request.template}`,
      body: `This is a template notification: ${request.template}`,
      channels: request.channels,
      priority: request.priority,
      data: {
        template: request.template,
        ...Object.fromEntries(
          Object.entries(request.variables).map(([k, v]) => [k, String(v)]),
        ),
      },
    };

    const result = await sendNotification(notification, context);

    return {
      success: result.success,
      data: result,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Validation error: ${error.errors.map((e) => e.message).join(", ")}`,
      };
    }

    logger.error("Template send handler error", error as Error, {
      requestId: context.requestId,
    });

    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
