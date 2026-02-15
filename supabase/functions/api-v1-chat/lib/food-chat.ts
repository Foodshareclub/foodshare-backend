/**
 * Food Sharing Chat Handlers
 *
 * Handlers for food sharing chat operations (list rooms, get room, create, send message,
 * accept/complete exchange, archive).
 * Uses `rooms` + `room_participants` tables for food sharing exchanges.
 */

import { positiveIntSchema, uuidSchema, z } from "../../_shared/schemas/common.ts";
import {
  created,
  type HandlerContext,
  noContent,
  ok,
  paginated,
} from "../../_shared/api-handler.ts";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../_shared/errors.ts";
import { logger } from "../../_shared/logger.ts";
import {
  transformFoodMessage,
  transformFoodRoom,
  transformFoodRoomDetail,
} from "./transformers.ts";

// =============================================================================
// Schemas
// =============================================================================

export const foodCreateRoomSchema = z.object({
  postId: positiveIntSchema,
  sharerId: uuidSchema,
  initialMessage: z.string().max(5000).optional(),
});

export const foodSendMessageSchema = z.object({
  roomId: uuidSchema,
  text: z.string().min(1).max(5000),
  image: z.string().url().optional().nullable(),
});

export const foodUpdateRoomSchema = z.object({
  action: z.enum(["accept", "complete", "archive"]),
});

export type FoodCreateRoomBody = z.infer<typeof foodCreateRoomSchema>;
export type FoodSendMessageBody = z.infer<typeof foodSendMessageSchema>;
export type FoodUpdateRoomBody = z.infer<typeof foodUpdateRoomSchema>;

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

export async function foodListRooms(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  const { supabase, userId, query } = ctx;

  if (!userId) {
    throw new ValidationError("Authentication required");
  }

  const limit = Math.min(parseInt(query.limit || "20"), 50);
  const cursor = query.cursor;

  let roomsQuery = supabase
    .from("rooms")
    .select(
      `
      id, post_id, sharer, requester,
      last_message, last_message_sent_by, last_message_seen_by, last_message_time,
      post_arranged_to, post_arranged_at, is_archived, created_at,
      posts:post_id (id, post_name, images, post_type),
      sharer_profile:sharer (id, first_name, second_name, avatar_url),
      requester_profile:requester (id, first_name, second_name, avatar_url)
    `,
      { count: "exact" },
    )
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
    { offset: 0, limit, total: count || resultItems.length },
  );
}

export async function foodGetRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
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

export async function foodCreateRoom(ctx: HandlerContext<FoodCreateRoomBody>): Promise<Response> {
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
    roomId: newRoom.id,
    postId: body.postId,
    sharerId: body.sharerId,
    requesterId: userId,
  });

  return created({ roomId: newRoom.id, created: true }, ctx);
}

export async function foodSendMessage(ctx: HandlerContext<FoodSendMessageBody>): Promise<Response> {
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

export async function foodUpdateRoom(
  ctx: HandlerContext<FoodUpdateRoomBody, ListQuery>,
): Promise<Response> {
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
      const acceptMessage =
        `🎉 Request Accepted!\n\n📍 Pickup Address:\n${address}\n\nPlease arrange a time to collect "${
          post?.post_name || "the item"
        }".`;

      await supabase
        .from("rooms")
        .update({ post_arranged_to: room.requester, post_arranged_at: new Date().toISOString() })
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

      if (post) {
        await supabase.from("posts").update({ is_arranged: true }).eq("id", post.id);
      }

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
        .update({ is_archived: true, archived_at: new Date().toISOString() })
        .eq("id", roomId);

      logger.info("Room archived", { roomId, userId });
      return ok({ success: true }, ctx);
    }

    default:
      throw new ValidationError(`Unknown action: ${body.action}`);
  }
}

export async function foodArchiveRoom(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
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
