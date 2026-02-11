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
import { createAPIHandler, type HandlerContext, ok } from "../_shared/api-handler.ts";
import { createHealthHandler } from "../_shared/health-handler.ts";

// Generic chat handlers
import {
  createRoom,
  type CreateRoomBody,
  getRoom,
  leaveRoom,
  listRooms,
  sendMessage,
  type SendMessageBody,
  updateRoom,
  type UpdateRoomBody,
} from "./lib/generic.ts";

// Food chat handlers
import {
  foodArchiveRoom,
  foodCreateRoom,
  type FoodCreateRoomBody,
  foodGetRoom,
  foodListRooms,
  foodSendMessage,
  type FoodSendMessageBody,
  foodUpdateRoom,
  type FoodUpdateRoomBody,
} from "./lib/food-chat.ts";

const VERSION = "2.0.0";
const healthCheck = createHealthHandler("api-v1-chat", VERSION);

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

type ListQuery = z.infer<typeof listQuerySchema>;

/** Union of all POST body types for the chat endpoint */
type PostBody = CreateRoomBody | SendMessageBody | FoodCreateRoomBody | FoodSendMessageBody;

/** Union of all PUT body types for the chat endpoint */
type PutBody = UpdateRoomBody | FoodUpdateRoomBody;

// =============================================================================
// Route Handlers
// =============================================================================

function handleGet(ctx: HandlerContext<unknown, ListQuery>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return healthCheck(ctx);
  }

  if (ctx.query.mode === "food") {
    return ctx.query.roomId ? foodGetRoom(ctx) : foodListRooms(ctx);
  }
  if (ctx.query.roomId) {
    return getRoom(ctx);
  }
  return listRooms(ctx);
}

function handlePost(ctx: HandlerContext<PostBody, ListQuery>): Promise<Response> {
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

function handlePut(ctx: HandlerContext<PutBody, ListQuery>): Promise<Response> {
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

Deno.serve(createAPIHandler({
  service: "api-v1-chat",
  version: "2.0.0",
  requireAuth: true,
  csrf: true,
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
}));
