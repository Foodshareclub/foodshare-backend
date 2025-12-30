-- get_user_rooms: Fetches user's rooms with server-side filtering and sorting
-- Reduces client-side processing for messaging list
-- Used by MessagingViewModel.loadRooms()

CREATE OR REPLACE FUNCTION get_user_rooms(
    p_user_id uuid,
    p_search_query text DEFAULT NULL,
    p_filter_type text DEFAULT 'all', -- 'all', 'unread', 'sharing', 'receiving'
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH filtered_rooms AS (
        SELECT
            r.*,
            -- Unread: last message wasn't sent by this user AND wasn't seen by this user
            CASE
                WHEN r.last_message_sent_by IS NOT NULL
                     AND r.last_message_sent_by != p_user_id
                     AND (r.last_message_seen_by IS NULL OR r.last_message_seen_by != p_user_id)
                THEN TRUE
                ELSE FALSE
            END AS has_unread,
            -- Role in conversation
            CASE WHEN r.sharer = p_user_id THEN 'sharer' ELSE 'requester' END AS user_role
        FROM rooms r
        WHERE
            -- User must be participant
            (r.sharer = p_user_id OR r.requester = p_user_id)
            -- Optional text search on last_message
            AND (
                p_search_query IS NULL
                OR p_search_query = ''
                OR r.last_message ILIKE '%' || p_search_query || '%'
            )
    ),
    type_filtered AS (
        SELECT *
        FROM filtered_rooms
        WHERE
            CASE p_filter_type
                WHEN 'unread' THEN has_unread = TRUE
                WHEN 'sharing' THEN user_role = 'sharer'
                WHEN 'receiving' THEN user_role = 'requester'
                ELSE TRUE -- 'all'
            END
    )
    SELECT jsonb_build_object(
        'success', true,
        'rooms', COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', tr.id,
                    'postId', tr.post_id,
                    'sharer', tr.sharer,
                    'requester', tr.requester,
                    'lastMessage', tr.last_message,
                    'lastMessageTime', tr.last_message_time,
                    'lastMessageSentBy', tr.last_message_sent_by,
                    'lastMessageSeenBy', tr.last_message_seen_by,
                    'postArrangedTo', tr.post_arranged_to,
                    'emailTo', tr.email_to,
                    'hasUnread', tr.has_unread,
                    'userRole', tr.user_role
                ) ORDER BY tr.last_message_time DESC NULLS LAST
            ) FROM type_filtered tr),
            '[]'::jsonb
        ),
        'totalCount', (SELECT COUNT(*) FROM type_filtered),
        'unreadCount', (SELECT COUNT(*) FROM filtered_rooms WHERE has_unread = TRUE),
        'pagination', jsonb_build_object(
            'limit', p_limit,
            'offset', p_offset,
            'hasMore', (SELECT COUNT(*) FROM type_filtered) > p_offset + p_limit
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$;
