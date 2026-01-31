/**
 * Chat API v1
 *
 * Unified REST API for chat/messaging operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-chat                   - List user's chat rooms
 * - GET    /api-v1-chat?roomId=<id>       - Get room with messages
 * - POST   /api-v1-chat                   - Create room (uses transactional RPC)
 * - POST   /api-v1-chat?action=message    - Send message
 * - PUT    /api-v1-chat?roomId=<id>       - Update room (name, settings)
 * - DELETE /api-v1-chat?roomId=<id>       - Leave room
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 * - X-Idempotency-Key: <uuid> (for message sending)
 *
 * @module api-v1-chat
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  createAPIHandler,
  ok,
  created,
  noContent,
  paginated,
  type HandlerContext,
} from "../_shared/api-handler.ts";
import { NotFoundError, ValidationError, AuthorizationError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

// =============================================================================
// Schemas
// =============================================================================

const createRoomSchema = z.object({
  participantIds: z.array(z.string().uuid()).min(1).max(50),
  name: z.string().max(100).optional(),
  roomType: z.enum(["direct", "group"]).default("direct"),
});

const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().min(1).max(5000),
  replyToId: z.string().uuid().optional(),
  attachments: z.array(z.object({
    type: z.enum(["image", "file", "voice"]),
    url: z.string().url(),
    name: z.string().optional(),
    size: z.number().optional(),
  })).max(5).optional(),
});

const updateRoomSchema = z.object({
  name: z.string().max(100).optional(),
  isMuted: z.boolean().optional(),
  isPinned: z.boolean().optional(),
});

const listQuerySchema = z.object({
  roomId: z.string().uuid().optional(),
  action: z.enum(["message"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
  messagesBefore: z.string().optional(),
});

type CreateRoomBody = z.infer<typeof createRoomSchema>;
type SendMessageBody = z.infer<typeof sendMessageSchema>;
type UpdateRoomBody = z.infer<typeof updateRoomSchema>;
type ListQuery = z.infer<typeof listQuerySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * List user's chat rooms
 */
async function listRooms(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
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
    }
  );
}

/**
 * Get room with messages
 */
async function getRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
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
async function createRoom(ctx: HandlerContext<CreateRoomBody>): Promise<Response> {
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
async function sendMessage(ctx: HandlerContext<SendMessageBody>): Promise<Response> {
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
async function updateRoom(ctx: HandlerContext<UpdateRoomBody, ListQuery>): Promise<Response> {
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
async function leaveRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
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

// =============================================================================
// Transformers
// =============================================================================

function transformRoom(data: Record<string, unknown>) {
  return {
    id: data.room_id || data.id,
    name: data.room_name || data.name,
    roomType: data.room_type,
    lastMessage: data.last_message_content
      ? {
          content: data.last_message_content,
          senderId: data.last_message_sender_id,
          senderName: data.last_message_sender_name,
          sentAt: data.last_message_at,
        }
      : null,
    unreadCount: data.unread_count || 0,
    isMuted: data.is_muted || false,
    isPinned: data.is_pinned || false,
    participants: data.participant_count || data.participants || 0,
    avatarUrl: data.avatar_url,
    updatedAt: data.last_message_at || data.updated_at,
  };
}

function transformRoomDetail(data: Record<string, unknown>) {
  const members = data.members as Array<{ profile: Record<string, unknown> }> | null;

  return {
    id: data.id,
    name: data.name,
    roomType: data.room_type,
    createdBy: data.created_by,
    createdAt: data.created_at,
    members: members?.map((m) => ({
      id: m.profile?.id,
      displayName: m.profile?.display_name,
      avatarUrl: m.profile?.avatar_url,
    })) || [],
  };
}

function transformMessage(data: Record<string, unknown>) {
  const sender = data.sender as Record<string, unknown> | null;
  const replyTo = data.reply_to as Record<string, unknown> | null;

  return {
    id: data.id,
    content: data.content,
    attachments: data.attachments,
    sender: sender
      ? {
          id: sender.id,
          displayName: sender.display_name,
          avatarUrl: sender.avatar_url,
        }
      : null,
    replyTo: replyTo
      ? {
          id: replyTo.id,
          content: replyTo.content,
          senderId: replyTo.profile_id,
        }
      : null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    isEdited: data.is_edited || false,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  if (ctx.query.roomId) {
    return getRoom(ctx);
  }
  return listRooms(ctx);
}

async function handlePost(ctx: HandlerContext<CreateRoomBody | SendMessageBody, ListQuery>): Promise<Response> {
  if (ctx.query.action === "message") {
    return sendMessage(ctx as HandlerContext<SendMessageBody, ListQuery>);
  }
  return createRoom(ctx as HandlerContext<CreateRoomBody, ListQuery>);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-chat",
  version: "2.0.0",
  requireAuth: true, // All chat operations require auth
  rateLimit: {
    limit: 60,
    windowMs: 60000, // 60 requests per minute
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: listQuerySchema,
      handler: handleGet,
    },
    POST: {
      // Schema determined by action param
      handler: handlePost,
      idempotent: true,
    },
    PUT: {
      schema: updateRoomSchema,
      querySchema: listQuerySchema,
      handler: updateRoom,
    },
    DELETE: {
      querySchema: listQuerySchema,
      handler: leaveRoom,
    },
  },
});
