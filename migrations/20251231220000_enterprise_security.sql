-- ============================================================================
-- Enterprise Security Migration
-- Phase 4A: Optimistic Locking + Idempotency Keys + Transactional RPCs
-- ============================================================================

-- ============================================================================
-- Part 1: Version Columns for Optimistic Locking
-- Prevents concurrent update conflicts (lost updates)
-- ============================================================================

-- Add version column to posts table
ALTER TABLE posts ADD COLUMN IF NOT EXISTS version int DEFAULT 1;

-- Add version column to forum_posts table
ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS version int DEFAULT 1;

-- Add version column to challenges table
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS version int DEFAULT 1;

-- Add version column to forum_comments table (for editing comments)
ALTER TABLE forum_comments ADD COLUMN IF NOT EXISTS version int DEFAULT 1;

-- Trigger to auto-increment version on update (optional - can be done in app code)
CREATE OR REPLACE FUNCTION increment_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only increment if version check passes (app should pass expected version)
  NEW.version := OLD.version + 1;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables (disabled by default - enable if preferred)
-- CREATE TRIGGER posts_version_trigger
--   BEFORE UPDATE ON posts
--   FOR EACH ROW
--   EXECUTE FUNCTION increment_version();

COMMENT ON COLUMN posts.version IS 'Optimistic locking version counter';
COMMENT ON COLUMN forum_posts.version IS 'Optimistic locking version counter';
COMMENT ON COLUMN challenges.version IS 'Optimistic locking version counter';
COMMENT ON COLUMN forum_comments.version IS 'Optimistic locking version counter';

-- ============================================================================
-- Part 2: Idempotency Keys Table
-- Prevents duplicate operations from network retries
-- ============================================================================

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key uuid PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  operation text NOT NULL, -- e.g., 'create_post', 'send_message'
  response jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Index for cleanup job
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys(expires_at);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user
  ON idempotency_keys(user_id, key);

-- RLS policies
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Users can only see their own idempotency keys
CREATE POLICY "Users can view own idempotency keys"
  ON idempotency_keys
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Users can insert their own idempotency keys
CREATE POLICY "Users can insert own idempotency keys"
  ON idempotency_keys
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Function to check and store idempotency key
CREATE OR REPLACE FUNCTION check_idempotency_key(
  p_key uuid,
  p_operation text,
  p_response jsonb DEFAULT NULL,
  p_ttl_hours int DEFAULT 24
)
RETURNS jsonb AS $$
DECLARE
  v_existing jsonb;
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();

  -- Check for existing key
  SELECT response INTO v_existing
  FROM idempotency_keys
  WHERE key = p_key
    AND user_id = v_user_id
    AND expires_at > now();

  IF v_existing IS NOT NULL THEN
    -- Return cached response
    RETURN jsonb_build_object(
      'cached', true,
      'response', v_existing
    );
  END IF;

  -- If response provided, store it
  IF p_response IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, user_id, operation, response, expires_at)
    VALUES (
      p_key,
      v_user_id,
      p_operation,
      p_response,
      now() + (p_ttl_hours || ' hours')::interval
    )
    ON CONFLICT (key) DO UPDATE
    SET response = EXCLUDED.response,
        expires_at = EXCLUDED.expires_at;
  END IF;

  RETURN jsonb_build_object('cached', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup function for expired keys (run via pg_cron or Edge Function)
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency_keys()
RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM idempotency_keys
  WHERE expires_at < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE idempotency_keys IS 'Stores idempotency keys to prevent duplicate operations from network retries';
COMMENT ON FUNCTION check_idempotency_key IS 'Check if operation was already performed, optionally store result';

-- ============================================================================
-- Part 3: Transactional Chat Room Creation
-- Ensures room, members, and activity log are all created atomically
-- ============================================================================

CREATE OR REPLACE FUNCTION create_chat_room_safe(
  p_participant_ids uuid[],
  p_name text DEFAULT NULL,
  p_room_type text DEFAULT 'direct'
)
RETURNS jsonb AS $$
DECLARE
  v_room_id uuid;
  v_current_user uuid;
  v_all_participants uuid[];
BEGIN
  v_current_user := auth.uid();

  IF v_current_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Include current user in participants
  v_all_participants := array_append(p_participant_ids, v_current_user);
  v_all_participants := ARRAY(SELECT DISTINCT unnest(v_all_participants));

  -- For direct chats, check if room already exists between these users
  IF p_room_type = 'direct' AND array_length(v_all_participants, 1) = 2 THEN
    SELECT r.id INTO v_room_id
    FROM chat_rooms r
    WHERE r.room_type = 'direct'
      AND (
        SELECT COUNT(DISTINCT rm.profile_id)
        FROM room_members rm
        WHERE rm.room_id = r.id
          AND rm.profile_id = ANY(v_all_participants)
      ) = 2
      AND (
        SELECT COUNT(*)
        FROM room_members rm
        WHERE rm.room_id = r.id
      ) = 2;

    IF v_room_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'room_id', v_room_id,
        'created', false,
        'message', 'Existing room found'
      );
    END IF;
  END IF;

  -- Create room
  INSERT INTO chat_rooms (name, room_type, created_by)
  VALUES (p_name, p_room_type, v_current_user)
  RETURNING id INTO v_room_id;

  -- Add all participants
  INSERT INTO room_members (room_id, profile_id, joined_at)
  SELECT v_room_id, unnest(v_all_participants), now();

  -- Log room creation activity
  INSERT INTO room_activities (room_id, profile_id, activity_type, created_at)
  VALUES (v_room_id, v_current_user, 'room_created', now());

  RETURN jsonb_build_object(
    'room_id', v_room_id,
    'created', true,
    'message', 'Room created successfully'
  );

