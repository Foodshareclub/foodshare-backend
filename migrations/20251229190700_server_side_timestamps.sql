-- Server-side timestamp functions
-- Ensures consistent timestamps across clients

-- update_room_last_message: Updates room with server-side timestamp
CREATE OR REPLACE FUNCTION update_room_last_message(
    p_room_id uuid,
    p_message text,
    p_sent_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE rooms
    SET
        last_message = p_message,
        last_message_time = NOW(),
        last_message_sent_by = p_sent_by
    WHERE id = p_room_id;
END;
$$;

-- mark_notifications_read: Marks notifications as read with server-side timestamp
CREATE OR REPLACE FUNCTION mark_notifications_read(
    p_notification_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE notifications
    SET read_at = NOW()
    WHERE id = ANY(p_notification_ids)
      AND read_at IS NULL;
END;
$$;

-- mark_all_notifications_read: Marks all user's notifications as read
CREATE OR REPLACE FUNCTION mark_all_notifications_read(
    p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE notifications
    SET read_at = NOW()
    WHERE profile_id = p_user_id
      AND read_at IS NULL;
END;
$$;
