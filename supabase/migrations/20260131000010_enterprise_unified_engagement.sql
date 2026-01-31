-- ============================================================================
-- ENTERPRISE UNIFIED ENGAGEMENT SYSTEM
-- ============================================================================
-- Version: 1.0.0
-- Date: 2026-01-31
--
-- Single-table architecture for ALL engagement types:
--   - LIKES: posts, forum, challenges, comments
--   - BOOKMARKS: posts, forum
--   - VIEWS: posts, forum, challenges
--
-- Benefits:
--   - Single source of truth for each engagement type
--   - Optimized indexes with partial filtering
--   - Atomic RPC functions with proper error handling
--   - Denormalized counters for fast reads
--   - Audit-ready with timestamps
-- ============================================================================

-- ============================================================================
-- PART 1: UNIFIED LIKES TABLE
-- ============================================================================

-- Ensure likes table has all required columns
ALTER TABLE likes ADD COLUMN IF NOT EXISTS post_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE likes ADD COLUMN IF NOT EXISTS forum_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE likes ADD COLUMN IF NOT EXISTS challenge_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE likes ADD COLUMN IF NOT EXISTS comment_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE likes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Drop old indexes to recreate optimized ones
DROP INDEX IF EXISTS idx_likes_post_id;
DROP INDEX IF EXISTS idx_likes_forum_id;
DROP INDEX IF EXISTS idx_likes_challenge_id;
DROP INDEX IF EXISTS idx_likes_comment_id;
DROP INDEX IF EXISTS idx_likes_post_profile;
DROP INDEX IF EXISTS idx_likes_forum_profile;
DROP INDEX IF EXISTS idx_likes_challenge_profile;
DROP INDEX IF EXISTS idx_likes_comment_profile;

-- Create optimized partial indexes for each entity type
CREATE INDEX idx_likes_post ON likes(post_id, profile_id)
    WHERE post_id > 0 AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0;

CREATE INDEX idx_likes_forum ON likes(forum_id, profile_id)
    WHERE forum_id > 0 AND post_id = 0 AND challenge_id = 0 AND comment_id = 0;

CREATE INDEX idx_likes_challenge ON likes(challenge_id, profile_id)
    WHERE challenge_id > 0 AND post_id = 0 AND forum_id = 0 AND comment_id = 0;

CREATE INDEX idx_likes_comment ON likes(comment_id, profile_id)
    WHERE comment_id > 0 AND post_id = 0 AND forum_id = 0 AND challenge_id = 0;

-- Unique constraints to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uniq_likes_post
    ON likes(post_id, profile_id)
    WHERE post_id > 0 AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_likes_forum
    ON likes(forum_id, profile_id)
    WHERE forum_id > 0 AND post_id = 0 AND challenge_id = 0 AND comment_id = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_likes_challenge
    ON likes(challenge_id, profile_id)
    WHERE challenge_id > 0 AND post_id = 0 AND forum_id = 0 AND comment_id = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_likes_comment
    ON likes(comment_id, profile_id)
    WHERE comment_id > 0 AND post_id = 0 AND forum_id = 0 AND challenge_id = 0;

-- Index for counting likes per entity (for denormalized counters)
CREATE INDEX idx_likes_post_count ON likes(post_id) WHERE post_id > 0;
CREATE INDEX idx_likes_forum_count ON likes(forum_id) WHERE forum_id > 0;
CREATE INDEX idx_likes_challenge_count ON likes(challenge_id) WHERE challenge_id > 0;
CREATE INDEX idx_likes_comment_count ON likes(comment_id) WHERE comment_id > 0;

-- ============================================================================
-- PART 2: UNIFIED BOOKMARKS TABLE
-- ============================================================================

-- Ensure bookmarks table has all required columns
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS post_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS forum_id INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Drop old indexes to recreate optimized ones
DROP INDEX IF EXISTS idx_bookmarks_post_id;
DROP INDEX IF EXISTS idx_bookmarks_forum_id;
DROP INDEX IF EXISTS idx_bookmarks_post_profile;
DROP INDEX IF EXISTS idx_bookmarks_forum_profile;

-- Create optimized partial indexes
CREATE INDEX idx_bookmarks_post ON bookmarks(post_id, profile_id)
    WHERE post_id > 0 AND forum_id = 0;

