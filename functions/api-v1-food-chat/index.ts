/**
 * Food Sharing Chat API v1
 *
 * REST API for food sharing chat operations.
 * Uses the food-sharing-specific schema (rooms, room_participants).
 *
 * This is separate from the generic chat API (api-v1-chat) which uses
 * a different schema (chat_rooms, messages).
 *
 * Endpoints:
 * - GET    /api-v1-food-chat              - List user's food chat rooms
 * - GET    /api-v1-food-chat?roomId=<id>  - Get room with messages
 * - POST   /api-v1-food-chat              - Create food chat room
 * - POST   /api-v1-food-chat?action=message - Send message
 * - PUT    /api-v1-food-chat?roomId=<id>  - Update room (accept request, complete)
 * - DELETE /api-v1-food-chat?roomId=<id>  - Archive room
 *
 * Headers:
 * - Authorization: Bearer <jwt>
 * - X-Idempotency-Key: <uuid> (for POST)
 *
 * @module api-v1-food-chat
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

// =============================================================================
// Schemas
// =============================================================================

const createRoomSchema = z.object({
  postId: z.number().int().positive(),
  sharerId: z.string().uuid(),
  initialMessage: z.string().max(5000).optional(),
});

const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  text: z.string().min(1).max(5000),
  image: z.string().url().optional().nullable(),
});

const updateRoomSchema = z.object({
  action: z.enum(["accept", "complete", "archive"]),
});

const listQuerySchema = z.object({
  roomId: z.string().uuid().optional(),
  action: z.enum(["message"]).optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

type CreateRoomBody = z.infer<typeof createRoomSchema>;
type SendMessageBody = z.infer<typeof sendMessageSchema>;
type UpdateRoomBody = z.infer<typeof updateRoomSchema>;
type ListQuery = z.infer<typeof listQuerySchema>;

// =============================================================================
// Handlers
// =============================================================================

/**
 * List user's food chat rooms
 */
