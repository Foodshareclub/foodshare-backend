-- Migration: Add Blocking Filter to All RPC Functions
-- Purpose: Filter blocked users from all content queries (Apple App Review requirement)
-- Date: 2026-01-28
-- Status: PRODUCTION READY

-- ============================================================================
-- 1. UPDATE get_user_rooms - Filter blocked users from messaging
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_rooms(
    p_user_id uuid,
    p_search_query text DEFAULT NULL,
    p_filter_type text DEFAULT 'all',
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
            CASE
                WHEN r.last_message_sent_by IS NOT NULL
                     AND r.last_message_sent_by != p_user_id
                     AND (r.last_message_seen_by IS NULL OR r.last_message_seen_by != p_user_id)
                THEN TRUE
                ELSE FALSE
            END AS has_unread,
            CASE WHEN r.sharer = p_user_id THEN 'sharer' ELSE 'requester' END AS user_role,
            -- Determine the other user in the conversation
            CASE WHEN r.sharer = p_user_id THEN r.requester ELSE r.sharer END AS other_user_id
        FROM rooms r
        WHERE
            (r.sharer = p_user_id OR r.requester = p_user_id)
            -- ✅ BLOCKING FILTER: Exclude rooms with blocked users
            AND NOT is_blocked_by_user(
                p_user_id,
                CASE WHEN r.sharer = p_user_id THEN r.requester ELSE r.sharer END
            )
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
                ELSE TRUE
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

-- ============================================================================
-- 2. CREATE/UPDATE get_nearby_posts - Filter blocked users from feed
-- ============================================================================

CREATE OR REPLACE FUNCTION get_nearby_posts(
    p_user_id UUID,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius_meters INT DEFAULT 5000,
    p_post_type TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS TABLE(
    id INT,
    profile_id UUID,
    post_name TEXT,
    post_description TEXT,
    post_type TEXT,
    pickup_time TEXT,
    available_hours TEXT,
    post_address TEXT,
    post_stripped_address TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    images TEXT[],
    is_active BOOLEAN,
    is_arranged BOOLEAN,
    post_arranged_to UUID,
    post_arranged_at TIMESTAMPTZ,
    post_views INT,
    post_like_counter INT,
    has_pantry BOOLEAN,
    condition TEXT,
    network TEXT,
    website TEXT,
    donation BOOLEAN,
    donation_rules TEXT,
    category_id INT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    distance_meters DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id,
        p.profile_id,
        p.post_name,
        p.post_description,
        p.post_type,
        p.pickup_time,
        p.available_hours,
        p.post_address,
        p.post_stripped_address,
        p.latitude,
        p.longitude,
        p.images,
        p.is_active,
        p.is_arranged,
        p.post_arranged_to,
        p.post_arranged_at,
        p.post_views,
        p.post_like_counter,
        p.has_pantry,
        p.condition,
        p.network,
        p.website,
        p.donation,
        p.donation_rules,
        p.category_id,
        p.created_at,
        p.updated_at,
        ST_Distance(
            ST_MakePoint(p.longitude, p.latitude)::geography,
            ST_MakePoint(p_longitude, p_latitude)::geography
        ) AS distance_meters
    FROM posts_with_location p
    WHERE
        p.is_active = true
        AND p.is_arranged = false
        AND (p_post_type IS NULL OR p.post_type = p_post_type)
        AND p.latitude IS NOT NULL
        AND p.longitude IS NOT NULL
        AND ST_DWithin(
            ST_MakePoint(p.longitude, p.latitude)::geography,
            ST_MakePoint(p_longitude, p_latitude)::geography,
            p_radius_meters
        )
        -- ✅ BLOCKING FILTER: Exclude posts from blocked users
        AND NOT is_blocked_by_user(p_user_id, p.profile_id)
    ORDER BY distance_meters ASC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- ============================================================================
-- 3. UPDATE get_paginated_notifications - Filter blocked users
-- ============================================================================

CREATE OR REPLACE FUNCTION get_paginated_notifications(
    p_user_id UUID,
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH filtered_notifications AS (
        SELECT
            n.id,
            n.recipient_id,
            n.actor_id,
            n.type,
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
            jsonb_build_object(
                'id', p.id,
                'nickname', p.nickname,
                'avatar_url', p.avatar_url
            ) AS actor_profile
        FROM user_notifications n
        LEFT JOIN profiles p ON p.id = n.actor_id
        WHERE
            n.recipient_id = p_user_id
            -- ✅ BLOCKING FILTER: Exclude notifications from blocked users
            AND (n.actor_id IS NULL OR NOT is_blocked_by_user(p_user_id, n.actor_id))
        ORDER BY n.created_at DESC
        LIMIT p_limit
        OFFSET p_offset
    )
    SELECT jsonb_build_object(
        'notifications', COALESCE(
            (SELECT jsonb_agg(to_jsonb(fn.*)) FROM filtered_notifications fn),
            '[]'::jsonb
        ),
        'unreadCount', (
            SELECT COUNT(*)
            FROM user_notifications
            WHERE recipient_id = p_user_id
              AND is_read = false
              AND (actor_id IS NULL OR NOT is_blocked_by_user(p_user_id, actor_id))
        ),
        'totalCount', (
            SELECT COUNT(*)
            FROM user_notifications
            WHERE recipient_id = p_user_id
              AND (actor_id IS NULL OR NOT is_blocked_by_user(p_user_id, actor_id))
        ),
        'hasMore', (
            SELECT COUNT(*) > p_offset + p_limit
            FROM user_notifications
            WHERE recipient_id = p_user_id
              AND (actor_id IS NULL OR NOT is_blocked_by_user(p_user_id, actor_id))
        )
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- 4. UPDATE get_reviews_with_average - Filter blocked users
-- ============================================================================

CREATE OR REPLACE FUNCTION get_reviews_with_average(
    p_post_id INT,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH filtered_reviews AS (
        SELECT
            r.id,
            r.post_id,
            r.profile_id,
            r.rating,
            r.comment,
            r.created_at,
            r.updated_at,
            jsonb_build_object(
                'id', p.id,
                'nickname', p.nickname,
                'avatar_url', p.avatar_url,
                'is_verified', p.is_verified
            ) AS profiles
        FROM reviews r
        LEFT JOIN profiles p ON p.id = r.profile_id
        WHERE
            r.post_id = p_post_id
            -- ✅ BLOCKING FILTER: Exclude reviews from blocked users (if user_id provided)
            AND (p_user_id IS NULL OR NOT is_blocked_by_user(p_user_id, r.profile_id))
        ORDER BY r.created_at DESC
    )
    SELECT jsonb_build_object(
        'reviews', COALESCE(
            (SELECT jsonb_agg(to_jsonb(fr.*)) FROM filtered_reviews fr),
            '[]'::jsonb
        ),
        'averageRating', COALESCE(
            (SELECT AVG(rating) FROM filtered_reviews),
            0.0
        ),
        'totalCount', (SELECT COUNT(*) FROM filtered_reviews)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION get_user_reviews_with_average(
    p_user_id UUID,
    p_viewer_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_result JSONB;
BEGIN
    WITH filtered_reviews AS (
        SELECT
            r.id,
            r.post_id,
            r.profile_id,
            r.rating,
            r.comment,
            r.created_at,
            r.updated_at,
            jsonb_build_object(
                'id', p.id,
                'nickname', p.nickname,
                'avatar_url', p.avatar_url,
                'is_verified', p.is_verified
            ) AS profiles
        FROM reviews r
        LEFT JOIN profiles p ON p.id = r.profile_id
        INNER JOIN posts po ON po.id = r.post_id
        WHERE
            po.profile_id = p_user_id
            -- ✅ BLOCKING FILTER: Exclude reviews from blocked users (if viewer_id provided)
            AND (p_viewer_id IS NULL OR NOT is_blocked_by_user(p_viewer_id, r.profile_id))
        ORDER BY r.created_at DESC
    )
    SELECT jsonb_build_object(
        'reviews', COALESCE(
            (SELECT jsonb_agg(to_jsonb(fr.*)) FROM filtered_reviews fr),
            '[]'::jsonb
        ),
        'averageRating', COALESCE(
            (SELECT AVG(rating) FROM filtered_reviews),
            0.0
        ),
        'totalCount', (SELECT COUNT(*) FROM filtered_reviews)
    ) INTO v_result;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- 5. CREATE prevent_blocked_user_messaging - Trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_blocked_user_messaging()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_other_user_id UUID;
BEGIN
    -- Determine the other user in the room
    SELECT CASE
        WHEN sharer = NEW.profile_id THEN requester
        ELSE sharer
    END INTO v_other_user_id
    FROM rooms
    WHERE id = NEW.room_id;

    -- Check if users have blocked each other
    IF is_blocked_by_user(NEW.profile_id, v_other_user_id) THEN
        RAISE EXCEPTION 'Cannot send message to blocked user'
            USING ERRCODE = 'P0001',
                  HINT = 'User has been blocked';
    END IF;

    RETURN NEW;
END;
$$;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_prevent_blocked_messaging ON room_participants;

-- Create trigger on room_participants (messages)
CREATE TRIGGER trigger_prevent_blocked_messaging
    BEFORE INSERT ON room_participants
    FOR EACH ROW
    EXECUTE FUNCTION prevent_blocked_user_messaging();

-- ============================================================================
-- 6. CREATE prevent_blocked_room_creation - Trigger function
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_blocked_room_creation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Check if users have blocked each other
    IF is_blocked_by_user(NEW.sharer, NEW.requester) THEN
        RAISE EXCEPTION 'Cannot create room with blocked user'
            USING ERRCODE = 'P0001',
                  HINT = 'User has been blocked';
    END IF;

    RETURN NEW;
END;
$$;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_prevent_blocked_room_creation ON rooms;

-- Create trigger on rooms
CREATE TRIGGER trigger_prevent_blocked_room_creation
    BEFORE INSERT ON rooms
    FOR EACH ROW
    EXECUTE FUNCTION prevent_blocked_room_creation();

-- ============================================================================
-- 7. UPDATE get_or_create_room - Add blocking check
-- ============================================================================

CREATE OR REPLACE FUNCTION get_or_create_room(
    p_post_id INT,
    p_sharer_id UUID,
    p_requester_id UUID
)
RETURNS TABLE(
    id UUID,
    post_id INT,
    sharer UUID,
    requester UUID,
    last_message TEXT,
    last_message_time TIMESTAMPTZ,
    last_message_sent_by UUID,
    last_message_seen_by UUID,
    post_arranged_to UUID,
    email_to TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- ✅ BLOCKING CHECK: Prevent room creation with blocked users
    IF is_blocked_by_user(p_sharer_id, p_requester_id) THEN
        RAISE EXCEPTION 'Cannot create room with blocked user'
            USING ERRCODE = 'P0001',
                  HINT = 'User has been blocked';
    END IF;

    -- Try to find existing room
    RETURN QUERY
    SELECT
        r.id,
        r.post_id,
        r.sharer,
        r.requester,
        r.last_message,
        r.last_message_time,
        r.last_message_sent_by,
        r.last_message_seen_by,
        r.post_arranged_to,
        r.email_to
    FROM rooms r
    WHERE
        r.post_id = p_post_id
        AND r.sharer = p_sharer_id
        AND r.requester = p_requester_id
    LIMIT 1;

    -- If no room found, create one
    IF NOT FOUND THEN
        RETURN QUERY
        INSERT INTO rooms (post_id, sharer, requester)
        VALUES (p_post_id, p_sharer_id, p_requester_id)
        RETURNING
            rooms.id,
            rooms.post_id,
            rooms.sharer,
            rooms.requester,
            rooms.last_message,
            rooms.last_message_time,
            rooms.last_message_sent_by,
            rooms.last_message_seen_by,
            rooms.post_arranged_to,
            rooms.email_to;
    END IF;
END;
$$;

-- ============================================================================
-- Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_user_rooms TO authenticated;
GRANT EXECUTE ON FUNCTION get_nearby_posts TO authenticated;
GRANT EXECUTE ON FUNCTION get_paginated_notifications TO authenticated;
GRANT EXECUTE ON FUNCTION get_reviews_with_average TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_reviews_with_average TO authenticated;
GRANT EXECUTE ON FUNCTION get_or_create_room TO authenticated;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON FUNCTION get_user_rooms IS 'Fetches user rooms with blocking filter applied';
COMMENT ON FUNCTION get_nearby_posts IS 'Fetches nearby posts with blocking filter applied';
COMMENT ON FUNCTION get_paginated_notifications IS 'Fetches notifications with blocking filter applied';
COMMENT ON FUNCTION get_reviews_with_average IS 'Fetches reviews with blocking filter applied';
COMMENT ON FUNCTION get_user_reviews_with_average IS 'Fetches user reviews with blocking filter applied';
COMMENT ON FUNCTION prevent_blocked_user_messaging IS 'Prevents messages to/from blocked users';
COMMENT ON FUNCTION prevent_blocked_room_creation IS 'Prevents room creation with blocked users';
COMMENT ON FUNCTION get_or_create_room IS 'Creates or retrieves room with blocking check';
