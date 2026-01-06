-- Migration: Phase 28 - Atomic Message Send RPC
-- Created: 2026-01-03
-- Purpose: Atomically send a message and update room metadata
--
-- Features:
-- 1. Insert message atomically
-- 2. Update room last_message_at and last_message_preview
-- 3. Increment unread count for recipient
-- 4. Return message with room metadata

-- =============================================================================
-- Send Message with Room Update RPC
-- =============================================================================

DROP FUNCTION IF EXISTS send_message_with_room_update(UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION send_message_with_room_update(
    p_room_id UUID,
    p_content TEXT,
    p_message_type TEXT DEFAULT 'text',
    p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_message_id UUID;
    v_room RECORD;
    v_recipient_id UUID;
    v_created_at TIMESTAMPTZ := NOW();
    v_preview TEXT;
BEGIN
    -- Verify user is authenticated
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    -- Get room and verify user is a participant
    SELECT * INTO v_room
    FROM chat_rooms
    WHERE id = p_room_id;

    IF v_room IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Room not found'
        );
    END IF;

    -- Check if user is a participant
    IF v_user_id NOT IN (v_room.user1_id, v_room.user2_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Not a participant of this room'
        );
    END IF;

    -- Determine the recipient
    IF v_user_id = v_room.user1_id THEN
        v_recipient_id := v_room.user2_id;
    ELSE
        v_recipient_id := v_room.user1_id;
    END IF;

    -- Create message preview (truncated content)
    v_preview := CASE
        WHEN length(p_content) > 50 THEN left(p_content, 47) || '...'
        ELSE p_content
    END;

    -- ==========================================================================
    -- Atomic operations begin
    -- ==========================================================================

    -- 1. Insert the message
    INSERT INTO messages (
        room_id,
        sender_id,
        content,
        message_type,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        p_room_id,
        v_user_id,
        p_content,
        p_message_type,
        p_metadata,
        v_created_at,
        v_created_at
    )
    RETURNING id INTO v_message_id;

    -- 2. Update room metadata
    UPDATE chat_rooms
    SET
        last_message_at = v_created_at,
        last_message_preview = v_preview,
        last_message_sender_id = v_user_id,
        updated_at = v_created_at
    WHERE id = p_room_id;

    -- 3. Increment unread count for recipient
    -- Using INSERT ON CONFLICT to handle case where unread_counts row doesn't exist
    INSERT INTO room_unread_counts (room_id, user_id, unread_count, last_read_at)
    VALUES (p_room_id, v_recipient_id, 1, NULL)
    ON CONFLICT (room_id, user_id)
    DO UPDATE SET
        unread_count = room_unread_counts.unread_count + 1,
        updated_at = v_created_at;

    -- ==========================================================================
    -- Return result
    -- ==========================================================================

    RETURN jsonb_build_object(
        'success', true,
        'message', jsonb_build_object(
            'id', v_message_id,
            'room_id', p_room_id,
            'sender_id', v_user_id,
            'content', p_content,
            'message_type', p_message_type,
            'metadata', p_metadata,
            'created_at', v_created_at,
            'is_read', false
        ),
        'room', jsonb_build_object(
            'id', p_room_id,
            'last_message_at', v_created_at,
            'last_message_preview', v_preview
        ),
        'recipient_id', v_recipient_id
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION send_message_with_room_update(UUID, TEXT, TEXT, JSONB) TO authenticated;

-- =============================================================================
-- Mark Messages as Read RPC
-- =============================================================================

DROP FUNCTION IF EXISTS mark_messages_read(UUID);

CREATE OR REPLACE FUNCTION mark_messages_read(
    p_room_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_updated_count INTEGER;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- Verify user is authenticated
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Authentication required'
        );
    END IF;

    -- Mark all unread messages in this room as read
    UPDATE messages
    SET
        is_read = true,
        read_at = v_now,
        updated_at = v_now
    WHERE room_id = p_room_id
    AND sender_id != v_user_id
    AND is_read = false;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- Reset unread count for this user
    UPDATE room_unread_counts
    SET
        unread_count = 0,
        last_read_at = v_now,
        updated_at = v_now
    WHERE room_id = p_room_id
    AND user_id = v_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'messages_marked_read', v_updated_count,
        'read_at', v_now
    );

EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION mark_messages_read(UUID) TO authenticated;

-- =============================================================================
-- Supporting table for unread counts (if not exists)
-- =============================================================================

CREATE TABLE IF NOT EXISTS room_unread_counts (
    room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    unread_count INTEGER NOT NULL DEFAULT 0,
    last_read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (room_id, user_id)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_room_unread_counts_user
ON room_unread_counts(user_id);

-- =============================================================================
-- Indexes for efficient message queries
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_room_created
ON messages(room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_unread
ON messages(sender_id, is_read)
WHERE is_read = false;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION send_message_with_room_update IS
'Atomically sends a message, updates room metadata, and increments recipient unread count. Phase 28.1';

COMMENT ON FUNCTION mark_messages_read IS
'Marks all unread messages in a room as read for the current user. Phase 28.1';

COMMENT ON TABLE room_unread_counts IS
'Tracks unread message counts per user per room for efficient badge display. Phase 28.1';