async function listRooms(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const cursor = query.cursor;

  // Get rooms where user is sharer or requester
  let roomsQuery = supabase
    .from("rooms")
    .select(`
      id,
      post_id,
      sharer,
      requester,
      last_message,
      last_message_sent_by,
      last_message_seen_by,
      last_message_time,
      post_arranged_to,
      post_arranged_at,
      is_archived,
      created_at,
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
    logger.error("Failed to list rooms", new Error(error.message));
    throw error;
  }

  const items = rooms || [];
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, -1) : items;

  return paginated(
    resultItems.map((room) => transformRoom(room, userId)),
    ctx,
    {
      offset: 0,
      limit,
      total: count || resultItems.length,
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

  // Get room and verify membership
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select(`
      id,
      post_id,
      sharer,
      requester,
      last_message,
      last_message_sent_by,
      last_message_seen_by,
      last_message_time,
      post_arranged_to,
      post_arranged_at,
      is_archived,
      created_at,
      posts:post_id (id, post_name, post_address, images, post_type, profile_id),
      sharer_profile:sharer (id, first_name, second_name, avatar_url, email),
      requester_profile:requester (id, first_name, second_name, avatar_url, email)
    `)
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new NotFoundError("Room", roomId);
  }

  // Verify user is a participant
  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  // Get messages
  const messageLimit = Math.min(parseInt(query.limit || "50"), 100);
  const { data: messages, error: messagesError } = await supabase
    .from("room_participants")
    .select(`
      id,
      room_id,
      profile_id,
      text,
      image,
      timestamp,
      sender:profile_id (id, first_name, second_name, avatar_url)
    `)
    .eq("room_id", roomId)
    .order("timestamp", { ascending: true })
    .limit(messageLimit);

  if (messagesError) {
    logger.error("Failed to fetch messages", new Error(messagesError.message));
    throw messagesError;
  }

  // Mark as seen
  await supabase
    .from("rooms")
    .update({ last_message_seen_by: userId })
    .eq("id", roomId);

  return ok({
    room: transformRoomDetail(room, userId),
    messages: (messages || []).map(transformMessage),
  }, ctx);
}

/**
 * Create food chat room
 */
async function createRoom(ctx: HandlerContext<CreateRoomBody>): Promise<Response> {
  const { supabase, userId, body } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  // Prevent self-chat
  if (userId === body.sharerId) {
    throw new ValidationError("You cannot chat with yourself about your own listing");
  }

  // Verify post belongs to sharer
  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("id, profile_id, post_name")
    .eq("id", body.postId)
    .single();

  if (postError || !post) {
    throw new NotFoundError("Post", body.postId.toString());
  }

  if (post.profile_id === userId) {
    throw new ValidationError("You cannot request your own listing");
  }

  // Check if room already exists
  const { data: existingRoom } = await supabase
    .from("rooms")
    .select("id")
    .eq("post_id", body.postId)
    .eq("sharer", body.sharerId)
    .eq("requester", userId)
    .single();

  if (existingRoom) {
    return ok({ roomId: existingRoom.id, created: false }, ctx);
  }

  // Create new room
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
    logger.error("Failed to create room", new Error(createError.message));
    throw createError;
  }

  // Send initial message if provided
  if (body.initialMessage) {
    await supabase.from("room_participants").insert({
      room_id: newRoom.id,
      profile_id: userId,
      text: body.initialMessage,
    });
  }

  logger.info("Food chat room created", {
    roomId: newRoom.id,
    postId: body.postId,
    sharerId: body.sharerId,
    requesterId: userId,
  });

  return created({ roomId: newRoom.id, created: true }, ctx);
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
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("id, sharer, requester")
    .eq("id", body.roomId)
    .single();

  if (roomError || !room) {
    throw new NotFoundError("Room", body.roomId);
  }

  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  // Insert message
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

  // Update room
  await supabase
    .from("rooms")
    .update({
      last_message: body.text.trim().substring(0, 200),
      last_message_sent_by: userId,
      last_message_seen_by: userId,
      last_message_time: new Date().toISOString(),
    })
    .eq("id", body.roomId);

  logger.info("Message sent", {
    messageId: message.id,
    roomId: body.roomId,
    userId,
  });

  return created(transformMessage(message), ctx);
}

/**
 * Update room (accept request, complete exchange, archive)
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

  // Get room with post details
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select(`
      id, sharer, requester, post_arranged_to,
      posts:post_id (id, post_name, post_address)
    `)
    .eq("id", roomId)
    .single();

  if (roomError || !room) {
    throw new NotFoundError("Room", roomId);
  }

  // Verify participant
  if (room.sharer !== userId && room.requester !== userId) {
    throw new AuthorizationError("You are not a participant in this chat");
  }

  const post = Array.isArray(room.posts) ? room.posts[0] : room.posts;

  switch (body.action) {
    case "accept": {
      // Only sharer can accept
      if (room.sharer !== userId) {
        throw new AuthorizationError("Only the food owner can accept requests");
      }

      if (room.post_arranged_to) {
        throw new ConflictError("This request has already been accepted");
      }

      const address = post?.post_address || "Address not set";
      const acceptMessage = `🎉 Request Accepted!\n\n📍 Pickup Address:\n${address}\n\nPlease arrange a time to collect "${post?.post_name || "the item"}".`;

      // Update room and send message
      await supabase
        .from("rooms")
        .update({
          post_arranged_to: room.requester,
          post_arranged_at: new Date().toISOString(),
        })
        .eq("id", roomId);

      await supabase.from("room_participants").insert({
        room_id: roomId,
        profile_id: userId,
        text: acceptMessage,
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

      // Mark post as arranged
      if (post) {
        await supabase
          .from("posts")
          .update({ is_arranged: true })
          .eq("id", post.id);
      }

      // Send completion message
      await supabase.from("room_participants").insert({
        room_id: roomId,
        profile_id: userId,
        text: completeMessage,
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
        .update({
          is_archived: true,
          archived_at: new Date().toISOString(),
        })
        .eq("id", roomId);

      logger.info("Room archived", { roomId, userId });

      return ok({ success: true }, ctx);
    }

    default:
      throw new ValidationError(`Unknown action: ${body.action}`);
  }
}

/**
 * Archive/leave room
 */
async function archiveRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;
  const roomId = query.roomId;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  if (!roomId) {
    throw new ValidationError("Room ID is required");
  }

  // Verify membership
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
    .update({
      is_archived: true,
      archived_at: new Date().toISOString(),
    })
    .eq("id", roomId);

  logger.info("Room archived", { roomId, userId });

  return noContent(ctx);
}

// =============================================================================
// Transformers
// =============================================================================

function transformRoom(data: Record<string, unknown>, currentUserId: string) {
  const post = data.posts as Record<string, unknown> | null;
  const sharerProfile = data.sharer_profile as Record<string, unknown> | null;
  const requesterProfile = data.requester_profile as Record<string, unknown> | null;

  // Determine the "other" participant
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

function transformRoomDetail(data: Record<string, unknown>, currentUserId: string) {
  const base = transformRoom(data, currentUserId);
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

function transformMessage(data: Record<string, unknown>) {
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
  service: "api-v1-food-chat",
  version: "1.0.0",
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
      schema: updateRoomSchema,
      querySchema: listQuerySchema,
      handler: updateRoom,
    },
    DELETE: {
      querySchema: listQuerySchema,
      handler: archiveRoom,
    },
  },
});
