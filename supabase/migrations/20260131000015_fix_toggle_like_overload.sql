-- Fix toggle_like Function Overload Conflict
-- PostgREST error PGRST203: Two versions with different signatures
-- Solution: Drop all versions and recreate the single auth.uid() version

-- ============================================================================
-- 1. Drop ALL versions of toggle_like to clear overload
-- ============================================================================

DROP FUNCTION IF EXISTS toggle_like(INTEGER);
DROP FUNCTION IF EXISTS toggle_like(INTEGER, UUID);
DROP FUNCTION IF EXISTS public.toggle_like(INTEGER);
DROP FUNCTION IF EXISTS public.toggle_like(INTEGER, UUID);

-- ============================================================================
-- 2. Recreate the canonical version (uses auth.uid(), unified likes table)
-- ============================================================================

CREATE OR REPLACE FUNCTION toggle_like(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_existing_id INTEGER;
    v_is_liked BOOLEAN;
    v_like_count INTEGER;
    v_post_owner_id UUID;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    -- Get post owner for notification
    SELECT profile_id INTO v_post_owner_id FROM posts WHERE id = p_post_id;

    IF v_post_owner_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found'));
    END IF;

    -- Check existing like in unified likes table
    SELECT id INTO v_existing_id FROM likes
    WHERE post_id = p_post_id AND profile_id = v_user_id
      AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0;

    IF v_existing_id IS NOT NULL THEN
        -- Unlike: remove the like
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;

        -- Decrement counter atomically
        UPDATE posts SET post_like_counter = GREATEST(COALESCE(post_like_counter, 0) - 1, 0)
        WHERE id = p_post_id;
    ELSE
        -- Like: add a new like
        INSERT INTO likes (post_id, profile_id, forum_id, challenge_id, comment_id)
        VALUES (p_post_id, v_user_id, 0, 0, 0);
        v_is_liked := true;

        -- Increment counter atomically
        UPDATE posts SET post_like_counter = COALESCE(post_like_counter, 0) + 1
        WHERE id = p_post_id;

        -- Create notification for post owner (if not self-like)
        IF v_post_owner_id != v_user_id THEN
            INSERT INTO notifications (profile_id, type, data)
            VALUES (v_post_owner_id, 'post_liked', jsonb_build_object(
                'post_id', p_post_id,
                'liker_id', v_user_id
            ))
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- Get final like count
    SELECT COALESCE(post_like_counter, 0) INTO v_like_count FROM posts WHERE id = p_post_id;

    RETURN json_build_object(
        'success', true,
        'is_liked', v_is_liked,
        'like_count', v_like_count
    );
END;
$$;

-- ============================================================================
-- 3. Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION toggle_like(INTEGER) TO authenticated;

-- ============================================================================
-- 4. Also fix get_batch_engagement_status to use unified tables
-- ============================================================================

DROP FUNCTION IF EXISTS get_batch_engagement_status(INTEGER[]);
DROP FUNCTION IF EXISTS get_batch_engagement_status(INTEGER[], UUID);

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
    v_user_id := auth.uid();

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

    -- Use unified likes and bookmarks tables
    SELECT json_build_object(
        'success', true,
        'statuses', COALESCE(json_agg(
            json_build_object(
                'post_id', p.id,
                'is_liked', COALESCE(ul.is_liked, false),
                'is_bookmarked', COALESCE(ub.is_bookmarked, false),
                'like_count', COALESCE(lc.like_count, 0)
            )
        ), '[]'::json)
    ) INTO v_result
    FROM unnest(p_post_ids) AS p(id)
    LEFT JOIN (
        SELECT post_id, true as is_liked
        FROM likes
        WHERE profile_id = v_user_id
          AND post_id = ANY(p_post_ids)
          AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0
    ) ul ON ul.post_id = p.id
    LEFT JOIN (
        SELECT post_id, true as is_bookmarked
        FROM bookmarks
        WHERE profile_id = v_user_id
          AND post_id = ANY(p_post_ids)
          AND forum_id = 0
    ) ub ON ub.post_id = p.id
    LEFT JOIN (
        SELECT post_id, COUNT(*) as like_count
        FROM likes
        WHERE post_id = ANY(p_post_ids)
          AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0
        GROUP BY post_id
    ) lc ON lc.post_id = p.id;

    RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO anon;

COMMENT ON FUNCTION toggle_like(INTEGER) IS
    'Toggle like on a post. Uses unified likes table. Returns is_liked and like_count.';

COMMENT ON FUNCTION get_batch_engagement_status(INTEGER[]) IS
    'Get engagement status for multiple posts. Uses unified likes/bookmarks tables.';
