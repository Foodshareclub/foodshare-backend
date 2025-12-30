-- =============================================================================
-- BFF Profile RPC Function
-- =============================================================================
-- Aggregated RPC function for profile screens.
-- Returns profile with stats, listings, reviews, and impact in single call.
-- =============================================================================

-- =============================================================================
-- BFF Profile Data
-- =============================================================================
-- Returns aggregated data for profile screens:
-- - User profile details
-- - Stats (items shared/received, ratings)
-- - Impact metrics
-- - Recent listings
-- - Reviews received
-- - Badges
-- =============================================================================

CREATE OR REPLACE FUNCTION get_bff_profile_data(
  p_profile_id UUID,
  p_viewer_id UUID DEFAULT NULL,
  p_include_listings BOOLEAN DEFAULT TRUE,
  p_include_reviews BOOLEAN DEFAULT TRUE,
  p_listings_limit INT DEFAULT 10,
  p_reviews_limit INT DEFAULT 10
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
  v_listings JSONB;
  v_reviews JSONB;
  v_badges JSONB;
BEGIN
  -- Set statement timeout for safety
  SET LOCAL statement_timeout = '5s';

  -- Get user profile
  SELECT jsonb_build_object(
    'id', id,
    'display_name', display_name,
    'avatar_url', avatar_url,
    'bio', bio,
    'city', city,
    'is_verified', is_verified,
    'created_at', created_at
  )
  INTO v_profile
  FROM profiles
  WHERE id = p_profile_id;

  -- Return null if profile not found
  IF v_profile IS NULL THEN
    RETURN NULL;
  END IF;

  -- Get user stats
  SELECT jsonb_build_object(
    'items_shared', COALESCE(items_shared, 0),
    'items_received', COALESCE(items_received, 0),
    'active_listings', (
      SELECT COUNT(*) FROM posts
      WHERE profile_id = p_profile_id AND is_active = TRUE AND deleted_at IS NULL
    ),
    'rating_average', rating_average,
    'rating_count', COALESCE(rating_count, 0),
    'completed_transactions', COALESCE(completed_transactions, 0),
    'response_rate', (
      SELECT CASE
        WHEN total_messages > 0 THEN (responded_messages::FLOAT / total_messages * 100)::INT
        ELSE NULL
      END
      FROM user_response_stats WHERE user_id = p_profile_id
    ),
    'response_time_minutes', (
      SELECT avg_response_time_minutes FROM user_response_stats WHERE user_id = p_profile_id
    )
  )
  INTO v_stats
  FROM profiles
  WHERE id = p_profile_id;

  -- Get impact metrics
  SELECT jsonb_build_object(
    'food_saved_kg', COALESCE(food_saved_kg, 0),
    'co2_saved_kg', COALESCE(co2_saved_kg, 0),
    'meals_provided', COALESCE(meals_provided, 0),
    'monthly_rank', monthly_rank
  )
  INTO v_impact
  FROM user_impact_stats
  WHERE user_id = p_profile_id;

  -- Default impact if not found
  IF v_impact IS NULL THEN
    v_impact := jsonb_build_object(
      'food_saved_kg', 0,
      'co2_saved_kg', 0,
      'meals_provided', 0,
      'monthly_rank', NULL
    );
  END IF;

  -- Get recent listings if requested
  IF p_include_listings THEN
    SELECT jsonb_agg(listing_row)
    INTO v_listings
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
      WHERE profile_id = p_profile_id
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT p_listings_limit
    ) listings;
  END IF;

  -- Get reviews if requested
  IF p_include_reviews THEN
    SELECT jsonb_agg(review_row)
    INTO v_reviews
    FROM (
      SELECT jsonb_build_object(
        'id', r.id,
        'rating', r.rating,
        'comment', r.comment,
        'reviewer_id', r.reviewer_id,
        'reviewer_name', p.display_name,
        'reviewer_avatar', p.avatar_url,
        'transaction_type', r.transaction_type,
        'created_at', r.created_at
      ) AS review_row
      FROM reviews r
      JOIN profiles p ON p.id = r.reviewer_id
      WHERE r.reviewee_id = p_profile_id
      ORDER BY r.created_at DESC
      LIMIT p_reviews_limit
    ) reviews;
  END IF;

  -- Get badges
  SELECT jsonb_agg(badge_name)
  INTO v_badges
  FROM user_badges
  WHERE user_id = p_profile_id
    AND (expires_at IS NULL OR expires_at > NOW());

  -- Build result
  v_result := jsonb_build_object(
    'profile', v_profile,
    'stats', v_stats,
    'impact', v_impact,
    'listings', COALESCE(v_listings, '[]'::JSONB),
    'reviews', COALESCE(v_reviews, '[]'::JSONB),
    'badges', COALESCE(v_badges, '[]'::JSONB)
  );

  RETURN v_result;
END;
$$;

-- =============================================================================
-- Supporting Tables (if not exist)
-- =============================================================================

-- User response stats table (for response rate calculation)
CREATE TABLE IF NOT EXISTS user_response_stats (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  total_messages INT DEFAULT 0,
  responded_messages INT DEFAULT 0,
  avg_response_time_minutes INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reviews table (if not exists)
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  reviewer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  reviewee_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  rating INT CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  transaction_type TEXT CHECK (transaction_type IN ('shared', 'received')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reviewer_id, reviewee_id, post_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_reviewee
  ON reviews(reviewee_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reviews_reviewer
  ON reviews(reviewer_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_profile_created
  ON posts(profile_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- =============================================================================
-- Grant Permissions
-- =============================================================================

GRANT EXECUTE ON FUNCTION get_bff_profile_data TO authenticated;

-- Enable RLS on new tables
ALTER TABLE user_response_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY user_response_stats_select ON user_response_stats
  FOR SELECT TO authenticated
  USING (TRUE); -- Stats are public

CREATE POLICY reviews_select ON reviews
  FOR SELECT TO authenticated
  USING (TRUE); -- Reviews are public

CREATE POLICY reviews_insert ON reviews
  FOR INSERT TO authenticated
  WITH CHECK (reviewer_id = auth.uid());

-- =============================================================================
-- Function Comments
-- =============================================================================

COMMENT ON FUNCTION get_bff_profile_data IS 'BFF aggregation: Returns complete user profile data (stats, listings, reviews, impact) in single call';
