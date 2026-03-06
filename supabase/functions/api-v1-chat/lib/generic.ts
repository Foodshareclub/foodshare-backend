/**
 * Generic Chat Handlers
 *
 * Handlers for generic chat room operations (list, get, create, send message, update, leave).
 * Uses `chat_rooms`, `room_members`, and `messages` tables.
 */

import { uuidSchema, z } from "../../_shared/schemas/common.ts";
import {
  created,
  type HandlerContext,
  noContent,
  ok,
  paginated,
} from "../../_shared/api-handler.ts";
import { AuthorizationError, NotFoundError, ValidationError } from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import { transformMessage, transformRoom, transformRoomDetail } from "./transformers.ts";

// =============================================================================
// Schemas
// =============================================================================

export const createRoomSchema = z.object({
  participantIds: z.array(uuidSchema).min(1).max(50),
  name: z.string().max(100).optional(),
  roomType: z.enum(["direct", "group"]).default("direct"),
});

export const sendMessageSchema = z.object({
  roomId: uuidSchema,
  content: z.string().min(1).max(5000),
  replyToId: uuidSchema.optional(),
  attachments: z.array(z.object({
    type: z.enum(["image", "file", "voice"]),
    url: z.string().url(),
    name: z.string().optional(),
    size: z.number().optional(),
  })).max(5).optional(),
});

export const updateRoomSchema = z.object({
  name: z.string().max(100).optional(),
  isMuted: z.boolean().optional(),
  isPinned: z.boolean().optional(),
});

export type CreateRoomBody = z.infer<typeof createRoomSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type UpdateRoomBody = z.infer<typeof updateRoomSchema>;

// Query type matching listQuerySchema in index.ts
export type ListQuery = {
  roomId?: string;
  action?: "message";
  mode?: "food";
  cursor?: string;
  limit?: string;
  messagesBefore?: string;
};

// =============================================================================
// Handlers
// =============================================================================

/**
 * List user's chat rooms
 */
export async function listRooms(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const cursor = query.cursor;

  // Use optimized RPC for room listing
  const { data, error } = await supabase.rpc("get_user_rooms", {
    p_user_id: userId,
    p_limit: limit + 1,
    p_cursor: cursor || null,
  });

  if (error) {
    logger.error("Failed to list rooms", new Error(error.message));
    throw error;
  }

  const rooms = data || [];
  const hasMore = rooms.length > limit;
  const resultRooms = hasMore ? rooms.slice(0, -1) : rooms;

  return paginated(
    resultRooms.map(transformRoom),
    ctx,
    {
      offset: 0,
      limit,
      total: resultRooms.length,
    },
  );
}

/**
 * Get room with messages
 */
