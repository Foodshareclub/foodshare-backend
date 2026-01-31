-- Fix get_batch_engagement_status Function Overload Conflict
-- There are two versions of this function causing PostgREST error PGRST203:
-- 1. get_batch_engagement_status(p_post_ids => integer[])
-- 2. get_batch_engagement_status(p_post_ids => integer[], p_profile_id => uuid)
--
-- The iOS app calls with only p_post_ids, but PostgREST can't resolve the overload.
-- Solution: Drop the 2-param version and keep the 1-param version that uses auth.uid()

-- ============================================================================
-- 1. Drop the overloaded 2-parameter version (if it exists)
-- ============================================================================

DROP FUNCTION IF EXISTS get_batch_engagement_status(INTEGER[], UUID);

-- ============================================================================
-- 2. Recreate the single-parameter version (idempotent)
-- ============================================================================

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

-- ============================================================================
-- 3. Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO anon;

-- ============================================================================
-- 4. Add documentation
-- ============================================================================

COMMENT ON FUNCTION get_batch_engagement_status(INTEGER[]) IS
    'Get engagement status (likes, bookmarks, counts) for multiple posts. Uses auth.uid() for current user. Fixed overload conflict 2026-01-31.';
