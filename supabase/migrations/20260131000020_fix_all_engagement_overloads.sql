-- ============================================================================
-- FIX ALL ENGAGEMENT FUNCTION OVERLOADS
-- ============================================================================
-- This migration resolves PostgREST PGRST203 errors by dropping duplicate
-- function signatures and recreating canonical versions using auth.uid()
--
-- Affected functions:
-- - toggle_bookmark
-- - get_user_bookmarks
-- - increment_post_views (if overloaded)
-- ============================================================================

-- ============================================================================
-- PART 1: FIX toggle_bookmark OVERLOAD
-- ============================================================================

DROP FUNCTION IF EXISTS toggle_bookmark(INTEGER);
DROP FUNCTION IF EXISTS toggle_bookmark(INTEGER, UUID);
DROP FUNCTION IF EXISTS public.toggle_bookmark(INTEGER);
DROP FUNCTION IF EXISTS public.toggle_bookmark(INTEGER, UUID);

CREATE OR REPLACE FUNCTION toggle_bookmark(p_post_id INTEGER)
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

    -- Verify post exists
    IF NOT EXISTS (SELECT 1 FROM posts WHERE id = p_post_id) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found'));
    END IF;

    -- Check existing bookmark in unified bookmarks table
    SELECT id INTO v_existing_id FROM bookmarks
    WHERE post_id = p_post_id AND profile_id = v_user_id AND forum_id = 0;

    IF v_existing_id IS NOT NULL THEN
        -- Unbookmark: remove the bookmark
        DELETE FROM bookmarks WHERE id = v_existing_id;
        v_is_bookmarked := false;
    ELSE
        -- Bookmark: add a new bookmark
        INSERT INTO bookmarks (post_id, profile_id, forum_id)
        VALUES (p_post_id, v_user_id, 0);
        v_is_bookmarked := true;
    END IF;

    RETURN json_build_object(
        'success', true,
        'is_bookmarked', v_is_bookmarked
    );
END;
$$;

GRANT EXECUTE ON FUNCTION toggle_bookmark(INTEGER) TO authenticated;

-- ============================================================================
-- PART 2: FIX get_user_bookmarks OVERLOAD
-- ============================================================================

DROP FUNCTION IF EXISTS get_user_bookmarks(INTEGER);
DROP FUNCTION IF EXISTS get_user_bookmarks(UUID, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.get_user_bookmarks(INTEGER);
DROP FUNCTION IF EXISTS public.get_user_bookmarks(UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_user_bookmarks(p_limit INTEGER DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_post_ids INTEGER[];
    v_total INTEGER;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    -- Get bookmarked post IDs from unified bookmarks table
    SELECT ARRAY_AGG(post_id ORDER BY created_at DESC)
    INTO v_post_ids
    FROM (
        SELECT post_id, created_at
        FROM bookmarks
        WHERE profile_id = v_user_id AND post_id > 0 AND forum_id = 0
        ORDER BY created_at DESC
        LIMIT p_limit
    ) sub;

    -- Get total count
    SELECT COUNT(*) INTO v_total
    FROM bookmarks
    WHERE profile_id = v_user_id AND post_id > 0 AND forum_id = 0;

    RETURN json_build_object(
        'success', true,
        'post_ids', COALESCE(v_post_ids, ARRAY[]::INTEGER[]),
        'total_count', v_total,
        'has_more', v_total > p_limit
    );
END;
$$;

GRANT EXECUTE ON FUNCTION get_user_bookmarks(INTEGER) TO authenticated;

-- ============================================================================
-- PART 3: FIX toggle_forum_bookmark OVERLOAD (if exists)
-- ============================================================================

DROP FUNCTION IF EXISTS toggle_forum_bookmark(INTEGER);
DROP FUNCTION IF EXISTS toggle_forum_bookmark(INTEGER, UUID);

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
-- PART 4: FIX increment_post_views (ensure no overload)
-- ============================================================================

DROP FUNCTION IF EXISTS increment_post_views(INTEGER);
DROP FUNCTION IF EXISTS increment_post_views(INTEGER, UUID);

CREATE OR REPLACE FUNCTION increment_post_views(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_new_count INTEGER;
BEGIN
    v_user_id := auth.uid();

    -- Update view count on posts table
    UPDATE posts
    SET post_views = COALESCE(post_views, 0) + 1
    WHERE id = p_post_id
    RETURNING post_views INTO v_new_count;

    IF v_new_count IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found'));
    END IF;

    -- Record view in unified views table (for analytics)
    IF v_user_id IS NOT NULL THEN
        INSERT INTO views (post_id, profile_id, forum_id, challenge_id)
        VALUES (p_post_id, v_user_id, 0, 0)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN json_build_object(
        'success', true,
        'view_count', v_new_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION increment_post_views(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION increment_post_views(INTEGER) TO anon;

-- ============================================================================
-- PART 5: COMMENTS
-- ============================================================================

COMMENT ON FUNCTION toggle_bookmark(INTEGER) IS
    'Toggle bookmark on a post. Uses unified bookmarks table. Fixed overload 2026-01-31.';

COMMENT ON FUNCTION get_user_bookmarks(INTEGER) IS
    'Get user bookmarked post IDs. Uses unified bookmarks table. Fixed overload 2026-01-31.';

COMMENT ON FUNCTION toggle_forum_bookmark(INTEGER) IS
    'Toggle bookmark on a forum post. Uses unified bookmarks table.';

COMMENT ON FUNCTION increment_post_views(INTEGER) IS
    'Increment view count for a post. Records in unified views table.';