CREATE INDEX idx_bookmarks_forum ON bookmarks(forum_id, profile_id)
    WHERE forum_id > 0 AND post_id = 0;

-- Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookmarks_post
    ON bookmarks(post_id, profile_id) WHERE post_id > 0 AND forum_id = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookmarks_forum
    ON bookmarks(forum_id, profile_id) WHERE forum_id > 0 AND post_id = 0;

-- Index for user's bookmarks list
CREATE INDEX idx_bookmarks_user_posts ON bookmarks(profile_id, created_at DESC)
    WHERE post_id > 0 AND forum_id = 0;
CREATE INDEX idx_bookmarks_user_forum ON bookmarks(profile_id, created_at DESC)
    WHERE forum_id > 0 AND post_id = 0;

-- ============================================================================
-- PART 3: UNIFIED VIEWS TABLE
-- ============================================================================

-- Ensure views table has all required columns
ALTER TABLE views ADD COLUMN IF NOT EXISTS post_id INTEGER DEFAULT 0;
ALTER TABLE views ADD COLUMN IF NOT EXISTS forum_id INTEGER DEFAULT 0;
ALTER TABLE views ADD COLUMN IF NOT EXISTS challenge_id INTEGER DEFAULT 0;
ALTER TABLE views ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Create optimized indexes for views
CREATE INDEX IF NOT EXISTS idx_views_post ON views(post_id, profile_id) WHERE post_id > 0;
CREATE INDEX IF NOT EXISTS idx_views_forum ON views(forum_id, profile_id) WHERE forum_id > 0;
CREATE INDEX IF NOT EXISTS idx_views_challenge ON views(challenge_id, profile_id) WHERE challenge_id > 0;

-- Index for counting views per entity
CREATE INDEX IF NOT EXISTS idx_views_post_count ON views(post_id) WHERE post_id > 0;
CREATE INDEX IF NOT EXISTS idx_views_forum_count ON views(forum_id) WHERE forum_id > 0;
CREATE INDEX IF NOT EXISTS idx_views_challenge_count ON views(challenge_id) WHERE challenge_id > 0;

-- ============================================================================
-- PART 4: MIGRATE LEGACY DATA
-- ============================================================================

-- Migrate forum_likes → likes
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'forum_likes' AND table_schema = 'public') THEN
        INSERT INTO likes (profile_id, post_id, challenge_id, forum_id, comment_id, created_at)
        SELECT profile_id, 0, 0, forum_id, 0, COALESCE(created_at, NOW())
        FROM forum_likes
        ON CONFLICT DO NOTHING;
        RAISE NOTICE 'Migrated % rows from forum_likes', (SELECT COUNT(*) FROM forum_likes);
    END IF;
END $$;

-- Migrate comment_likes → likes
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comment_likes' AND table_schema = 'public') THEN
        INSERT INTO likes (profile_id, post_id, challenge_id, forum_id, comment_id, created_at)
        SELECT profile_id::uuid, 0, 0, 0, comment_id, COALESCE(created_at, NOW())
        FROM comment_likes
        ON CONFLICT DO NOTHING;
        RAISE NOTICE 'Migrated % rows from comment_likes', (SELECT COUNT(*) FROM comment_likes);
    END IF;
END $$;

-- Migrate forum_bookmarks → bookmarks
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'forum_bookmarks' AND table_schema = 'public') THEN
        INSERT INTO bookmarks (profile_id, post_id, forum_id, created_at)
        SELECT profile_id, 0, forum_id, COALESCE(created_at, NOW())
        FROM forum_bookmarks
        ON CONFLICT DO NOTHING;
        RAISE NOTICE 'Migrated % rows from forum_bookmarks', (SELECT COUNT(*) FROM forum_bookmarks);
    END IF;
END $$;

-- Migrate post_bookmarks → bookmarks
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'post_bookmarks' AND table_schema = 'public') THEN
        INSERT INTO bookmarks (profile_id, post_id, forum_id, created_at)
        SELECT profile_id, post_id, 0, COALESCE(created_at, NOW())
        FROM post_bookmarks
        ON CONFLICT DO NOTHING;
        RAISE NOTICE 'Migrated % rows from post_bookmarks', (SELECT COUNT(*) FROM post_bookmarks);
    END IF;
END $$;

