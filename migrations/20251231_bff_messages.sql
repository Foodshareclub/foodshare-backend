-- =============================================================================
-- BFF Messages RPC Function
-- =============================================================================
-- Aggregated RPC function for messages/chat screen.
-- Returns all chat rooms with last messages and participant info in single call.
-- =============================================================================

-- =============================================================================
-- BFF Messages Data
-- =============================================================================
-- Returns aggregated data for the messages screen:
-- - User's chat rooms with last message preview
-- - Participant profiles
-- - Unread counts per room
-- - Total unread count
-- =============================================================================

CREATE OR REPLACE FUNCTION get_bff_messages_data(
  p_user_id UUID,
  p_limit INT DEFAULT 20,
  p_cursor TIMESTAMPTZ DEFAULT NULL,
  p_include_archived BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_rooms JSONB;
  v_total_unread INT;
BEGIN
  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  -- Get user's rooms with last message and participants
  SELECT jsonb_agg(room_data)
  INTO v_rooms
  FROM (
    SELECT jsonb_build_object(
      'room_id', r.id,
      'room_name', r.name,
      'room_type', r.room_type,
      'is_muted', rm.is_muted,
      'is_pinned', rm.is_pinned,
      'unread_count', rm.unread_count,
      'updated_at', COALESCE(r.last_message_at, r.updated_at),
      'last_message_id', lm.id,
      'last_message_content', lm.content,
      'last_message_sender_id', lm.profile_id,
      'last_message_sender_name', lm_sender.display_name,
      'last_message_at', lm.created_at,
      'last_message_read', lm.created_at <= rm.last_read_at,
      'participants', (
        SELECT jsonb_agg(jsonb_build_object(
          'id', p.id,
          'display_name', p.display_name,
          'avatar_url', p.avatar_url,
          'is_online', p.last_active_at > NOW() - INTERVAL '5 minutes'
        ))
        FROM room_members rm2
        JOIN profiles p ON p.id = rm2.profile_id
        WHERE rm2.room_id = r.id
          AND rm2.profile_id != p_user_id
      )
    ) AS room_data
    FROM chat_rooms r
    JOIN room_members rm ON rm.room_id = r.id AND rm.profile_id = p_user_id
    LEFT JOIN LATERAL (
      SELECT m.*
      FROM messages m
      WHERE m.room_id = r.id
      ORDER BY m.created_at DESC
      LIMIT 1
    ) lm ON TRUE
    LEFT JOIN profiles lm_sender ON lm_sender.id = lm.profile_id
    WHERE r.deleted_at IS NULL
      AND (p_include_archived OR rm.is_archived = FALSE)
      AND (p_cursor IS NULL OR COALESCE(r.last_message_at, r.updated_at) < p_cursor)
    ORDER BY
      rm.is_pinned DESC,
      COALESCE(r.last_message_at, r.updated_at) DESC
    LIMIT p_limit
  ) rooms;

  -- Get total unread count across all rooms
  SELECT COALESCE(SUM(rm.unread_count), 0)::INT
  INTO v_total_unread
  FROM room_members rm
  JOIN chat_rooms r ON r.id = rm.room_id
  WHERE rm.profile_id = p_user_id
    AND r.deleted_at IS NULL
    AND rm.is_muted = FALSE;

  -- Build result
  v_result := jsonb_build_object(
    'rooms', COALESCE(v_rooms, '[]'::JSONB),
    'total_unread', v_total_unread
  );

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_bff_messages_data TO authenticated;

-- =============================================================================
-- Function Comments
-- =============================================================================

COMMENT ON FUNCTION get_bff_messages_data IS 'BFF aggregation: Returns chat rooms with last messages and participant profiles in single call';

-- =============================================================================
-- Indexes for Messages BFF Performance
-- =============================================================================

-- Room members for user lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_members_user_room
  ON room_members(profile_id, room_id);

-- Room members for pinned/muted filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_room_members_pinned
  ON room_members(profile_id, is_pinned DESC, room_id)
  WHERE is_archived = FALSE;

-- Messages for last message lookup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_room_latest
  ON messages(room_id, created_at DESC);

-- Chat rooms for active rooms
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_rooms_active
  ON chat_rooms(last_message_at DESC)
  WHERE deleted_at IS NULL;
