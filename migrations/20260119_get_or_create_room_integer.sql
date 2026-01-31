-- get_or_create_room (integer version): Atomic UPSERT pattern for room creation
-- Returns jsonb format for API compatibility
-- Note: A bigint version also exists in 20251229190300_get_or_create_room.sql

CREATE OR REPLACE FUNCTION public.get_or_create_room(p_post_id integer, p_sharer_id uuid, p_requester_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_room_id uuid;
  v_room jsonb;
  v_created boolean := false;
BEGIN
  -- Prevent owner from creating room with themselves
  IF p_sharer_id = p_requester_id THEN
    RAISE EXCEPTION 'Cannot create a chat room with yourself' USING ERRCODE = '23514';
  END IF;

  -- Try to find existing room
  SELECT id INTO v_room_id
  FROM rooms
  WHERE post_id = p_post_id
    AND sharer = p_sharer_id
    AND requester = p_requester_id
  LIMIT 1;

  -- If not found, create new room
  IF v_room_id IS NULL THEN
    INSERT INTO rooms (post_id, sharer, requester)
    VALUES (p_post_id, p_sharer_id, p_requester_id)
    RETURNING id INTO v_room_id;
    v_created := true;
  END IF;

  -- Fetch full room data
  SELECT jsonb_build_object(
    'id', r.id,
    'post_id', r.post_id,
    'sharer', r.sharer,
    'requester', r.requester,
    'last_message', r.last_message,
    'last_message_time', r.last_message_time,
    'sharer_last_seen', r.sharer_last_seen,
    'requester_last_seen', r.requester_last_seen,
    'is_archived', r.is_archived,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'created', v_created
  )
  INTO v_room
  FROM rooms r
  WHERE r.id = v_room_id;

  RETURN v_room;
END;
$function$;