-- ============================================================================
-- PART 5: TOGGLE_LIKE - Universal like toggle for posts
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

    -- Check existing like
    SELECT id INTO v_existing_id FROM likes
    WHERE post_id = p_post_id AND profile_id = v_user_id
      AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;
    ELSE
        INSERT INTO likes (profile_id, post_id, forum_id, challenge_id, comment_id, created_at)
        VALUES (v_user_id, p_post_id, 0, 0, 0, NOW());
        v_is_liked := true;
    END IF;

    -- Get updated count
    SELECT COUNT(*) INTO v_like_count FROM likes
    WHERE post_id = p_post_id AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0;

    -- Update denormalized counter
    UPDATE posts SET post_like_counter = v_like_count WHERE id = p_post_id;

    RETURN json_build_object('success', true, 'is_liked', v_is_liked, 'like_count', v_like_count, 'post_owner_id', v_post_owner_id);
END;
$$;

-- ============================================================================
-- PART 6: TOGGLE_FORUM_LIKE - Forum post likes
-- ============================================================================

CREATE OR REPLACE FUNCTION toggle_forum_like(p_forum_id INTEGER)
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
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM forum WHERE id = p_forum_id AND deleted_at IS NULL) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'FORUM_NOT_FOUND', 'message', 'Forum post not found'));
    END IF;

    SELECT id INTO v_existing_id FROM likes
    WHERE forum_id = p_forum_id AND profile_id = v_user_id
      AND post_id = 0 AND challenge_id = 0 AND comment_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;
    ELSE
        INSERT INTO likes (profile_id, post_id, forum_id, challenge_id, comment_id, created_at)
        VALUES (v_user_id, 0, p_forum_id, 0, 0, NOW());
        v_is_liked := true;
    END IF;

    SELECT COUNT(*) INTO v_like_count FROM likes
    WHERE forum_id = p_forum_id AND post_id = 0 AND challenge_id = 0 AND comment_id = 0;

    UPDATE forum SET likes_count = v_like_count WHERE id = p_forum_id;

    RETURN json_build_object('success', true, 'is_liked', v_is_liked, 'like_count', v_like_count);
END;
$$;

-- ============================================================================
-- PART 7: TOGGLE_CHALLENGE_LIKE - Challenge likes
-- ============================================================================

CREATE OR REPLACE FUNCTION toggle_challenge_like(p_challenge_id INTEGER)
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
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM challenges WHERE id = p_challenge_id) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'CHALLENGE_NOT_FOUND', 'message', 'Challenge not found'));
    END IF;

    SELECT id INTO v_existing_id FROM likes
    WHERE challenge_id = p_challenge_id AND profile_id = v_user_id
      AND post_id = 0 AND forum_id = 0 AND comment_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;
    ELSE
        INSERT INTO likes (profile_id, post_id, forum_id, challenge_id, comment_id, created_at)
        VALUES (v_user_id, 0, 0, p_challenge_id, 0, NOW());
        v_is_liked := true;
    END IF;

    SELECT COUNT(*) INTO v_like_count FROM likes
    WHERE challenge_id = p_challenge_id AND post_id = 0 AND forum_id = 0 AND comment_id = 0;

    UPDATE challenges SET challenge_likes = v_like_count WHERE id = p_challenge_id;

    RETURN json_build_object('success', true, 'is_liked', v_is_liked, 'like_count', v_like_count);
END;
$$;

-- ============================================================================
-- PART 8: TOGGLE_COMMENT_LIKE - Forum comment likes
-- ============================================================================

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
    v_author_id UUID;
BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'AUTH_REQUIRED', 'message', 'Authentication required'));
    END IF;

    SELECT profile_id INTO v_author_id FROM forum_comments WHERE id = p_comment_id AND deleted_at IS NULL;

    IF v_author_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'COMMENT_NOT_FOUND', 'message', 'Comment not found'));
    END IF;

    SELECT id INTO v_existing_id FROM likes
    WHERE comment_id = p_comment_id AND profile_id = v_user_id
      AND post_id = 0 AND forum_id = 0 AND challenge_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM likes WHERE id = v_existing_id;
        v_is_liked := false;
    ELSE
        INSERT INTO likes (profile_id, post_id, forum_id, challenge_id, comment_id, created_at)
        VALUES (v_user_id, 0, 0, 0, p_comment_id, NOW());
        v_is_liked := true;
    END IF;

    SELECT COUNT(*) INTO v_like_count FROM likes
    WHERE comment_id = p_comment_id AND post_id = 0 AND forum_id = 0 AND challenge_id = 0;

    RETURN json_build_object('success', true, 'is_liked', v_is_liked, 'like_count', v_like_count, 'comment_author_id', v_author_id);
