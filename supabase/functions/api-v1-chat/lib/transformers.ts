/**
 * Chat Transformers
 *
 * All 6 transformer functions for generic and food chat data.
 * Converts snake_case database rows to camelCase API response objects.
 */

import { transformProfileSummary, transformProfileWithName } from "../../_shared/transformers.ts";

// =============================================================================
// Generic Chat Transformers
// =============================================================================

export function transformRoom(data: Record<string, unknown>) {
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

export function transformRoomDetail(data: Record<string, unknown>) {
  const members = data.members as Array<{ profile: Record<string, unknown> }> | null;

  return {
    id: data.id,
    name: data.name,
    roomType: data.room_type,
    createdBy: data.created_by,
    createdAt: data.created_at,
    members: members?.map((m) => transformProfileSummary(m.profile)).filter(Boolean) || [],
  };
}

export function transformMessage(data: Record<string, unknown>) {
  const sender = data.sender as Record<string, unknown> | null;
  const replyTo = data.reply_to as Record<string, unknown> | null;

  return {
    id: data.id,
    content: data.content,
    attachments: data.attachments,
    sender: transformProfileSummary(sender),
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
// Food Chat Transformers
// =============================================================================

export function transformFoodRoom(data: Record<string, unknown>, currentUserId: string) {
  const post = data.posts as Record<string, unknown> | null;
  const sharerProfile = data.sharer_profile as Record<string, unknown> | null;
  const requesterProfile = data.requester_profile as Record<string, unknown> | null;
  const isSharer = data.sharer === currentUserId;
  const otherProfile = isSharer ? requesterProfile : sharerProfile;

  return {
    id: data.id,
    postId: data.post_id,
    post: post
      ? {
        id: post.id,
        name: post.post_name,
        type: post.post_type,
        image: Array.isArray(post.images) ? post.images[0] : null,
      }
      : null,
    otherParticipant: transformProfileWithName(otherProfile),
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

export function transformFoodRoomDetail(data: Record<string, unknown>, currentUserId: string) {
  const base = transformFoodRoom(data, currentUserId);
  const post = data.posts as Record<string, unknown> | null;

  return {
    ...base,
    post: post
      ? {
        id: post.id,
        name: post.post_name,
        type: post.post_type,
        address: post.post_address,
        images: post.images,
        ownerId: post.profile_id,
      }
      : null,
  };
}

export function transformFoodMessage(data: Record<string, unknown>) {
  const sender = data.sender as Record<string, unknown> | null;

  return {
    id: data.id,
    roomId: data.room_id,
    senderId: data.profile_id,
    text: data.text,
    image: data.image,
    sender: transformProfileWithName(sender),
    timestamp: data.timestamp,
  };
}
