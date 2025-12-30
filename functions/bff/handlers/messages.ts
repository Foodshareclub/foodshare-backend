/**
 * BFF Messages Handler
 *
 * Aggregates messaging data for cross-platform clients:
 * - User's chat rooms with last message preview
 * - Unread counts per room
 * - Participant profiles (prefetched)
 *
 * Reduces client round-trips from 3-4 calls to 1.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createAPIHandler, ok, type HandlerContext } from "../../_shared/api-handler.ts";
import { logger } from "../../_shared/logger.ts";
import { transformForPlatform, type Platform } from "../transforms/platform.ts";

// =============================================================================
// Request Schema
// =============================================================================

const messagesQuerySchema = z.object({
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  cursor: z.string().optional(),
  includeArchived: z.string().transform((v) => v === "true").optional(),
});

type MessagesQuery = z.infer<typeof messagesQuerySchema>;

// =============================================================================
// Response Types
// =============================================================================

interface Participant {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean;
}

interface LastMessage {
  id: string;
  content: string;
  senderId: string;
  senderName: string;
  sentAt: string;
  isRead: boolean;
}

interface ChatRoom {
  id: string;
  name: string | null;
  roomType: "direct" | "group";
  participants: Participant[];
  lastMessage: LastMessage | null;
  unreadCount: number;
  isMuted: boolean;
  isPinned: boolean;
  updatedAt: string;
}

interface MessagesResponse {
  rooms: ChatRoom[];
  totalUnread: number;
  hasMore: boolean;
  nextCursor: string | null;
}

// =============================================================================
// Handler Implementation
// =============================================================================

async function handleGetMessages(ctx: HandlerContext<unknown, MessagesQuery>): Promise<Response> {
  const { supabase, userId, query, ctx: requestCtx } = ctx;

  const limit = query.limit ?? 20;
  const cursor = query.cursor || null;
  const includeArchived = query.includeArchived ?? false;

  // Get platform from context
  const platform = (requestCtx?.platform || "unknown") as Platform;

  // Call aggregated RPC that returns all messages data
  const { data, error } = await supabase.rpc("get_bff_messages_data", {
    p_user_id: userId,
    p_limit: limit + 1, // +1 for pagination check
    p_cursor: cursor,
    p_include_archived: includeArchived,
  });

  if (error) {
    logger.error("Failed to fetch messages data", new Error(error.message));
    throw new Error("Failed to fetch messages");
  }

  // Parse RPC result
  const result = typeof data === "string" ? JSON.parse(data) : data;

  // Check if there are more results
  const rooms = result.rooms || [];
  const hasMore = rooms.length > limit;
  const resultRooms = hasMore ? rooms.slice(0, -1) : rooms;

  // Transform to response format
  const messagesResponse: MessagesResponse = {
    rooms: resultRooms.map((room: Record<string, unknown>) => ({
      id: room.room_id || room.id,
      name: room.room_name || room.name,
      roomType: room.room_type || "direct",
      participants: (room.participants as Array<Record<string, unknown>> || []).map((p) => ({
        id: p.id,
        displayName: p.display_name,
        avatarUrl: p.avatar_url,
        isOnline: p.is_online || false,
      })),
      lastMessage: room.last_message_content
        ? {
            id: room.last_message_id,
            content: room.last_message_content,
            senderId: room.last_message_sender_id,
            senderName: room.last_message_sender_name,
            sentAt: room.last_message_at,
            isRead: room.last_message_read || false,
          }
        : null,
      unreadCount: room.unread_count || 0,
      isMuted: room.is_muted || false,
      isPinned: room.is_pinned || false,
      updatedAt: room.updated_at || room.last_message_at,
    })),
    totalUnread: result.total_unread || 0,
    hasMore,
    nextCursor: hasMore && resultRooms.length > 0
      ? resultRooms[resultRooms.length - 1].updated_at
      : null,
  };

  // Apply platform-specific transforms
  const platformResponse = transformForPlatform(messagesResponse, platform);

  logger.info("Messages fetched", {
    userId,
    platform,
    roomCount: resultRooms.length,
    totalUnread: messagesResponse.totalUnread,
  });

  return ok(platformResponse, ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "bff-messages",
  version: "1.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: messagesQuerySchema,
      handler: handleGetMessages,
    },
  },
});
