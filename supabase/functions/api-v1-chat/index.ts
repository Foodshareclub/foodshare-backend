/**
 * Chat API v1
 *
 * Unified REST API for chat/messaging operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Generic chat (default):
 * - GET    /api-v1-chat                        - List user's chat rooms
 * - GET    /api-v1-chat?roomId=<id>            - Get room with messages
 * - POST   /api-v1-chat                        - Create room (uses transactional RPC)
 * - POST   /api-v1-chat?action=message         - Send message
 * - PUT    /api-v1-chat?roomId=<id>            - Update room (name, settings)
 * - DELETE /api-v1-chat?roomId=<id>            - Leave room
 *
 * Food sharing chat (mode=food, consolidates api-v1-food-chat):
 * - GET    /api-v1-chat?mode=food              - List food sharing rooms
 * - GET    /api-v1-chat?mode=food&roomId=<id>  - Get food room with messages
 * - POST   /api-v1-chat?mode=food              - Create food sharing room
 * - POST   /api-v1-chat?mode=food&action=message - Send food chat message
 * - PUT    /api-v1-chat?mode=food&roomId=<id>  - Accept/complete/archive exchange
 * - DELETE /api-v1-chat?mode=food&roomId=<id>  - Archive food room
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
import { NotFoundError, ValidationError, AuthorizationError, ConflictError } from "../_shared/errors.ts";
import { logger } from "../_shared/logger.ts";

const VERSION = "2.0.0";

// =============================================================================
// Schemas - Generic Chat
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

// =============================================================================
// Schemas - Food Sharing Chat
// =============================================================================

const foodCreateRoomSchema = z.object({
  postId: z.number().int().positive(),
  sharerId: z.string().uuid(),
  initialMessage: z.string().max(5000).optional(),
});

const foodSendMessageSchema = z.object({
  roomId: z.string().uuid(),
  text: z.string().min(1).max(5000),
  image: z.string().url().optional().nullable(),
});

const foodUpdateRoomSchema = z.object({
  action: z.enum(["accept", "complete", "archive"]),
});

// =============================================================================
// Shared Query Schema
// =============================================================================

const listQuerySchema = z.object({
  roomId: z.string().uuid().optional(),
  action: z.enum(["message"]).optional(),
  mode: z.enum(["food"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
  messagesBefore: z.string().optional(),
});

type CreateRoomBody = z.infer<typeof createRoomSchema>;
type SendMessageBody = z.infer<typeof sendMessageSchema>;
type UpdateRoomBody = z.infer<typeof updateRoomSchema>;
type FoodCreateRoomBody = z.infer<typeof foodCreateRoomSchema>;
type FoodSendMessageBody = z.infer<typeof foodSendMessageSchema>;
type FoodUpdateRoomBody = z.infer<typeof foodUpdateRoomSchema>;
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
// Food Chat Handlers (consolidated from api-v1-food-chat)
// Uses `rooms` + `room_participants` tables for food sharing exchanges.
// =============================================================================

async function foodListRooms(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const cursor = query.cursor;

  let roomsQuery = supabase
    .from("rooms")
    .select(`
      id, post_id, sharer, requester,
      last_message, last_message_sent_by, last_message_seen_by, last_message_time,
      post_arranged_to, post_arranged_at, is_archived, created_at,
      posts:post_id (id, post_name, images, post_type),
      sharer_profile:sharer (id, first_name, second_name, avatar_url),
      requester_profile:requester (id, first_name, second_name, avatar_url)
    `, { count: "exact" })
    .or(`sharer.eq.${userId},requester.eq.${userId}`)
    .eq("is_archived", false)
    .order("last_message_time", { ascending: false, nullsFirst: false })
    .limit(limit + 1);

  if (cursor) {
    roomsQuery = roomsQuery.lt("last_message_time", cursor);
  }

  const { data: rooms, error, count } = await roomsQuery;

  if (error) {
    logger.error("Failed to list food rooms", new Error(error.message));
    throw error;
  }

  const items = rooms || [];
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, -1) : items;

  return paginated(
    resultItems.map((room) => transformFoodRoom(room, userId)),
    ctx,
    { offset: 0, limit, total: count || resultItems.length }
  );
}

async function foodGetRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const roomId = query.roomId;

  if (!userId) throw new ValidationError("Authentication required");
  if (!roomId) throw new ValidationError("Room ID is required");

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select(`
      id, post_id, sharer, requester,
      last_message, last_message_sent_by, last_message_seen_by, last_message_time,
      post_arranged_to, post_arranged_at, is_archived, created_at,
      posts:post_id (id, post_name, post_address, images, post_type, profile_id),
      sharer_profile:sharer (id, first_name, second_name, avatar_url, email),
      requester_profile:requester (id, first_name, second_name, avatar_url, email)
    `)
    .eq("id", roomId)
    .single();

  if (roomError || !room) throw new NotFoundError("Room", roomId);
  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  const messageLimit = Math.min(parseInt(query.limit || "50"), 100);
  const { data: messages, error: messagesError } = await supabase
    .from("room_participants")
    .select(`
      id, room_id, profile_id, text, image, timestamp,
      sender:profile_id (id, first_name, second_name, avatar_url)
    `)
    .eq("room_id", roomId)
    .order("timestamp", { ascending: true })
    .limit(messageLimit);

  if (messagesError) {
    logger.error("Failed to fetch messages", new Error(messagesError.message));
    throw messagesError;
  }

  await supabase
    .from("rooms")
    .update({ last_message_seen_by: userId })
    .eq("id", roomId);

  return ok({
    room: transformFoodRoomDetail(room, userId),
    messages: (messages || []).map(transformFoodMessage),
  }, ctx);
}

async function foodCreateRoom(ctx: HandlerContext<FoodCreateRoomBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) throw new ValidationError("Authentication required");
  if (userId === body.sharerId) {
    throw new ValidationError("You cannot chat with yourself about your own listing");
  }

  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id, profile_id, post_name")
    .eq("id", body.postId)
    .single();

  if (postError || !post) throw new NotFoundError("Post", body.postId.toString());
  if (post.profile_id === userId) {
    throw new ValidationError("You cannot request your own listing");
  }

  const { data: existingRoom } = await supabase
    .from("rooms")
    .select("id")
    .eq("post_id", body.postId)
    .eq("sharer", body.sharerId)
    .eq("requester", userId)
    .single();

  if (existingRoom) return ok({ roomId: existingRoom.id, created: false }, ctx);

  const { data: newRoom, error: createError } = await supabase
    .from("rooms")
    .insert({
      post_id: body.postId,
      sharer: body.sharerId,
      requester: userId,
      last_message: body.initialMessage || "",
      last_message_sent_by: userId,
      last_message_seen_by: userId,
      last_message_time: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (createError) {
    logger.error("Failed to create food room", new Error(createError.message));
    throw createError;
  }

  if (body.initialMessage) {
    await supabase.from("room_participants").insert({
      room_id: newRoom.id,
      profile_id: userId,
      text: body.initialMessage,
    });
  }

  logger.info("Food chat room created", {
    roomId: newRoom.id, postId: body.postId, sharerId: body.sharerId, requesterId: userId,
  });

  return created({ roomId: newRoom.id, created: true }, ctx);
}

async function foodSendMessage(ctx: HandlerContext<FoodSendMessageBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) throw new ValidationError("Authentication required");

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, sharer, requester")
    .eq("id", body.roomId)
    .single();

  if (roomError || !room) throw new NotFoundError("Room", body.roomId);
  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  const { data: message, error: messageError } = await supabase
    .from("room_participants")
    .insert({
      room_id: body.roomId,
      profile_id: userId,
      text: body.text.trim(),
      image: body.image || null,
    })
    .select("id, room_id, profile_id, text, image, timestamp")
    .single();

  if (messageError) {
    logger.error("Failed to send message", new Error(messageError.message));
    throw messageError;
  }

  await supabase
    .from("rooms")
    .update({
      last_message: body.text.trim().substring(0, 200),
      last_message_sent_by: userId,
      last_message_seen_by: userId,
      last_message_time: new Date().toISOString(),
    })
    .eq("id", body.roomId);

  logger.info("Food message sent", { messageId: message.id, roomId: body.roomId, userId });

  return created(transformFoodMessage(message), ctx);
}

async function foodUpdateRoom(ctx: HandlerContext<FoodUpdateRoomBody, ListQuery>): Promise<Response> {
  const { supabase, userId, body, query } = ctx;
  const roomId = query.roomId;

  if (!userId) throw new ValidationError("Authentication required");
  if (!roomId) throw new ValidationError("Room ID is required");

  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select(`
      id, sharer, requester, post_arranged_to,
      posts:post_id (id, post_name, post_address)
    `)
    .eq("id", roomId)
    .single();

  if (roomError || !room) throw new NotFoundError("Room", roomId);
  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  const post = Array.isArray(room.posts) ? room.posts[0] : room.posts;

  switch (body.action) {
    case "accept": {
      if (room.sharer !== userId) {
        throw new AuthorizationError("Only the food owner can accept requests");
      }
      if (room.post_arranged_to) {
        throw new ConflictError("This request has already been accepted");
      }

      const address = post?.post_address || "Address not set";
      const acceptMessage = `🎉 Request Accepted!\n\n📍 Pickup Address:\n${address}\n\nPlease arrange a time to collect "${post?.post_name || "the item"}".`;

      await supabase
        .from("rooms")
        .update({ post_arranged_to: room.requester, post_arranged_at: new Date().toISOString() })
        .eq("id", roomId);

      await supabase.from("room_participants").insert({
        room_id: roomId, profile_id: userId, text: acceptMessage,
      });

      await supabase
        .from("rooms")
        .update({
          last_message: acceptMessage.substring(0, 100) + "...",
          last_message_sent_by: userId,
          last_message_seen_by: userId,
          last_message_time: new Date().toISOString(),
        })
        .eq("id", roomId);

      logger.info("Request accepted", { roomId, userId });
      return ok({ success: true, address }, ctx);
    }

    case "complete": {
      if (!room.post_arranged_to) {
        throw new ValidationError("Request must be accepted before completing");
      }

      const completeMessage = "✅ Exchange Complete! Thank you for sharing food.";

      if (post) {
        await supabase.from("posts").update({ is_arranged: true }).eq("id", post.id);
      }

      await supabase.from("room_participants").insert({
        room_id: roomId, profile_id: userId, text: completeMessage,
      });

      await supabase
        .from("rooms")
        .update({
          last_message: completeMessage,
          last_message_sent_by: userId,
          last_message_seen_by: userId,
          last_message_time: new Date().toISOString(),
        })
        .eq("id", roomId);

      logger.info("Exchange completed", { roomId, userId });
      return ok({ success: true }, ctx);
    }

    case "archive": {
      await supabase
        .from("rooms")
        .update({ is_archived: true, archived_at: new Date().toISOString() })
        .eq("id", roomId);

      logger.info("Room archived", { roomId, userId });
      return ok({ success: true }, ctx);
    }

    default:
      throw new ValidationError(`Unknown action: ${body.action}`);
  }
}

async function foodArchiveRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const roomId = query.roomId;

  if (!userId) throw new ValidationError("Authentication required");
  if (!roomId) throw new ValidationError("Room ID is required");

  const { data: room } = await supabase
    .from("rooms")
    .select("sharer, requester")
    .eq("id", roomId)
    .single();

  if (!room || (room.sharer !== userId && room.requester !== userId)) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  await supabase
    .from("rooms")
    .update({ is_archived: true, archived_at: new Date().toISOString() })
    .eq("id", roomId);

  logger.info("Room archived", { roomId, userId });
  return noContent(ctx);
}

// =============================================================================
// Food Chat Transformers
// =============================================================================

function transformFoodRoom(data: Record<string, unknown>, currentUserId: string) {
  const post = data.posts as Record<string, unknown> | null;
  const sharerProfile = data.sharer_profile as Record<string, unknown> | null;
  const requesterProfile = data.requester_profile as Record<string, unknown> | null;
  const isSharer = data.sharer === currentUserId;
  const otherProfile = isSharer ? requesterProfile : sharerProfile;

  return {
    id: data.id,
    postId: data.post_id,
    post: post ? {
      id: post.id,
      name: post.post_name,
      type: post.post_type,
      image: Array.isArray(post.images) ? post.images[0] : null,
    } : null,
    otherParticipant: otherProfile ? {
      id: otherProfile.id,
      name: `${otherProfile.first_name || ""} ${otherProfile.second_name || ""}`.trim(),
      avatarUrl: otherProfile.avatar_url,
    } : null,
    lastMessage: data.last_message,
    lastMessageTime: data.last_message_time,
    hasUnread: data.last_message_sent_by !== currentUserId &&
               data.last_message_seen_by !== currentUserId,
    isArranged: !!data.post_arranged_to,
    arrangedAt: data.post_arranged_at,
    isSharer,
    createdAt: data.created_at,
  };
}

function transformFoodRoomDetail(data: Record<string, unknown>, currentUserId: string) {
  const base = transformFoodRoom(data, currentUserId);
  const post = data.posts as Record<string, unknown> | null;

  return {
    ...base,
    post: post ? {
      id: post.id,
      name: post.post_name,
      type: post.post_type,
      address: post.post_address,
      images: post.images,
      ownerId: post.profile_id,
    } : null,
  };
}

function transformFoodMessage(data: Record<string, unknown>) {
  const sender = data.sender as Record<string, unknown> | null;

  return {
    id: data.id,
    roomId: data.room_id,
    senderId: data.profile_id,
    text: data.text,
    image: data.image,
    sender: sender ? {
      id: sender.id,
      name: `${sender.first_name || ""} ${sender.second_name || ""}`.trim(),
      avatarUrl: sender.avatar_url,
    } : null,
    timestamp: data.timestamp,
  };
}

// =============================================================================
// Route Handlers
// =============================================================================

function handleGet(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return ok({ status: "healthy", service: "api-v1-chat", version: VERSION, timestamp: new Date().toISOString() }, ctx);
  }

  if (ctx.query.mode === "food") {
    return ctx.query.roomId ? foodGetRoom(ctx) : foodListRooms(ctx);
  }
  if (ctx.query.roomId) {
    return getRoom(ctx);
  }
  return listRooms(ctx);
}

// deno-lint-ignore no-explicit-any
function handlePost(ctx: HandlerContext<any, ListQuery>): Promise<Response> {
  if (ctx.query.mode === "food") {
    if (ctx.query.action === "message") {
      return foodSendMessage(ctx as HandlerContext<FoodSendMessageBody, ListQuery>);
    }
    return foodCreateRoom(ctx as HandlerContext<FoodCreateRoomBody, ListQuery>);
  }
  if (ctx.query.action === "message") {
    return sendMessage(ctx as HandlerContext<SendMessageBody, ListQuery>);
  }
  return createRoom(ctx as HandlerContext<CreateRoomBody, ListQuery>);
}

// deno-lint-ignore no-explicit-any
function handlePut(ctx: HandlerContext<any, ListQuery>): Promise<Response> {
  if (ctx.query.mode === "food") {
    return foodUpdateRoom(ctx as HandlerContext<FoodUpdateRoomBody, ListQuery>);
  }
  return updateRoom(ctx as HandlerContext<UpdateRoomBody, ListQuery>);
}

function handleDelete(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  if (ctx.query.mode === "food") {
    return foodArchiveRoom(ctx);
  }
  return leaveRoom(ctx);
}

// =============================================================================
// Export Handler
// =============================================================================

export default createAPIHandler({
  service: "api-v1-chat",
  version: "2.0.0",
  requireAuth: true,
  rateLimit: {
    limit: 60,
    windowMs: 60000,
    keyBy: "user",
  },
  routes: {
    GET: {
      querySchema: listQuerySchema,
      handler: handleGet,
    },
    POST: {
      handler: handlePost,
      idempotent: true,
    },
    PUT: {
      querySchema: listQuerySchema,
      handler: handlePut,
    },
    DELETE: {
      querySchema: listQuerySchema,
      handler: handleDelete,
    },
  },
});