EXCEPTION WHEN OTHERS THEN
  -- Transaction automatically rolls back
  RAISE EXCEPTION 'Failed to create chat room: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION create_chat_room_safe IS 'Atomically creates a chat room with members and activity log';

-- ============================================================================
-- Part 4: User Challenge Rank (Fixes N+1 Query)
-- Single query to get a user's rank without fetching entire leaderboard
-- ============================================================================

CREATE OR REPLACE FUNCTION get_user_challenge_rank(p_user_id uuid DEFAULT NULL)
RETURNS TABLE(
  user_id uuid,
  rank bigint,
  total_xp int,
  completed_count int,
  tier text
) AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := COALESCE(p_user_id, auth.uid());

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID required';
  END IF;

  RETURN QUERY
  WITH user_stats AS (
    SELECT
      cp.profile_id,
      COALESCE(SUM(c.xp_reward), 0)::int AS total_xp,
      COUNT(*) FILTER (WHERE cp.is_completed)::int AS completed_count
    FROM challenge_participants cp
    LEFT JOIN challenges c ON c.id = cp.challenge_id
    WHERE cp.is_completed = true
    GROUP BY cp.profile_id
  ),
  ranked AS (
    SELECT
      us.profile_id,
      us.total_xp,
      us.completed_count,
      RANK() OVER (ORDER BY us.total_xp DESC, us.completed_count DESC) AS rank,
      CASE
        WHEN us.total_xp >= 10000 THEN 'legend'
        WHEN us.total_xp >= 5000 THEN 'master'
        WHEN us.total_xp >= 2500 THEN 'expert'
        WHEN us.total_xp >= 1000 THEN 'advanced'
        WHEN us.total_xp >= 500 THEN 'intermediate'
        ELSE 'beginner'
      END AS tier
    FROM user_stats us
  )
  SELECT
    r.profile_id,
    r.rank,
    r.total_xp,
    r.completed_count,
    r.tier
  FROM ranked r
  WHERE r.profile_id = v_user_id;

  -- If user has no completions, return default values
  IF NOT FOUND THEN
    RETURN QUERY
    SELECT
      v_user_id,
      0::bigint,
      0::int,
      0::int,
      'beginner'::text;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION get_user_challenge_rank IS 'Get user challenge rank without N+1 query';

-- ============================================================================
-- Part 5: Forum Stats (Efficient Aggregation)
-- Uses COUNT DISTINCT in SQL instead of fetching all rows
-- ============================================================================

CREATE OR REPLACE FUNCTION get_forum_stats(p_category_slug text DEFAULT NULL)
RETURNS TABLE(
  total_posts bigint,
  total_comments bigint,
  unique_authors bigint,
  posts_today bigint,
  active_discussions bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT fp.id) AS total_posts,
    (SELECT COUNT(*) FROM forum_comments fc
     JOIN forum_posts fp2 ON fp2.id = fc.post_id
     WHERE (p_category_slug IS NULL OR fp2.category_slug = p_category_slug)
    ) AS total_comments,
    COUNT(DISTINCT fp.profile_id) AS unique_authors,
    COUNT(DISTINCT fp.id) FILTER (
      WHERE fp.created_at >= CURRENT_DATE
    ) AS posts_today,
    COUNT(DISTINCT fp.id) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM forum_comments fc
        WHERE fc.post_id = fp.id
          AND fc.created_at >= now() - interval '24 hours'
      )
    ) AS active_discussions
  FROM forum_posts fp
  WHERE (p_category_slug IS NULL OR fp.category_slug = p_category_slug)
    AND fp.is_published = true;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION get_forum_stats IS 'Get forum statistics efficiently with SQL aggregation';

-- ============================================================================
-- Part 6: Optimistic Locking Helper
-- Check version and update atomically
-- ============================================================================

CREATE OR REPLACE FUNCTION update_with_version_check(
  p_table_name text,
  p_id bigint,
  p_expected_version int,
  p_updates jsonb
)
RETURNS jsonb AS $$
DECLARE
  v_current_version int;
  v_new_version int;
  v_result jsonb;
BEGIN
  -- Get current version
  EXECUTE format(
    'SELECT version FROM %I WHERE id = $1',
    p_table_name
  ) INTO v_current_version USING p_id;

  IF v_current_version IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'NOT_FOUND',
      'message', 'Record not found'
    );
  END IF;

  IF v_current_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VERSION_CONFLICT',
      'message', 'Record was modified by another user',
      'current_version', v_current_version,
      'expected_version', p_expected_version
    );
  END IF;

  -- Perform update with new version
  v_new_version := v_current_version + 1;

  EXECUTE format(
    'UPDATE %I SET version = $1, updated_at = now() WHERE id = $2 AND version = $3 RETURNING to_jsonb(%I.*)',
    p_table_name, p_table_name
  ) INTO v_result USING v_new_version, p_id, p_expected_version;

  IF v_result IS NULL THEN
    -- Race condition - another update happened between check and update
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VERSION_CONFLICT',
      'message', 'Record was modified during update'
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'new_version', v_new_version,
    'record', v_result
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION update_with_version_check IS 'Perform update with optimistic locking version check';

-- ============================================================================
-- Grant permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION check_idempotency_key TO authenticated;
GRANT EXECUTE ON FUNCTION create_chat_room_safe TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_challenge_rank TO authenticated;
GRANT EXECUTE ON FUNCTION get_forum_stats TO authenticated;
GRANT EXECUTE ON FUNCTION update_with_version_check TO authenticated;
