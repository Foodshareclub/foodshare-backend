-- =============================================================================
-- Query Timeout Guards for Expensive RPC Functions
-- =============================================================================
-- Adds statement timeouts to RPC functions to prevent runaway queries.
-- Protects against denial of service from complex queries under load.
-- =============================================================================

-- =============================================================================
-- Update get_personalized_feed with timeout
-- =============================================================================

CREATE OR REPLACE FUNCTION get_personalized_feed(
  p_user_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_km DOUBLE PRECISION DEFAULT 10,
  p_limit INT DEFAULT 20,
  p_cursor TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Prevent runaway queries
  SET LOCAL statement_timeout = '5s';

  -- Get personalized recommendations
  RETURN (
    SELECT jsonb_build_object(
      'listings', COALESCE(jsonb_agg(listing), '[]'::JSONB),
      'nextCursor', (
        SELECT MIN(created_at) FROM (
          SELECT created_at FROM posts
          WHERE is_active = TRUE
            AND deleted_at IS NULL
            AND profile_id != p_user_id
          ORDER BY created_at DESC
          LIMIT p_limit
        ) sub
      )
    )
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'title', p.post_name,
        'description', p.post_description,
        'images', p.images,
        'latitude', p.latitude,
        'longitude', p.longitude,
        'category_id', p.category_id,
        'profile_id', p.profile_id,
        'created_at', p.created_at,
        'score', COALESCE(us.preference_score, 0) *
                 (1.0 / (1.0 + EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 86400))
      ) AS listing
      FROM posts p
      LEFT JOIN user_scores us ON us.user_id = p_user_id AND us.post_id = p.id
      WHERE p.is_active = TRUE
        AND p.deleted_at IS NULL
        AND p.profile_id != p_user_id
        AND (p_cursor IS NULL OR p.created_at < p_cursor)
      ORDER BY
        COALESCE(us.preference_score, 0) DESC,
        p.created_at DESC
      LIMIT p_limit
    ) listings
  );
END;
$$;

-- =============================================================================
-- Update get_search_results with timeout
-- =============================================================================

