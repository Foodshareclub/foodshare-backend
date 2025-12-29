-- ============================================================================
-- Engagement Operations RPC Functions
-- Phase 3: Ultra-Thin Client Architecture
-- ============================================================================
-- These functions consolidate multiple round trips into single atomic operations:
-- - toggle_like: Check + Insert/Delete + Count + Log in one call
-- - toggle_bookmark: Check + Insert/Delete + Log in one call
-- - get_batch_engagement_status: Batch fetch for feed lists
-- ============================================================================

-- ============================================================================
-- 1. Toggle Like RPC
-- ============================================================================
-- Replaces 3+ round trips with 1 atomic operation
-- Returns: { success, is_liked, like_count, post_owner_id }

CREATE OR REPLACE FUNCTION public.toggle_like(
    p_post_id INT,
    p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_existing_like_id INT;
    v_is_liked BOOLEAN;
    v_like_count INT;
    v_post_owner_id UUID;
    v_post_name TEXT;
BEGIN
    -- Use provided profile_id or get from auth context
    v_user_id := COALESCE(p_profile_id, auth.uid());

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_REQUIRED',
                'message', 'Authentication required to like posts'
            )
        );
    END IF;

    -- Get post info
    SELECT profile_id, post_name INTO v_post_owner_id, v_post_name
    FROM posts
    WHERE id = p_post_id AND is_active = true;

    IF v_post_owner_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'POST_NOT_FOUND',
                'message', 'Post not found or inactive'
            )
        );
    END IF;

    -- Check for existing like
    SELECT id INTO v_existing_like_id
    FROM likes
    WHERE post_id = p_post_id
      AND profile_id = v_user_id
      AND challenge_id = 0
      AND forum_id = 0;

    IF v_existing_like_id IS NOT NULL THEN
        -- Unlike: delete existing like
        DELETE FROM likes WHERE id = v_existing_like_id;
        v_is_liked := false;

        -- Log activity
        INSERT INTO post_activity_logs (post_id, actor_id, activity_type, metadata)
        VALUES (p_post_id, v_user_id, 'unliked', jsonb_build_object(
            'unliked_at', NOW()::TEXT
        ));
    ELSE
        -- Like: insert new like
        INSERT INTO likes (post_id, profile_id, challenge_id, forum_id)
        VALUES (p_post_id, v_user_id, 0, 0);
        v_is_liked := true;

        -- Log activity
        INSERT INTO post_activity_logs (post_id, actor_id, activity_type, metadata)
        VALUES (p_post_id, v_user_id, 'liked', jsonb_build_object(
            'liked_at', NOW()::TEXT
        ));
    END IF;

    -- Get updated like count
    SELECT COUNT(*) INTO v_like_count
    FROM likes
    WHERE post_id = p_post_id
      AND challenge_id = 0
      AND forum_id = 0;

    -- Update post's like counter (denormalized for performance)
    UPDATE posts
    SET post_like_counter = v_like_count
    WHERE id = p_post_id;

    RETURN jsonb_build_object(
        'success', true,
        'is_liked', v_is_liked,
        'like_count', v_like_count,
        'post_owner_id', v_post_owner_id
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.toggle_like TO authenticated;

COMMENT ON FUNCTION public.toggle_like IS
'Atomic toggle like operation. Replaces 3+ round trips with 1 call.
Returns: { success, is_liked, like_count, post_owner_id }';

-- ============================================================================
-- 2. Toggle Bookmark RPC
-- ============================================================================
-- Replaces 2+ round trips with 1 atomic operation
-- Returns: { success, is_bookmarked }

CREATE OR REPLACE FUNCTION public.toggle_bookmark(
    p_post_id INT,
    p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_existing_bookmark_id UUID;
    v_is_bookmarked BOOLEAN;
    v_post_exists BOOLEAN;
BEGIN
    -- Use provided profile_id or get from auth context
    v_user_id := COALESCE(p_profile_id, auth.uid());

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_REQUIRED',
                'message', 'Authentication required to bookmark posts'
            )
        );
    END IF;

    -- Verify post exists
    SELECT EXISTS(SELECT 1 FROM posts WHERE id = p_post_id AND is_active = true)
    INTO v_post_exists;

    IF NOT v_post_exists THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'POST_NOT_FOUND',
                'message', 'Post not found or inactive'
            )
        );
    END IF;

    -- Check for existing bookmark
    SELECT id INTO v_existing_bookmark_id
    FROM post_bookmarks
    WHERE post_id = p_post_id AND profile_id = v_user_id;

    IF v_existing_bookmark_id IS NOT NULL THEN
        -- Remove bookmark
        DELETE FROM post_bookmarks WHERE id = v_existing_bookmark_id;
        v_is_bookmarked := false;

        -- Log activity
        INSERT INTO post_activity_logs (post_id, actor_id, activity_type, metadata)
        VALUES (p_post_id, v_user_id, 'unbookmarked', jsonb_build_object(
            'unbookmarked_at', NOW()::TEXT
        ));
    ELSE
        -- Add bookmark
        INSERT INTO post_bookmarks (post_id, profile_id)
        VALUES (p_post_id, v_user_id);
        v_is_bookmarked := true;

        -- Log activity
        INSERT INTO post_activity_logs (post_id, actor_id, activity_type, metadata)
        VALUES (p_post_id, v_user_id, 'bookmarked', jsonb_build_object(
            'bookmarked_at', NOW()::TEXT
        ));
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'is_bookmarked', v_is_bookmarked
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.toggle_bookmark TO authenticated;