END;
$$;

-- ============================================================================
-- PART 9: TOGGLE_BOOKMARK - Post bookmarks
-- ============================================================================

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

    IF NOT EXISTS (SELECT 1 FROM posts WHERE id = p_post_id) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found'));
    END IF;

    SELECT id INTO v_existing_id FROM bookmarks
    WHERE post_id = p_post_id AND profile_id = v_user_id AND forum_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM bookmarks WHERE id = v_existing_id;
        v_is_bookmarked := false;
    ELSE
        INSERT INTO bookmarks (profile_id, post_id, forum_id, created_at)
        VALUES (v_user_id, p_post_id, 0, NOW());
        v_is_bookmarked := true;
    END IF;

    RETURN json_build_object('success', true, 'is_bookmarked', v_is_bookmarked);
END;
$$;

-- ============================================================================
-- PART 10: TOGGLE_FORUM_BOOKMARK - Forum post bookmarks
-- ============================================================================

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

    IF NOT EXISTS (SELECT 1 FROM forum WHERE id = p_forum_id AND deleted_at IS NULL) THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'FORUM_NOT_FOUND', 'message', 'Forum post not found'));
    END IF;

    SELECT id INTO v_existing_id FROM bookmarks
    WHERE forum_id = p_forum_id AND profile_id = v_user_id AND post_id = 0;

    IF v_existing_id IS NOT NULL THEN
        DELETE FROM bookmarks WHERE id = v_existing_id;
        v_is_bookmarked := false;
    ELSE
        INSERT INTO bookmarks (profile_id, post_id, forum_id, created_at)
        VALUES (v_user_id, 0, p_forum_id, NOW());
        v_is_bookmarked := true;
    END IF;

    RETURN json_build_object('success', true, 'is_bookmarked', v_is_bookmarked);
END;
$$;

-- ============================================================================
-- PART 11: VIEW INCREMENT FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_post_views(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_count INTEGER;
BEGIN
    UPDATE posts SET post_views = COALESCE(post_views, 0) + 1
    WHERE id = p_post_id
    RETURNING post_views INTO v_new_count;

    IF v_new_count IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'POST_NOT_FOUND', 'message', 'Post not found'));
    END IF;

    RETURN json_build_object('success', true, 'view_count', v_new_count);
END;
$$;

CREATE OR REPLACE FUNCTION increment_forum_views(p_forum_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_count INTEGER;
BEGIN
    UPDATE forum SET views_count = COALESCE(views_count, 0) + 1
    WHERE id = p_forum_id AND deleted_at IS NULL
    RETURNING views_count INTO v_new_count;

    IF v_new_count IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'FORUM_NOT_FOUND', 'message', 'Forum post not found'));
    END IF;

    RETURN json_build_object('success', true, 'view_count', v_new_count);
END;
$$;

CREATE OR REPLACE FUNCTION increment_challenge_views(p_challenge_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_count INTEGER;
BEGIN
    UPDATE challenges SET challenge_views = COALESCE(challenge_views, 0) + 1
    WHERE id = p_challenge_id
    RETURNING challenge_views INTO v_new_count;

    IF v_new_count IS NULL THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'CHALLENGE_NOT_FOUND', 'message', 'Challenge not found'));
    END IF;

    RETURN json_build_object('success', true, 'view_count', v_new_count);
END;
$$;

-- ============================================================================
-- PART 12: BATCH ENGAGEMENT STATUS
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
    v_user_id := auth.uid();

    IF array_length(p_post_ids, 1) IS NULL OR array_length(p_post_ids, 1) = 0 THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'INVALID_INPUT', 'message', 'Post IDs required'));
    END IF;

    IF array_length(p_post_ids, 1) > 100 THEN
        RETURN json_build_object('success', false, 'error', json_build_object('code', 'TOO_MANY_POSTS', 'message', 'Maximum 100 posts'));
    END IF;

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
        SELECT post_id, true as is_liked FROM likes
        WHERE profile_id = v_user_id AND post_id = ANY(p_post_ids)
          AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0
    ) ul ON ul.post_id = p.id
    LEFT JOIN (
        SELECT post_id, true as is_bookmarked FROM bookmarks
        WHERE profile_id = v_user_id AND post_id = ANY(p_post_ids) AND forum_id = 0
    ) ub ON ub.post_id = p.id
    LEFT JOIN (
        SELECT post_id, COUNT(*) as like_count FROM likes
        WHERE post_id = ANY(p_post_ids) AND forum_id = 0 AND challenge_id = 0 AND comment_id = 0
        GROUP BY post_id
    ) lc ON lc.post_id = p.id;

    RETURN v_result;
