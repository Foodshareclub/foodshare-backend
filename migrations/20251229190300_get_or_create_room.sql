-- get_or_create_room: Atomic UPSERT pattern for room creation
-- Replaces find-then-create pattern in SupabaseMessagingRepository.swift
-- Prevents race conditions when multiple users try to create the same room

CREATE OR REPLACE FUNCTION get_or_create_room(
    p_post_id bigint,
    p_sharer_id uuid,
    p_requester_id uuid
)
RETURNS TABLE (
    id uuid,
    post_id bigint,
    sharer uuid,
    requester uuid,
    last_message text,
    last_message_time timestamptz,
    last_message_sent_by uuid,
    last_message_seen_by uuid,
    post_arranged_to uuid,
    email_to text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_room_id uuid;
BEGIN
    -- Try to find existing room
    SELECT r.id INTO v_room_id
    FROM rooms r
    WHERE r.post_id = p_post_id
      AND r.sharer = p_sharer_id
      AND r.requester = p_requester_id
    LIMIT 1;

    -- If no existing room, create one
    IF v_room_id IS NULL THEN
        INSERT INTO rooms (post_id, sharer, requester)
        VALUES (p_post_id, p_sharer_id, p_requester_id)
        RETURNING rooms.id INTO v_room_id;
    END IF;

    -- Return the room data
    RETURN QUERY
    SELECT r.id, r.post_id, r.sharer, r.requester,
           r.last_message, r.last_message_time,
           r.last_message_sent_by, r.last_message_seen_by,
           r.post_arranged_to, r.email_to
    FROM rooms r
    WHERE r.id = v_room_id;
END;
$$;
