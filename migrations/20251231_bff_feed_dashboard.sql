-- =============================================================================
-- BFF Feed and Dashboard RPC Functions
-- =============================================================================
-- Aggregated RPC functions for Backend-for-Frontend layer.
-- Each function returns all data needed for a screen in a single call.
-- =============================================================================

-- =============================================================================
-- BFF Feed Data
-- =============================================================================
-- Returns aggregated data for the home feed screen:
-- - Nearby listings with owner profiles
-- - Unread notification count
-- - Unread message count
-- =============================================================================

CREATE OR REPLACE FUNCTION get_bff_feed_data(
  p_user_id UUID,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_km DOUBLE PRECISION DEFAULT 10,
  p_limit INT DEFAULT 20,
  p_cursor TIMESTAMPTZ DEFAULT NULL,
  p_post_type TEXT DEFAULT NULL,
  p_category_id INT DEFAULT NULL
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
  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  -- Calculate bounding box for efficient spatial query
  -- 1 degree latitude ≈ 111 km
  -- 1 degree longitude ≈ 111 km * cos(latitude)
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
        -- Exclude user's own listings
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
-- User Dashboard Data
-- =============================================================================
-- Returns aggregated data for user dashboard:
-- - User profile
-- - Stats (items shared, received, ratings)
-- - Impact metrics
-- - Unread counts
-- - Recent listings
-- - Badges
-- =============================================================================

CREATE OR REPLACE FUNCTION get_user_dashboard(
  p_user_id UUID,
  p_include_listings BOOLEAN DEFAULT TRUE,
  p_listings_limit INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_profile JSONB;
  v_stats JSONB;
  v_impact JSONB;
  v_recent_listings JSONB;
  v_badges JSONB;
  v_unread_notifications INT;
  v_unread_messages INT;
  v_pending_requests INT;
BEGIN
  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  -- Get user profile
  SELECT jsonb_build_object(
    'id', id,
    'display_name', display_name,
    'email', email,
    'avatar_url', avatar_url,
    'bio', bio,
    'latitude', latitude,
    'longitude', longitude,
    'city', city,
    'created_at', created_at,
    'is_verified', is_verified
  )
  INTO v_profile
  FROM profiles
  WHERE id = p_user_id;

  -- Get user stats
  SELECT jsonb_build_object(
    'items_shared', COALESCE(items_shared, 0),
    'items_received', COALESCE(items_received, 0),
    'active_listings', (
      SELECT COUNT(*) FROM posts
      WHERE profile_id = p_user_id AND is_active = TRUE AND deleted_at IS NULL
    ),
    'rating_average', rating_average,
    'rating_count', COALESCE(rating_count, 0),
    'completed_transactions', COALESCE(completed_transactions, 0)
  )
  INTO v_stats
  FROM profiles
  WHERE id = p_user_id;

  -- Get impact metrics (if table exists)
  SELECT jsonb_build_object(
    'food_saved_kg', COALESCE(food_saved_kg, 0),
    'co2_saved_kg', COALESCE(co2_saved_kg, 0),
    'meals_provided', COALESCE(meals_provided, 0),
    'monthly_rank', monthly_rank
  )
  INTO v_impact
  FROM user_impact_stats
  WHERE user_id = p_user_id;

  -- Default impact if not found
  IF v_impact IS NULL THEN
    v_impact := jsonb_build_object(
      'food_saved_kg', 0,
      'co2_saved_kg', 0,
      'meals_provided', 0,
      'monthly_rank', NULL
    );
  END IF;

  -- Get unread counts
  SELECT COUNT(*)::INT INTO v_unread_notifications
  FROM notifications
  WHERE profile_id = p_user_id AND read_at IS NULL;

  SELECT COUNT(*)::INT INTO v_unread_messages
  FROM rooms
  WHERE p_user_id = ANY(participant_ids)
    AND unread_count > 0
    AND deleted_at IS NULL;

  -- Pending requests (reservations/requests for user's items)
  SELECT COUNT(*)::INT INTO v_pending_requests
  FROM reservations r
  JOIN posts p ON p.id = r.post_id
  WHERE p.profile_id = p_user_id
    AND r.status = 'pending';

  -- Get recent listings if requested
  IF p_include_listings THEN
    SELECT jsonb_agg(listing_row)
    INTO v_recent_listings
    FROM (
      SELECT jsonb_build_object(
        'id', id,
        'post_name', post_name,
        'images', images,
        'is_active', is_active,
        'expires_at', expires_at,
        'view_count', COALESCE(view_count, 0),
        'created_at', created_at
      ) AS listing_row
      FROM posts
      WHERE profile_id = p_user_id
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT p_listings_limit
    ) listings;
  END IF;

  -- Get user badges (if table exists)
  SELECT jsonb_agg(badge_name)
  INTO v_badges
  FROM user_badges
  WHERE user_id = p_user_id
    AND (expires_at IS NULL OR expires_at > NOW());

  -- Build result
  v_result := jsonb_build_object(
    'profile', v_profile,
    'stats', v_stats,
    'impact', v_impact,
    'unread_notifications', v_unread_notifications,
    'unread_messages', v_unread_messages,
    'pending_requests', v_pending_requests,
    'recent_listings', COALESCE(v_recent_listings, '[]'::JSONB),
    'badges', COALESCE(v_badges, '[]'::JSONB),
    'last_active', NOW()
  );

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_bff_feed_data TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_dashboard TO authenticated;

-- =============================================================================
-- Function Comments
-- =============================================================================

COMMENT ON FUNCTION get_bff_feed_data IS 'BFF aggregation: Returns feed listings with owner profiles and unread counts in single call';
COMMENT ON FUNCTION get_user_dashboard IS 'BFF aggregation: Returns complete user dashboard data (profile, stats, impact, listings) in single call';

-- =============================================================================
-- Supporting Tables (if not exist)
-- =============================================================================

-- User impact stats table
CREATE TABLE IF NOT EXISTS user_impact_stats (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  food_saved_kg NUMERIC(10,2) DEFAULT 0,
  co2_saved_kg NUMERIC(10,2) DEFAULT 0,
  meals_provided INT DEFAULT 0,
  monthly_rank INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User badges table
CREATE TABLE IF NOT EXISTS user_badges (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_name TEXT NOT NULL,
  earned_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(user_id, badge_name)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- Enable RLS
ALTER TABLE user_impact_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY user_impact_stats_select ON user_impact_stats
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id
    WHERE ur.profile_id = auth.uid() AND r.name = 'admin'
  ));

CREATE POLICY user_badges_select ON user_badges
  FOR SELECT TO authenticated
  USING (TRUE); -- Badges are public

CREATE POLICY user_badges_insert ON user_badges
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id
    WHERE ur.profile_id = auth.uid() AND r.name = 'admin'
  ));