COMMENT ON FUNCTION public.toggle_bookmark IS
'Atomic toggle bookmark operation. Replaces 2+ round trips with 1 call.
Returns: { success, is_bookmarked }';

-- ============================================================================
-- 3. Batch Engagement Status RPC
-- ============================================================================
-- Optimized for feed views - gets all engagement data in one call
-- Returns: Array of { post_id, is_liked, is_bookmarked, like_count }

CREATE OR REPLACE FUNCTION public.get_batch_engagement_status(
    p_post_ids INT[],
    p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_result JSONB;
BEGIN
    -- Validate input
    IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'statuses', '[]'::JSONB
        );
    END IF;

    IF array_length(p_post_ids, 1) > 100 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'TOO_MANY_POSTS',
                'message', 'Maximum 100 posts per request'
            )
        );
    END IF;

    -- Use provided profile_id or get from auth context
    v_user_id := COALESCE(p_profile_id, auth.uid());

    -- Build engagement status for each post
    SELECT jsonb_agg(
        jsonb_build_object(
            'post_id', p.id,
            'is_liked', COALESCE(ul.is_liked, false),
            'is_bookmarked', COALESCE(ub.is_bookmarked, false),
            'like_count', COALESCE(lc.like_count, 0)
        )
        ORDER BY p.id
    )
    INTO v_result
    FROM unnest(p_post_ids) AS pid(id)
    INNER JOIN posts p ON p.id = pid.id
    -- Like counts
    LEFT JOIN LATERAL (
        SELECT COUNT(*) as like_count
        FROM likes l
        WHERE l.post_id = p.id
          AND l.challenge_id = 0
          AND l.forum_id = 0
    ) lc ON true
    -- User's like status
    LEFT JOIN LATERAL (
        SELECT true as is_liked
        FROM likes l
        WHERE l.post_id = p.id
          AND l.profile_id = v_user_id
          AND l.challenge_id = 0
          AND l.forum_id = 0
        LIMIT 1
    ) ul ON v_user_id IS NOT NULL
    -- User's bookmark status
    LEFT JOIN LATERAL (
        SELECT true as is_bookmarked
        FROM post_bookmarks b
        WHERE b.post_id = p.id
          AND b.profile_id = v_user_id
        LIMIT 1
    ) ub ON v_user_id IS NOT NULL;

    RETURN jsonb_build_object(
        'success', true,
        'statuses', COALESCE(v_result, '[]'::JSONB)
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Grant execute to authenticated and anon users (for public feed)
GRANT EXECUTE ON FUNCTION public.get_batch_engagement_status TO authenticated, anon;

COMMENT ON FUNCTION public.get_batch_engagement_status IS
'Batch fetch engagement status for feed views.
Returns: { success, statuses: [{ post_id, is_liked, is_bookmarked, like_count }] }';

-- ============================================================================
-- 4. Get User Bookmarks RPC
-- ============================================================================
-- Returns user's bookmarked posts with pagination

CREATE OR REPLACE FUNCTION public.get_user_bookmarks(
    p_profile_id UUID DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_bookmarks JSONB;
    v_total_count INT;
BEGIN
    -- Use provided profile_id or get from auth context
    v_user_id := COALESCE(p_profile_id, auth.uid());

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', jsonb_build_object(
                'code', 'AUTH_REQUIRED',
                'message', 'Authentication required'
            )
        );
    END IF;

    -- Clamp limit
    p_limit := LEAST(p_limit, 100);

    -- Get total count
    SELECT COUNT(*) INTO v_total_count
    FROM post_bookmarks
    WHERE profile_id = v_user_id;

    -- Get bookmarked post IDs
    SELECT jsonb_agg(post_id ORDER BY created_at DESC)
    INTO v_bookmarks
    FROM (
        SELECT post_id, created_at
        FROM post_bookmarks
        WHERE profile_id = v_user_id
        ORDER BY created_at DESC
        LIMIT p_limit
        OFFSET p_offset
    ) sub;

    RETURN jsonb_build_object(
        'success', true,
        'post_ids', COALESCE(v_bookmarks, '[]'::JSONB),
        'total_count', v_total_count,
        'has_more', (p_offset + p_limit) < v_total_count
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'success', false,
        'error', jsonb_build_object(
            'code', 'SERVER_ERROR',
            'message', SQLERRM
        )
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_user_bookmarks TO authenticated;

COMMENT ON FUNCTION public.get_user_bookmarks IS
'Get user''s bookmarked posts with pagination.
Returns: { success, post_ids, total_count, has_more }';

-- ============================================================================
-- 5. Performance Indexes
-- ============================================================================

-- Index for like lookups by post and user
CREATE INDEX IF NOT EXISTS idx_likes_post_profile_type
ON likes(post_id, profile_id)
WHERE challenge_id = 0 AND forum_id = 0;

-- Index for bookmark lookups
CREATE INDEX IF NOT EXISTS idx_bookmarks_profile_created
ON post_bookmarks(profile_id, created_at DESC);

-- Index for like counts
CREATE INDEX IF NOT EXISTS idx_likes_post_count
ON likes(post_id)
WHERE challenge_id = 0 AND forum_id = 0;

-- ============================================================================
-- Migration Complete
-- ============================================================================