END;
$$;

-- ============================================================================
-- PART 13: USER BOOKMARKS
-- ============================================================================

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

    SELECT ARRAY_AGG(post_id ORDER BY created_at DESC) INTO v_post_ids
    FROM (SELECT post_id, created_at FROM bookmarks WHERE profile_id = v_user_id AND post_id > 0 AND forum_id = 0 LIMIT p_limit) sub;

    SELECT COUNT(*) INTO v_total FROM bookmarks WHERE profile_id = v_user_id AND post_id > 0 AND forum_id = 0;

    RETURN json_build_object('success', true, 'post_ids', COALESCE(v_post_ids, ARRAY[]::INTEGER[]), 'total_count', v_total, 'has_more', v_total > p_limit);
END;
$$;

-- ============================================================================
-- PART 14: GRANT PERMISSIONS
-- ============================================================================

-- Like functions
GRANT EXECUTE ON FUNCTION toggle_like(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_forum_like(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_challenge_like(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_comment_like(INTEGER) TO authenticated;

-- Bookmark functions
GRANT EXECUTE ON FUNCTION toggle_bookmark(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_forum_bookmark(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_bookmarks(INTEGER) TO authenticated;

-- View functions (allow anon for view tracking)
GRANT EXECUTE ON FUNCTION increment_post_views(INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_forum_views(INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_challenge_views(INTEGER) TO authenticated, anon;

-- Batch functions
GRANT EXECUTE ON FUNCTION get_batch_engagement_status(INTEGER[]) TO authenticated, anon;

-- ============================================================================
-- PART 15: DROP LEGACY TABLES (run after verification)
-- ============================================================================

-- Verify data migration was successful, then uncomment:
-- DROP TABLE IF EXISTS forum_likes CASCADE;
-- DROP TABLE IF EXISTS comment_likes CASCADE;
-- DROP TABLE IF EXISTS forum_bookmarks CASCADE;
-- DROP TABLE IF EXISTS post_bookmarks CASCADE;

-- ============================================================================
-- PART 16: TABLE COMMENTS (Documentation)
-- ============================================================================

COMMENT ON TABLE likes IS 'Unified likes table for all entity types. Use post_id/forum_id/challenge_id/comment_id > 0 to identify target.';
COMMENT ON TABLE bookmarks IS 'Unified bookmarks table for posts and forum. Use post_id/forum_id > 0 to identify target.';
COMMENT ON TABLE views IS 'Unified views table for all entity types. Records individual view events.';

COMMENT ON FUNCTION toggle_like(INTEGER) IS 'Toggle like on a post. Returns {success, is_liked, like_count, post_owner_id}';
COMMENT ON FUNCTION toggle_forum_like(INTEGER) IS 'Toggle like on a forum post. Returns {success, is_liked, like_count}';
COMMENT ON FUNCTION toggle_challenge_like(INTEGER) IS 'Toggle like on a challenge. Returns {success, is_liked, like_count}';
COMMENT ON FUNCTION toggle_comment_like(INTEGER) IS 'Toggle like on a comment. Returns {success, is_liked, like_count, comment_author_id}';
COMMENT ON FUNCTION toggle_bookmark(INTEGER) IS 'Toggle bookmark on a post. Returns {success, is_bookmarked}';
COMMENT ON FUNCTION toggle_forum_bookmark(INTEGER) IS 'Toggle bookmark on a forum post. Returns {success, is_bookmarked}';
COMMENT ON FUNCTION get_batch_engagement_status(INTEGER[]) IS 'Get engagement status for up to 100 posts. Returns {success, statuses[]}';
COMMENT ON FUNCTION get_user_bookmarks(INTEGER) IS 'Get user bookmarked post IDs. Returns {success, post_ids[], total_count, has_more}';
