-- =============================================================================
-- Correlation ID Propagation for Distributed Tracing
-- =============================================================================
-- Enables end-to-end request tracing from Edge Functions through database.
-- Correlation IDs are set via session config and picked up by audit triggers.
-- =============================================================================

-- =============================================================================
-- Session Configuration Helpers
-- =============================================================================

-- Function to set correlation ID for current session
-- Called by Edge Functions before RPC calls
CREATE OR REPLACE FUNCTION set_request_context(
  p_correlation_id TEXT DEFAULT NULL,
  p_client_ip TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_platform TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  -- Set session variables for audit logging
  IF p_correlation_id IS NOT NULL THEN
    PERFORM set_config('app.correlation_id', p_correlation_id, true);
  END IF;

  IF p_client_ip IS NOT NULL THEN
    PERFORM set_config('app.client_ip', p_client_ip, true);
  END IF;

  IF p_user_agent IS NOT NULL THEN
    PERFORM set_config('app.user_agent', p_user_agent, true);
  END IF;

  IF p_platform IS NOT NULL THEN
    PERFORM set_config('app.platform', p_platform, true);
  END IF;
END;
$$;

-- Function to get current correlation ID
CREATE OR REPLACE FUNCTION get_correlation_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.correlation_id', true), '');
$$;

-- Function to get current platform
CREATE OR REPLACE FUNCTION get_request_platform()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.platform', true), '');
$$;

-- =============================================================================
-- Update Existing RPC Functions to Accept Correlation ID
-- =============================================================================

-- Update get_user_rooms to accept correlation ID
CREATE OR REPLACE FUNCTION get_user_rooms(
  p_user_id UUID,
  p_limit INT DEFAULT 20,
  p_cursor TIMESTAMPTZ DEFAULT NULL,
  p_correlation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Set correlation ID for audit trail
  IF p_correlation_id IS NOT NULL THEN
    PERFORM set_config('app.correlation_id', p_correlation_id, true);
  END IF;

  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  RETURN (
    SELECT jsonb_agg(room_data)
    FROM (
      SELECT jsonb_build_object(
        'room_id', r.id,
        'room_name', r.name,
        'room_type', r.room_type,
        'unread_count', rm.unread_count,
        'is_muted', rm.is_muted,
        'is_pinned', rm.is_pinned,
        'last_message_content', (
          SELECT content FROM messages m
          WHERE m.room_id = r.id
          ORDER BY created_at DESC
          LIMIT 1
        ),
        'last_message_at', r.last_message_at,
        'participant_count', (
          SELECT COUNT(*) FROM room_members rm2
          WHERE rm2.room_id = r.id
        ),
        'updated_at', COALESCE(r.last_message_at, r.updated_at)
      ) AS room_data
      FROM chat_rooms r
      JOIN room_members rm ON rm.room_id = r.id AND rm.profile_id = p_user_id
      WHERE r.deleted_at IS NULL
        AND (p_cursor IS NULL OR COALESCE(r.last_message_at, r.updated_at) < p_cursor)
      ORDER BY
        rm.is_pinned DESC,
        COALESCE(r.last_message_at, r.updated_at) DESC
      LIMIT p_limit
    ) rooms
  );
END;
$$;

-- Update get_bff_feed_data to accept correlation ID
DROP FUNCTION IF EXISTS get_bff_feed_data(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, INT, TIMESTAMPTZ, TEXT, INT);

CREATE OR REPLACE FUNCTION get_bff_feed_data(
  p_user_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_km DOUBLE PRECISION DEFAULT 10,
  p_limit INT DEFAULT 20,
  p_cursor TIMESTAMPTZ DEFAULT NULL,
  p_post_type TEXT DEFAULT NULL,
  p_category_id INT DEFAULT NULL,
  p_correlation_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_listings JSONB;
  v_unread_notifications INT;
  v_unread_messages INT;
  v_total_count INT;
BEGIN
  -- Set correlation ID for audit trail
  IF p_correlation_id IS NOT NULL THEN
    PERFORM set_config('app.correlation_id', p_correlation_id, true);
  END IF;

  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  -- Calculate bounding box for efficient spatial query
  DECLARE
    v_lat_delta DOUBLE PRECISION := p_radius_km / 111.0;
    v_lng_delta DOUBLE PRECISION := p_radius_km / (111.0 * COS(RADIANS(p_lat)));
    v_min_lat DOUBLE PRECISION := p_lat - v_lat_delta;
    v_max_lat DOUBLE PRECISION := p_lat + v_lat_delta;
    v_min_lng DOUBLE PRECISION := p_lng - v_lng_delta;
    v_max_lng DOUBLE PRECISION := p_lng + v_lng_delta;
  BEGIN
    -- Get nearby listings with owner info
    SELECT jsonb_agg(listing_row), COUNT(*)::INT
    INTO v_listings, v_total_count
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'post_name', p.post_name,
        'post_description', p.post_description,
        'images', p.images,
        'post_type', p.post_type,
        'latitude', p.latitude,
        'longitude', p.longitude,
        'pickup_address', p.pickup_address,
        'pickup_time', p.pickup_time,
        'category_id', p.category_id,
        'category_name', c.name,
        'category_icon', c.icon,
        'profile_id', p.profile_id,
        'owner_name', pr.display_name,
        'owner_avatar', pr.avatar_url,
        'owner_rating', pr.rating_average,
        'created_at', p.created_at,
        'expires_at', p.expires_at,
        'distance_km', (
          6371 * ACOS(
            COS(RADIANS(p_lat)) * COS(RADIANS(p.latitude)) *
            COS(RADIANS(p.longitude) - RADIANS(p_lng)) +
            SIN(RADIANS(p_lat)) * SIN(RADIANS(p.latitude))
          )
        )
      ) AS listing_row
      FROM posts p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN profiles pr ON pr.id = p.profile_id
      WHERE p.is_active = TRUE
        AND p.deleted_at IS NULL
        AND p.latitude BETWEEN v_min_lat AND v_max_lat
        AND p.longitude BETWEEN v_min_lng AND v_max_lng
        AND (p_cursor IS NULL OR p.created_at < p_cursor)
        AND (p_post_type IS NULL OR p.post_type = p_post_type)
        AND (p_category_id IS NULL OR p.category_id = p_category_id)
        AND p.profile_id != p_user_id
      ORDER BY p.created_at DESC
      LIMIT p_limit
    ) listings;

    -- Get unread notification count
    SELECT COUNT(*)::INT INTO v_unread_notifications
    FROM notifications
    WHERE profile_id = p_user_id
      AND read_at IS NULL;

    -- Get unread message count
    SELECT COUNT(*)::INT INTO v_unread_messages
    FROM rooms
    WHERE p_user_id = ANY(participant_ids)
      AND unread_count > 0
      AND deleted_at IS NULL;

    -- Build result
    v_result := jsonb_build_object(
      'listings', COALESCE(v_listings, '[]'::JSONB),
      'unread_notifications', v_unread_notifications,
      'unread_messages', v_unread_messages,
      'total_count', COALESCE(v_total_count, 0)
    );

    RETURN v_result;
  END;
END;
$$;

-- =============================================================================
-- Metrics Table for Request Tracing
-- =============================================================================

-- Create request traces table if not exists
CREATE TABLE IF NOT EXISTS metrics.request_traces (
  id BIGSERIAL PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  function_name TEXT NOT NULL,
  user_id UUID,
  platform TEXT,
  client_ip INET,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INT,
  status TEXT CHECK (status IN ('success', 'error', 'timeout')),
  error_message TEXT,
  metadata JSONB DEFAULT '{}'
);

-- Index for correlation ID lookups
CREATE INDEX IF NOT EXISTS idx_request_traces_correlation
  ON metrics.request_traces(correlation_id);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_request_traces_started
  ON metrics.request_traces(started_at DESC);

-- Index for user activity
CREATE INDEX IF NOT EXISTS idx_request_traces_user
  ON metrics.request_traces(user_id, started_at DESC)
  WHERE user_id IS NOT NULL;

-- =============================================================================
-- Helper Function to Log Request Trace
-- =============================================================================

CREATE OR REPLACE FUNCTION log_request_trace(
  p_correlation_id TEXT,
  p_function_name TEXT,
  p_user_id UUID DEFAULT NULL,
  p_platform TEXT DEFAULT NULL,
  p_client_ip TEXT DEFAULT NULL,
  p_duration_ms INT DEFAULT NULL,
  p_status TEXT DEFAULT 'success',
  p_error_message TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO metrics.request_traces (
    correlation_id,
    function_name,
    user_id,
    platform,
    client_ip,
    duration_ms,
    completed_at,
    status,
    error_message,
    metadata
  ) VALUES (
    p_correlation_id,
    p_function_name,
    p_user_id,
    p_platform,
    p_client_ip::INET,
    p_duration_ms,
    NOW(),
    p_status,
    p_error_message,
    p_metadata
  );
EXCEPTION WHEN OTHERS THEN
  -- Don't fail the request if tracing fails
  NULL;
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION set_request_context TO authenticated;
GRANT EXECUTE ON FUNCTION get_correlation_id TO authenticated;
GRANT EXECUTE ON FUNCTION get_request_platform TO authenticated;
GRANT EXECUTE ON FUNCTION log_request_trace TO authenticated;

-- =============================================================================
-- Comments
-- =============================================================================

COMMENT ON FUNCTION set_request_context IS 'Sets request context (correlation ID, client info) for audit trail and distributed tracing';
COMMENT ON FUNCTION get_correlation_id IS 'Returns the correlation ID set for the current session';
COMMENT ON FUNCTION log_request_trace IS 'Logs a request trace for observability and debugging';
COMMENT ON TABLE metrics.request_traces IS 'Stores request traces for distributed tracing and observability';
