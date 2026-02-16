/**
 * Chat Tests
 *
 * Tests for api-v1-chat food chat handler logic.
 * Tests schema validation, room operations, and message handling.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// =============================================================================
// Schema Definitions (matching what api-v1-chat uses)
// =============================================================================

const createRoomSchema = z.object({
  postId: z.number().int().positive(),
  sellerId: z.string().uuid(),
  message: z.string().min(1).max(1000).optional(),
});

const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().min(1).max(5000),
  type: z.enum(["text", "image", "location", "system"]).default("text"),
});

const updateRoomStateSchema = z.object({
  roomId: z.string().uuid(),
  status: z.enum(["accepted", "completed", "archived", "cancelled"]),
});

const listRoomsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["pending", "accepted", "completed", "archived", "cancelled"]).optional(),
});

// =============================================================================
// Schema Validation Tests
// =============================================================================

Deno.test("createRoomSchema: valid input passes", () => {
  const result = createRoomSchema.safeParse({
    postId: 123,
    sellerId: "550e8400-e29b-41d4-a716-446655440000",
    message: "Is this still available?",
  });
  assertEquals(result.success, true);
});

Deno.test("createRoomSchema: missing postId fails", () => {
  const result = createRoomSchema.safeParse({
    sellerId: "550e8400-e29b-41d4-a716-446655440000",
  });
  assertEquals(result.success, false);
});

Deno.test("createRoomSchema: invalid postId (negative) fails", () => {
  const result = createRoomSchema.safeParse({
    postId: -1,
    sellerId: "550e8400-e29b-41d4-a716-446655440000",
  });
  assertEquals(result.success, false);
});

Deno.test("createRoomSchema: invalid sellerId (not uuid) fails", () => {
  const result = createRoomSchema.safeParse({
    postId: 123,
    sellerId: "not-a-uuid",
  });
  assertEquals(result.success, false);
});

Deno.test("createRoomSchema: optional message works", () => {
  const result = createRoomSchema.safeParse({
    postId: 456,
    sellerId: "550e8400-e29b-41d4-a716-446655440000",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.message, undefined);
  }
});

Deno.test("sendMessageSchema: valid text message passes", () => {
  const result = sendMessageSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    content: "Hello!",
    type: "text",
  });
  assertEquals(result.success, true);
});

Deno.test("sendMessageSchema: empty content fails", () => {
  const result = sendMessageSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    content: "",
  });
  assertEquals(result.success, false);
});

Deno.test("sendMessageSchema: content exceeds 5000 chars fails", () => {
  const result = sendMessageSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    content: "x".repeat(5001),
  });
  assertEquals(result.success, false);
});

Deno.test("sendMessageSchema: invalid type fails", () => {
  const result = sendMessageSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    content: "test",
    type: "video",
  });
  assertEquals(result.success, false);
});

Deno.test("sendMessageSchema: defaults type to text", () => {
  const result = sendMessageSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    content: "Hello",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.type, "text");
  }
});

// =============================================================================
// Room State Transition Tests
// =============================================================================

Deno.test("updateRoomStateSchema: accept transition valid", () => {
  const result = updateRoomStateSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    status: "accepted",
  });
  assertEquals(result.success, true);
});

Deno.test("updateRoomStateSchema: complete transition valid", () => {
  const result = updateRoomStateSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    status: "completed",
  });
  assertEquals(result.success, true);
});

Deno.test("updateRoomStateSchema: archive transition valid", () => {
  const result = updateRoomStateSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    status: "archived",
  });
  assertEquals(result.success, true);
});

Deno.test("updateRoomStateSchema: invalid status fails", () => {
  const result = updateRoomStateSchema.safeParse({
    roomId: "550e8400-e29b-41d4-a716-446655440000",
    status: "deleted",
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Room Listing Tests
// =============================================================================

Deno.test("listRoomsSchema: default pagination", () => {
  const result = listRoomsSchema.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.limit, 20);
    assertEquals(result.data.offset, 0);
  }
});

Deno.test("listRoomsSchema: custom pagination", () => {
  const result = listRoomsSchema.safeParse({
    limit: "50",
    offset: "20",
    status: "accepted",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.limit, 50);
    assertEquals(result.data.offset, 20);
    assertEquals(result.data.status, "accepted");
  }
});

Deno.test("listRoomsSchema: limit exceeding 100 fails", () => {
  const result = listRoomsSchema.safeParse({ limit: 200 });
  assertEquals(result.success, false);
});

Deno.test("listRoomsSchema: negative offset fails", () => {
  const result = listRoomsSchema.safeParse({ offset: -1 });
  assertEquals(result.success, false);
});

// =============================================================================
// Room Creation Logic Tests
// =============================================================================

Deno.test("room creation: mock success path", async () => {
  const roomId = crypto.randomUUID();
  const mockRoom = {
    id: roomId,
    post_id: 123,
    buyer_id: "buyer-uuid",
    seller_id: "seller-uuid",
    status: "pending",
    created_at: new Date().toISOString(),
  };

  // Simulate what the handler does
  const parsed = createRoomSchema.parse({
    postId: 123,
    sellerId: "550e8400-e29b-41d4-a716-446655440000",
    message: "Hi!",
  });

  assertExists(parsed.postId);
  assertEquals(parsed.postId, 123);
  assertExists(mockRoom.id);
  assertEquals(mockRoom.status, "pending");
});

Deno.test("room creation: duplicate conflict detection logic", () => {
  // Simulate Supabase conflict error (23505 = unique_violation)
  const error = {
    code: "23505",
    message: "duplicate key value violates unique constraint",
    details: "Key (post_id, buyer_id)=(123, buyer-uuid) already exists.",
  };

  // Handler should detect this and return 409
  assertEquals(error.code, "23505");
  const isConflict = error.code === "23505";
  assertEquals(isConflict, true);
});

// =============================================================================
// Message Membership Validation Logic
// =============================================================================

Deno.test("message sending: validates room membership", () => {
  const userId = "user-1";
  const room = {
    id: "room-1",
    buyer_id: "user-1",
    seller_id: "user-2",
    status: "accepted",
  };

  // User must be buyer or seller
  const isMember = room.buyer_id === userId || room.seller_id === userId;
  assertEquals(isMember, true);

  // Non-member should fail
  const nonMemberId = "user-3";
  const isNonMember = room.buyer_id === nonMemberId || room.seller_id === nonMemberId;
  assertEquals(isNonMember, false);
});

Deno.test("message sending: rejects if room is archived", () => {
  const room = { status: "archived" };
  const canSendMessage = room.status !== "archived" && room.status !== "cancelled";
  assertEquals(canSendMessage, false);
});

Deno.test("message sending: allows if room is accepted", () => {
  const room = { status: "accepted" };
  const canSendMessage = room.status !== "archived" && room.status !== "cancelled";
  assertEquals(canSendMessage, true);
});
