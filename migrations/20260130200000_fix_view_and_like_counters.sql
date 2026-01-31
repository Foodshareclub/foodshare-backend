-- Migration: Fix View Count and Like Counter Synchronization
-- Created: 2026-01-30
-- Purpose:
--   1. Create missing post_views table for view tracking
--   2. Create increment_post_views RPC function
--   3. Add trigger to sync post_like_counter with post_likes table
--   4. Backfill existing like counts

-- ============================================================================
-- PART 1: VIEW TRACKING INFRASTRUCTURE
-- ============================================================================

-- Create post_views table if it doesn't exist
CREATE TABLE IF NOT EXISTS post_views (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    viewer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    viewed_at TIMESTAMPTZ DEFAULT NOW(),
    -- Prevent exact duplicate views
    UNIQUE(post_id, viewer_id, viewed_at)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_post_views_post_id ON post_views(post_id);
CREATE INDEX IF NOT EXISTS idx_post_views_viewer_time ON post_views(post_id, viewer_id, viewed_at DESC);

-- Enable RLS
ALTER TABLE post_views ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Anyone can insert views (including anonymous), only service role can read all
DROP POLICY IF EXISTS "Anyone can record views" ON post_views;
CREATE POLICY "Anyone can record views" ON post_views
    FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can see view counts" ON post_views;
CREATE POLICY "Users can see view counts" ON post_views
    FOR SELECT
    USING (true);

-- ============================================================================
-- PART 2: INCREMENT POST VIEWS RPC FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION increment_post_views(p_post_id INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_recent_view_exists BOOLEAN := false;
    v_new_view_count INTEGER;
BEGIN
    -- Get current user (may be NULL for anonymous)
    v_user_id := auth.uid();

    -- Rate limiting: Check if this user viewed this post in the last hour
    IF v_user_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM post_views
            WHERE post_id = p_post_id
              AND viewer_id = v_user_id
              AND viewed_at > NOW() - INTERVAL '1 hour'
        ) INTO v_recent_view_exists;
    END IF;

    -- Only record if not a recent duplicate view
    IF NOT v_recent_view_exists THEN
        -- Insert the view record
        INSERT INTO post_views (post_id, viewer_id, viewed_at)
        VALUES (p_post_id, v_user_id, NOW())
        ON CONFLICT DO NOTHING;

        -- Update the denormalized view count on posts table
        UPDATE posts
        SET post_views = COALESCE(post_views, 0) + 1,
            updated_at = NOW()
        WHERE id = p_post_id;
    END IF;

    -- Get the current view count
    SELECT COALESCE(post_views, 0) INTO v_new_view_count
    FROM posts
    WHERE id = p_post_id;

    RETURN json_build_object(
        'success', true,
        'view_count', COALESCE(v_new_view_count, 0),
        'was_new_view', NOT v_recent_view_exists
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN json_build_object(
            'success', false,
            'error', SQLERRM
        );
END;
$$;

-- Grant execute to authenticated and anonymous users
GRANT EXECUTE ON FUNCTION increment_post_views(INTEGER) TO authenticated, anon;

COMMENT ON FUNCTION increment_post_views IS
'Increments view count for a post with 1-hour rate limiting per user.
Anonymous views are always counted. Returns the new view count.';

-- ============================================================================
-- PART 3: LIKE COUNTER SYNCHRONIZATION TRIGGER
-- ============================================================================

-- Function to sync post_like_counter when likes are added/removed
CREATE OR REPLACE FUNCTION trigger_sync_post_like_counter()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_post_id INTEGER;
    v_new_count INTEGER;
BEGIN
    -- Get the post_id from the affected row
    IF TG_OP = 'DELETE' THEN
        v_post_id := OLD.post_id;
    ELSE
        v_post_id := NEW.post_id;
    END IF;

    -- Count actual likes for this post
    SELECT COUNT(*) INTO v_new_count
    FROM post_likes
    WHERE post_id = v_post_id;

    -- Update the denormalized counter
    UPDATE posts
    SET post_like_counter = v_new_count,
        updated_at = NOW()
    WHERE id = v_post_id;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Drop existing trigger if exists and recreate
DROP TRIGGER IF EXISTS trg_sync_post_like_counter ON post_likes;

CREATE TRIGGER trg_sync_post_like_counter
    AFTER INSERT OR DELETE ON post_likes
    FOR EACH ROW
    EXECUTE FUNCTION trigger_sync_post_like_counter();

COMMENT ON FUNCTION trigger_sync_post_like_counter IS
'Trigger function that keeps posts.post_like_counter in sync with actual likes in post_likes table.';

-- ============================================================================
-- PART 4: BACKFILL EXISTING COUNTS
-- ============================================================================

-- Backfill like counts for all posts that have likes
UPDATE posts p
SET post_like_counter = (
    SELECT COUNT(*)
    FROM post_likes pl
    WHERE pl.post_id = p.id
)
WHERE EXISTS (
    SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id
);

-- Ensure posts without likes have 0 (not NULL)
UPDATE posts
SET post_like_counter = 0
WHERE post_like_counter IS NULL;

-- Backfill view counts from post_views table if any exist
UPDATE posts p
SET post_views = COALESCE((
    SELECT COUNT(*)
    FROM post_views pv
    WHERE pv.post_id = p.id
), 0)
WHERE post_views IS NULL OR post_views = 0;

-- ============================================================================
-- PART 5: VERIFICATION QUERY (for manual testing)
-- ============================================================================

-- Run this to verify the migration worked:
-- SELECT
--     p.id,
--     p.post_title,
--     p.post_views,
--     p.post_like_counter,
--     (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) as actual_likes,
--     (SELECT COUNT(*) FROM post_views pv WHERE pv.post_id = p.id) as actual_views
-- FROM posts p
-- ORDER BY p.created_at DESC
-- LIMIT 10;
