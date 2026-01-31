-- Engagement RPC Functions v2 - Fresh deployment
-- Creates toggle_like, toggle_bookmark, and get_batch_engagement_status functions

-- Toggle Like RPC Function
CREATE OR REPLACE FUNCTION toggle_like(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

    -- Update the denormalized counter on posts table
    UPDATE posts SET post_like_counter = v_like_count WHERE id = p_post_id;

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
SET search_path = public
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

-- Get Batch Engagement Status RPC Function
CREATE OR REPLACE FUNCTION get_batch_engagement_status(p_post_ids INTEGER[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_result JSON;
BEGIN
    -- Get current user (optional - can work without auth)
    v_user_id := auth.uid();

    -- Limit to 100 posts
    IF array_length(p_post_ids, 1) > 100 THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'TOO_MANY_POSTS', 'message', 'Maximum 100 posts allowed')
        );
    END IF;

    -- Build result
    SELECT json_build_object(
        'success', true,
        'statuses', COALESCE(json_agg(status_row), '[]'::json)
    ) INTO v_result
    FROM (
        SELECT
            p.id as post_id,
            COALESCE((SELECT true FROM post_likes pl WHERE pl.post_id = p.id AND pl.profile_id = v_user_id LIMIT 1), false) as is_liked,
            COALESCE((SELECT true FROM post_bookmarks pb WHERE pb.post_id = p.id AND pb.profile_id = v_user_id LIMIT 1), false) as is_bookmarked,
            COALESCE(p.post_like_counter, 0) as like_count
        FROM unnest(p_post_ids) AS pid(id)
        JOIN posts p ON p.id = pid.id
    ) status_row;

    RETURN v_result;
END;
$$;

-- Get User Bookmarks RPC Function
CREATE OR REPLACE FUNCTION get_user_bookmarks(p_limit INTEGER DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_post_ids INTEGER[];
    v_total_count INTEGER;
BEGIN
    -- Get current user
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required')
        );
    END IF;

    -- Get bookmarked post IDs
    SELECT array_agg(post_id), COUNT(*)
    INTO v_post_ids, v_total_count
    FROM (
        SELECT post_id
        FROM post_bookmarks
        WHERE profile_id = v_user_id
        ORDER BY created_at DESC
        LIMIT p_limit
    ) sub;

    RETURN json_build_object(
        'success', true,
        'post_ids', COALESCE(v_post_ids, ARRAY[]::INTEGER[]),
        'total_count', COALESCE(v_total_count, 0),
        'has_more', v_total_count > p_limit
    );
END;
$$;
