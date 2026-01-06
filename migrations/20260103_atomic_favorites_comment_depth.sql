-- Migration: Atomic Favorites and Comment Depth RPC Functions
-- Created: 2026-01-03
-- Purpose: Add atomic toggle for favorites and server-side comment depth calculation

-- =============================================================================
-- Atomic Favorite Toggle RPC
-- =============================================================================

-- Drop if exists (for idempotency)
DROP FUNCTION IF EXISTS toggle_post_favorite_atomic(UUID, INTEGER);

-- Create atomic toggle function
CREATE OR REPLACE FUNCTION toggle_post_favorite_atomic(
  p_user_id UUID,
  p_post_id INTEGER
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_was_added BOOLEAN;
  v_like_count INTEGER;
BEGIN
  -- Try to insert the favorite
  INSERT INTO favorites (user_id, post_id)
  VALUES (p_user_id, p_post_id)
  ON CONFLICT (user_id, post_id) DO NOTHING;

  -- Check if insert succeeded (row was added)
  IF FOUND THEN
    v_was_added := TRUE;
    -- Increment counter atomically
    UPDATE posts
    SET post_like_counter = COALESCE(post_like_counter, 0) + 1
    WHERE id = p_post_id
    RETURNING post_like_counter INTO v_like_count;
  ELSE
    -- Row already existed, so delete it (toggle off)
    DELETE FROM favorites
    WHERE user_id = p_user_id AND post_id = p_post_id;

    v_was_added := FALSE;
    -- Decrement counter atomically
    UPDATE posts
    SET post_like_counter = GREATEST(0, COALESCE(post_like_counter, 0) - 1)
    WHERE id = p_post_id
    RETURNING post_like_counter INTO v_like_count;
  END IF;

  RETURN json_build_object(
    'is_favorited', v_was_added,
    'like_count', COALESCE(v_like_count, 0),
    'was_added', v_was_added
  );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION toggle_post_favorite_atomic(UUID, INTEGER) TO authenticated;

-- =============================================================================
-- Forum Comment with Server-Side Depth Calculation RPC
-- =============================================================================

-- Drop if exists
DROP FUNCTION IF EXISTS create_forum_comment_with_depth(INTEGER, TEXT, INTEGER);

-- Create comment with automatic depth calculation
CREATE OR REPLACE FUNCTION create_forum_comment_with_depth(
  p_forum_id INTEGER,
  p_comment TEXT,
  p_parent_id INTEGER DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_depth INTEGER;
  v_max_depth CONSTANT INTEGER := 5;
  v_new_comment forum_comments%ROWTYPE;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated';
  END IF;

  -- Calculate depth
  IF p_parent_id IS NULL THEN
    v_depth := 0;
  ELSE
    -- Get parent's depth
    SELECT depth INTO v_depth
    FROM forum_comments
    WHERE id = p_parent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent comment not found';
    END IF;

    -- Increment depth for reply
    v_depth := v_depth + 1;

    -- Enforce max depth
    IF v_depth > v_max_depth THEN
      RAISE EXCEPTION 'Maximum comment depth (%) exceeded', v_max_depth;
    END IF;
  END IF;

  -- Insert the comment
  INSERT INTO forum_comments (
    user_id,
    forum_id,
    parent_id,
    comment,
    depth,
    created_at,
    updated_at
  )
  VALUES (
    v_user_id,
    p_forum_id,
    p_parent_id,
    p_comment,
    v_depth,
    NOW(),
    NOW()
  )
  RETURNING * INTO v_new_comment;

  -- Increment reply counter on parent if this is a reply
  IF p_parent_id IS NOT NULL THEN
    UPDATE forum_comments
    SET replies_counter = COALESCE(replies_counter, 0) + 1
    WHERE id = p_parent_id;
  END IF;

  -- Increment comment counter on post
  UPDATE forum_posts
  SET comments_counter = COALESCE(comments_counter, 0) + 1
  WHERE id = p_forum_id;

  RETURN row_to_json(v_new_comment);
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION create_forum_comment_with_depth(INTEGER, TEXT, INTEGER) TO authenticated;

-- =============================================================================
-- Hot Score Time-Decay Update RPC
-- =============================================================================

-- Drop if exists
DROP FUNCTION IF EXISTS update_hot_scores();

-- Create hot score update function (Reddit-style decay)
CREATE OR REPLACE FUNCTION update_hot_scores()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated_count INTEGER;
BEGIN
  -- Reddit-style hot score: log10(score) + (created_at - epoch) / 45000
  -- Higher score = hotter, time decay over ~12.5 hours per point
  UPDATE forum_posts
  SET hot_score = (
    LOG(GREATEST(ABS(likes_counter - 1), 1)) +
    EXTRACT(EPOCH FROM created_at) / 45000.0
  )
  WHERE created_at > NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  RETURN v_updated_count;
END;
$$;

-- Grant execute to service role only (for scheduled jobs)
GRANT EXECUTE ON FUNCTION update_hot_scores() TO service_role;

-- =============================================================================
-- Comment: Index for faster favorite lookups
-- =============================================================================

-- Create index if not exists
CREATE INDEX IF NOT EXISTS idx_favorites_user_post
ON favorites (user_id, post_id);

-- Create index for forum comments by parent
CREATE INDEX IF NOT EXISTS idx_forum_comments_parent
ON forum_comments (parent_id)
WHERE parent_id IS NOT NULL;

-- Create index for hot score sorting
CREATE INDEX IF NOT EXISTS idx_forum_posts_hot_score
ON forum_posts (hot_score DESC)
WHERE created_at > NOW() - INTERVAL '7 days';
