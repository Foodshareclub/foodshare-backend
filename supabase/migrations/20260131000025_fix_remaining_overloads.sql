-- ============================================================================
-- FIX REMAINING ENGAGEMENT FUNCTION OVERLOADS (INTEGER vs BIGINT)
-- ============================================================================
-- toggle_comment_like and toggle_forum_bookmark have INTEGER/BIGINT conflicts
-- ============================================================================

-- ============================================================================
-- PART 1: FIX toggle_comment_like
-- ============================================================================

DROP FUNCTION IF EXISTS toggle_comment_like(INTEGER);
DROP FUNCTION IF EXISTS toggle_comment_like(BIGINT);
DROP FUNCTION IF EXISTS public.toggle_comment_like(INTEGER);
DROP FUNCTION IF EXISTS public.toggle_comment_like(BIGINT);

CREATE OR REPLACE FUNCTION toggle_comment_like(p_comment_id INTEGER)
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
    v_comment_owner_id UUID;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    -- Get comment owner for notification
    SELECT profile_id INTO v_comment_owner_id FROM forum_comments WHERE id = p_comment_id;

    IF v_comment_owner_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'COMMENT_NOT_FOUND', 'message', 'Comment not found'));
    END IF;

    -- Check existing like in unified likes table
    SELECT id INTO v_existing_id FROM likes
    WHERE comment_id = p_comment_id AND profile_id = v_user_id
      AND post_id = 0 AND forum_id = 0 AND challenge_id = 0;

    IF v_existing_id IS NOT NULL THEN
        -- Unlike
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;

        -- Decrement counter
        UPDATE forum_comments SET likes_count = GREATEST(COALESCE(likes_count, 0) - 1, 0)
        WHERE id = p_comment_id;
    ELSE
        -- Like
        INSERT INTO likes (comment_id, profile_id, post_id, forum_id, challenge_id)
        VALUES (p_comment_id, v_user_id, 0, 0, 0);
        v_is_liked := true;

        -- Increment counter
        UPDATE forum_comments SET likes_count = COALESCE(likes_count, 0) + 1
        WHERE id = p_comment_id;

        -- Notification for comment owner (if not self-like)
        IF v_comment_owner_id != v_user_id THEN
            INSERT INTO notifications (profile_id, type, data)
            VALUES (v_comment_owner_id, 'comment_liked', jsonb_build_object(
                'comment_id', p_comment_id,
                'liker_id', v_user_id
            ))
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    -- Get final like count
    SELECT COALESCE(likes_count, 0) INTO v_like_count FROM forum_comments WHERE id = p_comment_id;

    RETURN json_build_object(
        'success', true,
        'is_liked', v_is_liked,
        'like_count', v_like_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION toggle_comment_like(INTEGER) TO authenticated;

-- ============================================================================
-- PART 2: FIX toggle_forum_bookmark (drop BIGINT version, keep INTEGER)
-- ============================================================================

DROP FUNCTION IF EXISTS toggle_forum_bookmark(INTEGER);
DROP FUNCTION IF EXISTS toggle_forum_bookmark(BIGINT);
DROP FUNCTION IF EXISTS public.toggle_forum_bookmark(INTEGER);
DROP FUNCTION IF EXISTS public.toggle_forum_bookmark(BIGINT);

CREATE OR REPLACE FUNCTION toggle_forum_bookmark(p_forum_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_existing_id INTEGER;
    v_is_bookmarked BOOLEAN;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    -- Verify forum post exists
    IF NOT EXISTS (SELECT 1 FROM forum WHERE id = p_forum_id) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'FORUM_NOT_FOUND', 'message', 'Forum post not found'));
    END IF;

    -- Check existing bookmark in unified bookmarks table
    SELECT id INTO v_existing_id FROM bookmarks
    WHERE forum_id = p_forum_id AND profile_id = v_user_id AND post_id = 0;

    IF v_existing_id IS NOT NULL THEN
        -- Unbookmark
        DELETE FROM bookmarks WHERE id = v_existing_id;
        v_is_bookmarked := false;
    ELSE
        -- Bookmark
        INSERT INTO bookmarks (forum_id, profile_id, post_id)
        VALUES (p_forum_id, v_user_id, 0);
        v_is_bookmarked := true;
    END IF;

    RETURN json_build_object(
        'success', true,
        'is_bookmarked', v_is_bookmarked
    );
END;
$$;

GRANT EXECUTE ON FUNCTION toggle_forum_bookmark(INTEGER) TO authenticated;

-- ============================================================================
-- PART 3: COMMENTS
-- ============================================================================

COMMENT ON FUNCTION toggle_comment_like(INTEGER) IS
    'Toggle like on a comment. Uses unified likes table. Fixed overload 2026-01-31.';

COMMENT ON FUNCTION toggle_forum_bookmark(INTEGER) IS
    'Toggle bookmark on a forum post. Uses unified bookmarks table. Fixed overload 2026-01-31.';