CREATE OR REPLACE FUNCTION get_search_results(
  p_query TEXT,
  p_user_id UUID DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT NULL,
  p_lng DOUBLE PRECISION DEFAULT NULL,
  p_radius_km DOUBLE PRECISION DEFAULT 10,
  p_category_id INT DEFAULT NULL,
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_search_vector TSQUERY;
BEGIN
  -- Prevent runaway queries
  SET LOCAL statement_timeout = '5s';

  -- Build search vector
  v_search_vector := plainto_tsquery('english', p_query);

  -- Execute search
  SELECT jsonb_build_object(
    'results', COALESCE(jsonb_agg(result), '[]'::JSONB),
    'total', (
      SELECT COUNT(*) FROM posts p
      WHERE p.is_active = TRUE
        AND p.deleted_at IS NULL
        AND (p.search_vector @@ v_search_vector OR p.post_name ILIKE '%' || p_query || '%')
        AND (p_category_id IS NULL OR p.category_id = p_category_id)
    )
  )
  INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', p.id,
      'title', p.post_name,
      'description', p.post_description,
      'images', p.images,
      'latitude', p.latitude,
      'longitude', p.longitude,
      'category_id', p.category_id,
      'profile_id', p.profile_id,
      'created_at', p.created_at,
      'rank', ts_rank(p.search_vector, v_search_vector)
    ) AS result
    FROM posts p
    WHERE p.is_active = TRUE
      AND p.deleted_at IS NULL
      AND (p.search_vector @@ v_search_vector OR p.post_name ILIKE '%' || p_query || '%')
      AND (p_category_id IS NULL OR p.category_id = p_category_id)
    ORDER BY ts_rank(p.search_vector, v_search_vector) DESC, p.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ) results;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Update get_user_analytics with timeout
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_analytics(
  p_user_id UUID,
  p_days INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  -- Prevent runaway queries on analytics
  SET LOCAL statement_timeout = '10s';

  SELECT jsonb_build_object(
    'views', (
      SELECT jsonb_agg(day_data)
      FROM (
        SELECT date_trunc('day', created_at)::DATE AS day,
               COUNT(*) AS count
        FROM post_views
        WHERE post_id IN (SELECT id FROM posts WHERE profile_id = p_user_id)
          AND created_at > NOW() - (p_days || ' days')::INTERVAL
        GROUP BY date_trunc('day', created_at)
        ORDER BY day DESC
      ) day_data
    ),
    'messages', (
      SELECT jsonb_agg(day_data)
      FROM (
        SELECT date_trunc('day', created_at)::DATE AS day,
               COUNT(*) AS count
        FROM messages m
        JOIN rooms r ON r.id = m.room_id
        WHERE p_user_id = ANY(r.participant_ids)
          AND m.created_at > NOW() - (p_days || ' days')::INTERVAL
        GROUP BY date_trunc('day', created_at)
        ORDER BY day DESC
      ) day_data
    ),
    'listings', (
      SELECT jsonb_build_object(
        'active', COUNT(*) FILTER (WHERE is_active = TRUE),
        'total', COUNT(*),
        'views_total', COALESCE(SUM(view_count), 0)
      )
      FROM posts
      WHERE profile_id = p_user_id AND deleted_at IS NULL
    ),
    'impact', (
      SELECT row_to_json(ui)
      FROM user_impact_stats ui
      WHERE ui.user_id = p_user_id
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Update get_delta_sync with timeout
-- =============================================================================

CREATE OR REPLACE FUNCTION get_delta_sync(
  p_user_id UUID,
  p_tables TEXT[],
  p_checkpoints JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  v_table TEXT;
  v_checkpoint BIGINT;
  v_table_data JSONB;
  v_total_changes INT := 0;
BEGIN
  -- Prevent runaway queries during sync
  SET LOCAL statement_timeout = '10s';

  FOREACH v_table IN ARRAY p_tables
  LOOP
    -- Get checkpoint for this table
    v_checkpoint := COALESCE((p_checkpoints->>v_table)::BIGINT, 0);

    -- Get changes based on table
    CASE v_table
      WHEN 'posts' THEN
        SELECT jsonb_build_object(
          'changes', COALESCE(jsonb_agg(row_to_json(p)), '[]'::JSONB),
          'checkpoint', COALESCE(MAX(p.sync_version), v_checkpoint),
          'hasMore', COUNT(*) > 100
        )
        INTO v_table_data
        FROM (
          SELECT id, post_name, post_description, images, latitude, longitude,
                 is_active, created_at, updated_at, sync_version
          FROM posts
          WHERE sync_version > v_checkpoint
            AND deleted_at IS NULL
          ORDER BY sync_version
          LIMIT 101
        ) p;

      WHEN 'notifications' THEN
        SELECT jsonb_build_object(
          'changes', COALESCE(jsonb_agg(row_to_json(n)), '[]'::JSONB),
          'checkpoint', COALESCE(MAX(n.sync_version), v_checkpoint),
          'hasMore', COUNT(*) > 100
        )
        INTO v_table_data
        FROM (
          SELECT id, type, title, body, data, read_at, created_at, sync_version
          FROM notifications
          WHERE profile_id = p_user_id
            AND sync_version > v_checkpoint
          ORDER BY sync_version
          LIMIT 101
        ) n;

      WHEN 'rooms' THEN
        SELECT jsonb_build_object(
          'changes', COALESCE(jsonb_agg(row_to_json(r)), '[]'::JSONB),
          'checkpoint', COALESCE(MAX(r.sync_version), v_checkpoint),
          'hasMore', COUNT(*) > 100
        )
        INTO v_table_data
        FROM (
          SELECT id, name, participant_ids, unread_count, last_message_at,
                 created_at, updated_at, sync_version
          FROM rooms
          WHERE p_user_id = ANY(participant_ids)
            AND sync_version > v_checkpoint
            AND deleted_at IS NULL
          ORDER BY sync_version
          LIMIT 101
        ) r;

      WHEN 'profiles' THEN
        SELECT jsonb_build_object(
          'changes', COALESCE(jsonb_agg(row_to_json(pr)), '[]'::JSONB),
          'checkpoint', COALESCE(MAX(pr.sync_version), v_checkpoint),
          'hasMore', COUNT(*) > 100
        )
        INTO v_table_data
        FROM (
          SELECT id, display_name, avatar_url, bio, city, is_verified,
                 rating_average, rating_count, sync_version
          FROM profiles
          WHERE sync_version > v_checkpoint
          ORDER BY sync_version
          LIMIT 101
        ) pr;

      WHEN 'messages' THEN
        SELECT jsonb_build_object(
          'changes', COALESCE(jsonb_agg(row_to_json(m)), '[]'::JSONB),
          'checkpoint', COALESCE(MAX(m.sync_version), v_checkpoint),
          'hasMore', COUNT(*) > 100
        )
        INTO v_table_data
        FROM (
          SELECT m.id, m.room_id, m.profile_id, m.content, m.message_type,
                 m.created_at, m.sync_version
          FROM messages m
          JOIN rooms r ON r.id = m.room_id
          WHERE p_user_id = ANY(r.participant_ids)
            AND m.sync_version > v_checkpoint
          ORDER BY m.sync_version
          LIMIT 101
        ) m;

      ELSE
        v_table_data := jsonb_build_object(
          'changes', '[]'::JSONB,
          'checkpoint', v_checkpoint,
          'hasMore', false
        );
    END CASE;

    -- Add to result
    v_result := v_result || jsonb_build_object(v_table, v_table_data);

    -- Count changes
    v_total_changes := v_total_changes + jsonb_array_length(v_table_data->'changes');
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'tables', v_result,
    'meta', jsonb_build_object(
      'totalChanges', v_total_changes,
      'syncedAt', NOW()
    )
  );
END;
$$;

-- =============================================================================
-- Create rate limit at database level
-- =============================================================================

-- Rate limit entries table
CREATE TABLE IF NOT EXISTS rate_limit_entries (
  id BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_rate_limit_entries_key_created
  ON rate_limit_entries(key, created_at DESC);

-- Function to check rate limit at database level
CREATE OR REPLACE FUNCTION check_rate_limit_db(
  p_key TEXT,
  p_limit INT,
  p_window_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_count INT;
BEGIN
  -- Count entries in window
  SELECT COUNT(*) INTO current_count
  FROM rate_limit_entries
  WHERE key = p_key
    AND created_at > NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  -- Check if over limit
  IF current_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  -- Record this request
  INSERT INTO rate_limit_entries (key) VALUES (p_key);

  RETURN TRUE;
END;
$$;

-- Cleanup function for old rate limit entries
CREATE OR REPLACE FUNCTION cleanup_rate_limit_entries()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INT;
BEGIN
  DELETE FROM rate_limit_entries
  WHERE created_at < NOW() - INTERVAL '1 hour';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_personalized_feed TO authenticated;
GRANT EXECUTE ON FUNCTION get_search_results TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_analytics TO authenticated;
GRANT EXECUTE ON FUNCTION get_delta_sync TO authenticated;
GRANT EXECUTE ON FUNCTION check_rate_limit_db TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_rate_limit_entries TO service_role;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION get_personalized_feed IS 'Returns personalized feed with preference scoring - 5s timeout guard';
COMMENT ON FUNCTION get_search_results IS 'Full-text search with ranking - 5s timeout guard';
COMMENT ON FUNCTION get_user_analytics IS 'User analytics aggregation - 10s timeout guard';
COMMENT ON FUNCTION get_delta_sync IS 'Delta sync for offline-first clients - 10s timeout guard';
COMMENT ON FUNCTION check_rate_limit_db IS 'Database-level rate limiting for sensitive operations';
COMMENT ON FUNCTION cleanup_rate_limit_entries IS 'Cleanup old rate limit entries - run hourly';
