-- Engagement RPC Functions for iOS App
-- Creates the missing toggle_like, toggle_bookmark, and get_batch_engagement_status functions

-- Toggle Like RPC Function
CREATE OR REPLACE FUNCTION toggle_like(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_existing_like_id INTEGER;
    v_is_liked BOOLEAN;
    v_like_count INTEGER;
    v_post_owner_id UUID;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required')
        );
    END IF;

    -- Check if post exists and get owner
    SELECT profile_id INTO v_post_owner_id 
    FROM posts 
    WHERE id = p_post_id;
    
    IF v_post_owner_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found')
        );
    END IF;

    -- Check if already liked
    SELECT id INTO v_existing_like_id
    FROM post_likes
    WHERE post_id = p_post_id AND profile_id = v_user_id;

    IF v_existing_like_id IS NOT NULL THEN
        -- Unlike
        DELETE FROM post_likes WHERE id = v_existing_like_id;
        v_is_liked := false;
    ELSE
        -- Like
        INSERT INTO post_likes (post_id, profile_id) 
        VALUES (p_post_id, v_user_id);
        v_is_liked := true;
    END IF;

    -- Get updated count
    SELECT COUNT(*) INTO v_like_count
    FROM post_likes
    WHERE post_id = p_post_id;

    RETURN json_build_object(
        'success', true,
        'is_liked', v_is_liked,
        'like_count', v_like_count,
        'post_owner_id', v_post_owner_id
    );
END;
$$;

-- Toggle Bookmark RPC Function
CREATE OR REPLACE FUNCTION toggle_bookmark(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_existing_bookmark_id INTEGER;
    v_is_bookmarked BOOLEAN;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required')
        );
    END IF;

    -- Check if post exists
    IF NOT EXISTS (SELECT 1 FROM posts WHERE id = p_post_id) THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found')
        );
    END IF;

    -- Check if already bookmarked
    SELECT id INTO v_existing_bookmark_id
    FROM post_bookmarks
    WHERE post_id = p_post_id AND profile_id = v_user_id;

    IF v_existing_bookmark_id IS NOT NULL THEN
        -- Remove bookmark
        DELETE FROM post_bookmarks WHERE id = v_existing_bookmark_id;
        v_is_bookmarked := false;
    ELSE
        -- Add bookmark
        INSERT INTO post_bookmarks (post_id, profile_id) 
        VALUES (p_post_id, v_user_id);
        v_is_bookmarked := true;
    END IF;

    RETURN json_build_object(
        'success', true,
        'is_bookmarked', v_is_bookmarked
    );
END;
$$;

-- Batch Engagement Status RPC Function
CREATE OR REPLACE FUNCTION get_batch_engagement_status(p_post_ids INTEGER[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_result JSON;
BEGIN
    -- Get current user (can be null for anonymous requests)
    v_user_id := auth.uid();

    -- Validate input
    IF array_length(p_post_ids, 1) IS NULL OR array_length(p_post_ids, 1) = 0 THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'INVALID_INPUT', 'message', 'Post IDs required')
        );
    END IF;

    IF array_length(p_post_ids, 1) > 100 THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'TOO_MANY_POSTS', 'message', 'Maximum 100 posts allowed')
        );
    END IF;

    -- Build result with engagement data
    SELECT json_build_object(
        'success', true,
        'statuses', json_agg(
            json_build_object(
                'post_id', p.id,
                'is_liked', COALESCE(ul.is_liked, false),
                'is_bookmarked', COALESCE(ub.is_bookmarked, false),
                'like_count', COALESCE(lc.like_count, 0)
            )
        )
    ) INTO v_result
    FROM unnest(p_post_ids) AS p(id)
    LEFT JOIN (
        SELECT post_id, true as is_liked
        FROM post_likes
        WHERE profile_id = v_user_id AND post_id = ANY(p_post_ids)
    ) ul ON ul.post_id = p.id
    LEFT JOIN (
        SELECT post_id, true as is_bookmarked
        FROM post_bookmarks
        WHERE profile_id = v_user_id AND post_id = ANY(p_post_ids)
    ) ub ON ub.post_id = p.id
    LEFT JOIN (
        SELECT post_id, COUNT(*) as like_count
        FROM post_likes
        WHERE post_id = ANY(p_post_ids)
        GROUP BY post_id
    ) lc ON lc.post_id = p.id;

    RETURN v_result;
END;
$$;

-- Get User Bookmarks RPC Function
CREATE OR REPLACE FUNCTION get_user_bookmarks(p_limit INTEGER DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_result JSON;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required')
        );
    END IF;

    -- Validate limit
    IF p_limit > 100 THEN
        p_limit := 100;
    END IF;

    -- Get bookmarked post IDs
    SELECT json_build_object(
        'success', true,
        'post_ids', COALESCE(json_agg(post_id ORDER BY created_at DESC), '[]'::json),
        'total_count', COUNT(*),
        'has_more', COUNT(*) = p_limit
    ) INTO v_result
    FROM (
        SELECT post_id, created_at
        FROM post_bookmarks
        WHERE profile_id = v_user_id
        ORDER BY created_at DESC
        LIMIT p_limit
    ) bookmarks;

    RETURN v_result;
END;
$$;