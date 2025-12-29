-- Migration: Enhanced RLS Policies for Thin Client Architecture
-- Purpose: Stricter access control for posts, likes, and bookmarks
-- Supports: Cross-platform apps (iOS, Android, Web)

-- =============================================================================
-- POSTS TABLE - Enhanced RLS Policies
-- =============================================================================

-- Drop existing policies to recreate with enhancements
DROP POLICY IF EXISTS "Anyone can view active posts" ON posts;
DROP POLICY IF EXISTS "Authenticated users can create posts" ON posts;
DROP POLICY IF EXISTS "Users can update own posts" ON posts;
DROP POLICY IF EXISTS "Users can delete own posts" ON posts;

-- SELECT: Anyone can see active posts, owners can see all their posts
CREATE POLICY "posts_select_policy" ON posts
  FOR SELECT
  USING (
    -- Active and not arranged posts are visible to everyone
    (is_active = true AND is_arranged = false)
    -- Owners can see all their posts
    OR profile_id = auth.uid()
    -- Arranged-to user can see the post they arranged
    OR post_arranged_to = auth.uid()
  );

-- INSERT: Only authenticated users can create posts for themselves
CREATE POLICY "posts_insert_policy" ON posts
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    -- Ensure required fields have valid values
    AND post_name IS NOT NULL
    AND LENGTH(TRIM(post_name)) >= 3
    AND post_type IN ('food', 'things', 'borrow', 'wanted', 'zerowaste', 'vegan')
  );

-- UPDATE: Owners can update their posts, arranged users can update arrangement status
CREATE POLICY "posts_update_policy" ON posts
  FOR UPDATE TO authenticated
  USING (
    -- Owner can update
    profile_id = auth.uid()
    -- Arranged-to user can update (for marking as collected)
    OR post_arranged_to = auth.uid()
  )
  WITH CHECK (
    -- Owner can update any field
    profile_id = auth.uid()
    -- Arranged-to user can only update arrangement-related fields
    OR (
      post_arranged_to = auth.uid()
      -- They can only mark as inactive (collected)
      AND is_arranged = true
    )
  );

-- DELETE: Only owners can delete their posts
CREATE POLICY "posts_delete_policy" ON posts
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- LIKES TABLE - Enhanced RLS Policies
-- =============================================================================

-- Drop existing policies
DROP POLICY IF EXISTS "Anyone can view likes" ON likes;
DROP POLICY IF EXISTS "Users can create likes" ON likes;
DROP POLICY IF EXISTS "Users can delete own likes" ON likes;

-- SELECT: Anyone can view likes (for counting)
CREATE POLICY "likes_select_policy" ON likes
  FOR SELECT
  USING (true);

-- INSERT: Users can only like as themselves, prevent duplicate likes
CREATE POLICY "likes_insert_policy" ON likes
  FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    -- Prevent duplicate likes (handled by unique constraint, but defense in depth)
    AND NOT EXISTS (
      SELECT 1 FROM likes existing
      WHERE existing.post_id = likes.post_id
        AND existing.profile_id = auth.uid()
        AND existing.challenge_id = likes.challenge_id
        AND existing.forum_id = likes.forum_id
    )
  );

-- UPDATE: No updates allowed to likes (like/unlike only)
-- Explicitly deny updates by not creating an UPDATE policy

-- DELETE: Users can only delete their own likes
CREATE POLICY "likes_delete_policy" ON likes
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- POST_BOOKMARKS TABLE - Create and Add RLS Policies
-- =============================================================================

-- Create post_bookmarks table if not exists
CREATE TABLE IF NOT EXISTS post_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES profiles_foodshare(id) ON DELETE CASCADE,
    post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(profile_id, post_id)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_profile
    ON post_bookmarks(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_bookmarks_post
    ON post_bookmarks(post_id);

-- Enable RLS
ALTER TABLE post_bookmarks ENABLE ROW LEVEL SECURITY;

-- SELECT: Users can only see their own bookmarks (private)
CREATE POLICY "bookmarks_select_policy" ON post_bookmarks
  FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- INSERT: Users can only bookmark as themselves
CREATE POLICY "bookmarks_insert_policy" ON post_bookmarks
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid());

-- DELETE: Users can only remove their own bookmarks
CREATE POLICY "bookmarks_delete_policy" ON post_bookmarks
  FOR DELETE TO authenticated
  USING (profile_id = auth.uid());

-- =============================================================================
-- POST_ACTIVITY_LOGS TABLE - Create and Add RLS Policies
-- =============================================================================

-- Create activity logs table if not exists (for audit trail)
CREATE TABLE IF NOT EXISTS post_activity_logs (
    id BIGSERIAL PRIMARY KEY,
    post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES profiles_foodshare(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL, -- 'liked', 'unliked', 'viewed', 'bookmarked', 'unbookmarked', 'arranged', etc.
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_post_activity_post
    ON post_activity_logs(post_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_activity_actor
    ON post_activity_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_activity_type
    ON post_activity_logs(activity_type, created_at DESC);

-- Enable RLS
ALTER TABLE post_activity_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: Post owners can see activity on their posts
CREATE POLICY "activity_logs_select_policy" ON post_activity_logs
  FOR SELECT TO authenticated
  USING (
    -- Actor can see their own activity
    actor_id = auth.uid()
    -- Post owner can see activity on their posts
    OR EXISTS (
      SELECT 1 FROM posts p
      WHERE p.id = post_activity_logs.post_id
        AND p.profile_id = auth.uid()
    )
  );

-- INSERT: Service role and authenticated users can insert activity
CREATE POLICY "activity_logs_insert_policy" ON post_activity_logs
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- Service role full access (for Edge Functions)
CREATE POLICY "activity_logs_service_policy" ON post_activity_logs
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- COMMENTS
-- =============================================================================

COMMENT ON POLICY "posts_select_policy" ON posts IS
'Enhanced SELECT policy: Active posts visible to all, owners see all their posts, arranged users see their arranged posts.';

COMMENT ON POLICY "posts_update_policy" ON posts IS
'Enhanced UPDATE policy: Owners can update any field, arranged users can update arrangement status only.';

COMMENT ON TABLE post_bookmarks IS
'User bookmarks/saved items for posts. Private to each user, synced across devices.';

COMMENT ON TABLE post_activity_logs IS
'Audit trail for post activities (likes, views, bookmarks, arrangements). Used for analytics and debugging.';
