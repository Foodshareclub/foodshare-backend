/**
 * WhatsApp Cloud API client with circuit breaker
 */

import { logger } from "../../_shared/logger.ts";
import { WHATSAPP_API_URL, WHATSAPP_ACCESS_TOKEN } from "../config/index.ts";
import { WHATSAPP_API_TIMEOUT_MS, MAX_RETRIES, RETRY_DELAY_MS } from "../config/constants.ts";
import { withCircuitBreaker, getCircuitStatus } from "../../_shared/circuit-breaker.ts";
import type {
  TextMessage,
  ImageMessage,
  LocationMessage,
  InteractiveMessage,
  InteractiveButton,
  InteractiveListSection,
} from "../types/index.ts";

const SERVICE_NAME = "whatsapp-api";

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = WHATSAPP_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make authenticated API request to WhatsApp
 */
async function makeRequest<T>(
  endpoint: string,
  body: unknown,
  method = "POST"
): Promise<{ success: boolean; data?: T; error?: string }> {
  const url = `${WHATSAPP_API_URL}${endpoint}`;

  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMessage = data?.error?.message || `HTTP ${response.status}`;
      logger.error("WhatsApp API error", { endpoint, status: response.status, error: errorMessage });
      return { success: false, error: errorMessage };
    }

    return { success: true, data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("WhatsApp API request failed", { endpoint, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Send with circuit breaker and retry
 */
async function sendWithRetry<T>(
  endpoint: string,
  body: unknown,
  retries = MAX_RETRIES
): Promise<{ success: boolean; data?: T; error?: string }> {
  return withCircuitBreaker(
    SERVICE_NAME,
    async () => {
      let lastError = "";

      for (let attempt = 1; attempt <= retries; attempt++) {
        const result = await makeRequest<T>(endpoint, body);

        if (result.success) {
          return result;
        }

        lastError = result.error || "Unknown error";

        // Don't retry on client errors (4xx)
        if (lastError.includes("400") || lastError.includes("401") || lastError.includes("403")) {
          return result;
        }

        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
      }

      return { success: false, error: lastError };
    },
    { failureThreshold: 5, resetTimeoutMs: 60000 }
  );
}

// ============================================================================
// Message Sending Functions
// ============================================================================

/**
 * Send a text message
 */
export async function sendTextMessage(to: string, text: string): Promise<boolean> {
  const message: TextMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: {
      preview_url: true,
      body: text,
    },
  };

  const result = await sendWithRetry("/messages", message);
  return result.success;
}

/**
 * Send an image message
 */
export async function sendImageMessage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<boolean> {
  const message: ImageMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: {
      link: imageUrl,
      caption,
    },
  };

  const result = await sendWithRetry("/messages", message);
  return result.success;
}

/**
 * Send a location message
 */
export async function sendLocationMessage(
  to: string,
  latitude: number,
  longitude: number,
  name?: string,
  address?: string
): Promise<boolean> {
  const message: LocationMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "location",
    location: {
      latitude,
      longitude,
      name,
      address,
    },
  };

  const result = await sendWithRetry("/messages", message);
  return result.success;
}

/**
 * Send interactive buttons message (max 3 buttons)
 */
export async function sendButtonMessage(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  headerText?: string,
  footerText?: string
): Promise<boolean> {
  // Validate and truncate button titles (max 20 chars)
  const formattedButtons: InteractiveButton[] = buttons.slice(0, 3).map((btn) => ({
    type: "reply" as const,
    reply: {
      id: btn.id,
      title: btn.title.substring(0, 20),
    },
  }));

  const message: InteractiveMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: { buttons: formattedButtons },
    },
  };

  if (headerText) {
    message.interactive.header = { type: "text", text: headerText };
  }

  if (footerText) {
    message.interactive.footer = { text: footerText.substring(0, 60) };
  }

  const result = await sendWithRetry("/messages", message);
  return result.success;
}

/**
 * Send interactive list message
 */
export async function sendListMessage(
  to: string,
  bodyText: string,
  buttonText: string,
  sections: InteractiveListSection[],
  headerText?: string,
  footerText?: string
): Promise<boolean> {
  const message: InteractiveMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText.substring(0, 20),
        sections: sections.slice(0, 10),
      },
    },
  };

  if (headerText) {
    message.interactive.header = { type: "text", text: headerText };
  }

  if (footerText) {
    message.interactive.footer = { text: footerText.substring(0, 60) };
  }

  const result = await sendWithRetry("/messages", message);
  return result.success;
}

/**
 * Mark a message as read
 */
export async function markAsRead(messageId: string): Promise<boolean> {
  const result = await sendWithRetry("/messages", {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });

  return result.success;
}

/**
 * Get media URL from media ID
 */
export async function getMediaUrl(mediaId: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(`https://graph.facebook.com/v21.0/${mediaId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.url || null;
  } catch (error) {
    logger.error("Failed to get media URL", { error: String(error), mediaId });
    return null;
  }
}

/**
 * Download media from WhatsApp
 */
export async function downloadMedia(mediaUrl: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetchWithTimeout(
      mediaUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        },
      },
      30000 // 30 second timeout for downloads
    );

    if (!response.ok) {
      return null;
    }

    return response.arrayBuffer();
  } catch (error) {
    logger.error("Failed to download media", { error: String(error) });
    return null;
  }
}

/**
 * Get API status for health checks
 */
export function getWhatsAppApiStatus(): { status: string; failures: number } {
  const circuit = getCircuitStatus(SERVICE_NAME);
  return {
    status: circuit?.state || "CLOSED",
    failures: circuit?.failures || 0,
  };
}
