-- Migration: Notification Center Enhancements
-- Description: RPC functions and indexes for enterprise notification center
-- Created: 2026-01-31

-- ============================================================================
-- INDEX: Fast unread count queries
-- ============================================================================

-- Partial index for unread notifications (only indexes unread = false)
-- This significantly speeds up unread count queries
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
ON user_notifications(recipient_id, is_read)
WHERE is_read = false;

-- Index for recent notifications query (ordered by created_at)
CREATE INDEX IF NOT EXISTS idx_user_notifications_recent
ON user_notifications(recipient_id, created_at DESC);

-- ============================================================================
-- FUNCTION: Mark single notification as read
-- ============================================================================

CREATE OR REPLACE FUNCTION mark_notification_read(
    p_notification_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated BOOLEAN := FALSE;
BEGIN
    -- Update the notification if it belongs to the user
    UPDATE user_notifications
    SET
        is_read = TRUE,
        read_at = NOW(),
        updated_at = NOW()
    WHERE id = p_notification_id
      AND recipient_id = p_user_id
      AND is_read = FALSE;

    -- Check if we updated anything
    IF FOUND THEN
        v_updated := TRUE;
    END IF;

    RETURN v_updated;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION mark_notification_read(UUID, UUID) TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION mark_notification_read IS
'Marks a single notification as read. Returns TRUE if updated, FALSE if already read or not found.';

-- ============================================================================
-- FUNCTION: Mark all notifications as read
-- ============================================================================

CREATE OR REPLACE FUNCTION mark_all_notifications_read(
    p_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    -- Update all unread notifications for the user
    UPDATE user_notifications
    SET
        is_read = TRUE,
        read_at = NOW(),
        updated_at = NOW()
    WHERE recipient_id = p_user_id
      AND is_read = FALSE;

    -- Get the count of updated rows
    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION mark_all_notifications_read(UUID) TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION mark_all_notifications_read IS
'Marks all unread notifications as read for a user. Returns the count of updated notifications.';

-- ============================================================================
-- FUNCTION: Get recent notifications for dropdown
-- ============================================================================

CREATE OR REPLACE FUNCTION get_recent_notifications(
    p_user_id UUID,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    recipient_id UUID,
    actor_id UUID,
    type TEXT,
    title TEXT,
    body TEXT,
    post_id INTEGER,
    room_id UUID,
    review_id UUID,
    data JSONB,
    is_read BOOLEAN,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    actor_nickname TEXT,
    actor_avatar_url TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        n.id,
        n.recipient_id,
        n.actor_id,
        n.type::TEXT,
        n.title,
        n.body,
        n.post_id,
        n.room_id,
        n.review_id,
        n.data,
        n.is_read,
        n.read_at,
        n.created_at,
        n.updated_at,
        p.nickname AS actor_nickname,
        p.avatar_url AS actor_avatar_url
    FROM user_notifications n
    LEFT JOIN profiles p ON p.id = n.actor_id
    WHERE n.recipient_id = p_user_id
      -- Exclude notifications from blocked users
      AND NOT EXISTS (
          SELECT 1 FROM blocked_users bu
          WHERE (bu.user_id = p_user_id AND bu.blocked_user_id = n.actor_id)
             OR (bu.user_id = n.actor_id AND bu.blocked_user_id = p_user_id)
      )
    ORDER BY n.created_at DESC
    LIMIT p_limit;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_recent_notifications(UUID, INTEGER) TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION get_recent_notifications IS
'Gets recent notifications for the dropdown panel. Excludes notifications from blocked users.';

-- ============================================================================
-- FUNCTION: Get unread notification count (optimized)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_unread_notification_count(
    p_user_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER INTO v_count
    FROM user_notifications n
    WHERE n.recipient_id = p_user_id
      AND n.is_read = FALSE
      -- Exclude notifications from blocked users
      AND NOT EXISTS (
          SELECT 1 FROM blocked_users bu
          WHERE (bu.user_id = p_user_id AND bu.blocked_user_id = n.actor_id)
             OR (bu.user_id = n.actor_id AND bu.blocked_user_id = p_user_id)
      );

    RETURN COALESCE(v_count, 0);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_unread_notification_count(UUID) TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION get_unread_notification_count IS
'Gets the count of unread notifications for a user. Excludes notifications from blocked users.';

-- ============================================================================
-- FUNCTION: Delete notification
-- ============================================================================

CREATE OR REPLACE FUNCTION delete_notification(
    p_notification_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted BOOLEAN := FALSE;
BEGIN
    -- Delete the notification if it belongs to the user
    DELETE FROM user_notifications
    WHERE id = p_notification_id
      AND recipient_id = p_user_id;

    -- Check if we deleted anything
    IF FOUND THEN
        v_deleted := TRUE;
    END IF;

    RETURN v_deleted;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION delete_notification(UUID, UUID) TO authenticated;

-- Add comment for documentation
COMMENT ON FUNCTION delete_notification IS
'Deletes a notification. Returns TRUE if deleted, FALSE if not found or not owned by user.';

-- ============================================================================
-- ENABLE REALTIME
-- ============================================================================

-- Enable realtime for user_notifications table (if not already enabled)
DO $$
BEGIN
    -- Check if the table is already in the realtime publication
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'user_notifications'
    ) THEN
        -- Add table to realtime publication
        ALTER PUBLICATION supabase_realtime ADD TABLE user_notifications;
    END IF;
EXCEPTION
    WHEN undefined_object THEN
        -- Publication doesn't exist, create it (shouldn't happen in Supabase)
        RAISE NOTICE 'supabase_realtime publication does not exist';
END;
$$;

-- ============================================================================
-- RLS POLICIES (ensure they exist)
-- ============================================================================

-- Enable RLS if not already enabled
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own notifications
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'user_notifications'
        AND policyname = 'Users can view own notifications'
    ) THEN
        CREATE POLICY "Users can view own notifications"
            ON user_notifications
            FOR SELECT
            TO authenticated
            USING (recipient_id = auth.uid());
    END IF;
END;
$$;

-- Policy: Users can update their own notifications
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'user_notifications'
        AND policyname = 'Users can update own notifications'
    ) THEN
        CREATE POLICY "Users can update own notifications"
            ON user_notifications
            FOR UPDATE
            TO authenticated
            USING (recipient_id = auth.uid())
            WITH CHECK (recipient_id = auth.uid());
    END IF;
END;
$$;

-- Policy: Users can delete their own notifications
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'user_notifications'
        AND policyname = 'Users can delete own notifications'
    ) THEN
        CREATE POLICY "Users can delete own notifications"
            ON user_notifications
            FOR DELETE
            TO authenticated
            USING (recipient_id = auth.uid());
    END IF;
END;
$$;

-- ============================================================================
-- ANALYTICS: Notification center usage tracking (optional)
-- ============================================================================

-- Create analytics event type if needed
DO $$
BEGIN
    -- This is a placeholder for any analytics tracking you may want to add
    -- For now, we'll just add a comment
    NULL;
END;
$$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

COMMENT ON INDEX idx_user_notifications_unread IS
'Partial index for fast unread notification queries';

COMMENT ON INDEX idx_user_notifications_recent IS
'Index for fast recent notifications ordering';