export async function getRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const roomId = query.roomId;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  if (!roomId) {
    throw new ValidationError("Room ID is required");
  }

  // Verify membership
  const { data: membership, error: memberError } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("profile_id", userId)
    .single();

  if (memberError || !membership) {
    throw new AuthorizationError("You are not a member of this room");
  }

  // Get room details
  const { data: room, error: roomError } = await supabase
    .from("chat_rooms")
    .select(`
      *,
      members:room_members(
        profile:profiles(id, display_name, avatar_url)
      )
    `)
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new NotFoundError("Room", roomId);
  }

  // Get messages with pagination
  const messagesBefore = query.messagesBefore;
  const messageLimit = Math.min(parseInt(query.limit || "50"), 100);

  let messagesQuery = supabase
    .from("messages")
    .select(`
      *,
      sender:profiles!messages_profile_id_fkey(id, display_name, avatar_url),
      reply_to:messages!messages_reply_to_id_fkey(id, content, profile_id)
    `)
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(messageLimit + 1);

  if (messagesBefore) {
    messagesQuery = messagesQuery.lt("created_at", messagesBefore);
  }

  const { data: messages, error: messagesError } = await messagesQuery;

  if (messagesError) {
    logger.error("Failed to fetch messages", new Error(messagesError.message));
    throw messagesError;
  }

  const hasMoreMessages = (messages?.length || 0) > messageLimit;
  const resultMessages = hasMoreMessages ? messages?.slice(0, -1) : messages;

  // Mark as read
  await supabase
    .from("room_members")
    .update({ last_read_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("profile_id", userId);

  return ok({
    room: transformRoomDetail(room),
    messages: (resultMessages || []).map(transformMessage).reverse(),
    hasMoreMessages,
    oldestMessageDate: resultMessages?.length
      ? resultMessages[resultMessages.length - 1].created_at
      : null,
  }, ctx);
}

/**
 * Create room using transactional RPC
 */
export async function createRoom(ctx: HandlerContext<CreateRoomBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Use transactional RPC for atomic room creation
  const { data, error } = await supabase.rpc("create_chat_room_safe", {
    p_participant_ids: body.participantIds,
    p_name: body.name || null,
    p_room_type: body.roomType,
  });

  if (error) {
    logger.error("Failed to create room", new Error(error.message));
    throw error;
  }

  const result = data as { room_id: string; created: boolean; message: string };

  logger.info("Room created/found", {
    roomId: result.room_id,
    created: result.created,
    userId,
  });

  // Fetch full room details
  const { data: room, error: fetchError } = await supabase
    .from("chat_rooms")
    .select(`
      *,
      members:room_members(
        profile:profiles(id, display_name, avatar_url)
      )
    `)
    .eq("id", result.room_id)
    .single();

  if (fetchError) {
    // Room was created but fetch failed - return basic info
    return created({
      roomId: result.room_id,
      created: result.created,
    }, ctx);
  }

  return created({
    ...transformRoomDetail(room),
    created: result.created,
  }, ctx);
}

/**
 * Send message
 */
export async function sendMessage(ctx: HandlerContext<SendMessageBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Verify membership
  const { data: membership, error: memberError } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("room_id", body.roomId)
    .eq("profile_id", userId)
    .single();

  if (memberError || !membership) {
    throw new AuthorizationError("You are not a member of this room");
  }

  // Insert message
  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      room_id: body.roomId,
      profile_id: userId,
      content: body.content,
      reply_to_id: body.replyToId,
      attachments: body.attachments,
    })
    .select(`
      *,
      sender:profiles!messages_profile_id_fkey(id, display_name, avatar_url)
    `)
    .single();

  if (error) {
    logger.error("Failed to send message", new Error(error.message));
    throw error;
  }

  // Update room's last message timestamp
  await supabase
    .from("chat_rooms")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", body.roomId);

  logger.info("Message sent", {
    messageId: message.id,
    roomId: body.roomId,
    userId,
  });

  return created(transformMessage(message), ctx);
}

/**
 * Update room settings
 */
export async function updateRoom(
  ctx: HandlerContext<UpdateRoomBody, ListQuery>,
): Promise<Response> {
  const { supabase, userId, body, query } = ctx;
  const roomId = query.roomId;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  if (!roomId) {
    throw new ValidationError("Room ID is required");
  }

  // Verify membership
  const { data: membership, error: memberError } = await supabase
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("profile_id", userId)
    .single();

  if (memberError || !membership) {
    throw new AuthorizationError("You are not a member of this room");
  }

  // Update room name (if owner/admin) or member settings
  if (body.name !== undefined) {
    // Check if user is room creator
    const { data: room } = await supabase
      .from("chat_rooms")
      .select("created_by")
      .eq("id", roomId)
      .single();

    if (room?.created_by === userId) {
      await supabase
        .from("chat_rooms")
        .update({ name: body.name })
        .eq("id", roomId);
    }
  }

  // Update member-specific settings
  if (body.isMuted !== undefined || body.isPinned !== undefined) {
    const memberUpdates: Record<string, unknown> = {};
    if (body.isMuted !== undefined) memberUpdates.is_muted = body.isMuted;
    if (body.isPinned !== undefined) memberUpdates.is_pinned = body.isPinned;

    await supabase
      .from("room_members")
      .update(memberUpdates)
      .eq("room_id", roomId)
      .eq("profile_id", userId);
  }

  return ok({ success: true }, ctx);
}

/**
 * Leave room
 */
export async function leaveRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const roomId = query.roomId;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  if (!roomId) {
    throw new ValidationError("Room ID is required");
  }

  // Remove from room
  const { error } = await supabase
    .from("room_members")
    .delete()
    .eq("room_id", roomId)
    .eq("profile_id", userId);

  if (error) {
    logger.error("Failed to leave room", new Error(error.message));
    throw error;
  }

  // Log activity
  await supabase
    .from("room_activities")
    .insert({
      room_id: roomId,
      profile_id: userId,
      activity_type: "left",
    });

  logger.info("User left room", { roomId, userId });

  return noContent(ctx);
}
