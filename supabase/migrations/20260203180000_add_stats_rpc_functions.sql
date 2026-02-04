-- ============================================================================
-- RPC Functions for Email Template Statistics
-- These functions provide location-based statistics for email templates
-- ============================================================================

-- Count profiles within a given radius
CREATE OR REPLACE FUNCTION count_profiles_within_radius(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_meters INTEGER DEFAULT 10000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  count_result INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO count_result
  FROM profiles p
  WHERE p.location IS NOT NULL
    AND ST_DWithin(
      p.location::geography,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
      radius_meters
    );

  RETURN COALESCE(count_result, 0);
END;
$$;

-- Count posts within a given radius (last N days)
CREATE OR REPLACE FUNCTION count_posts_within_radius(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_meters INTEGER DEFAULT 10000,
  days_ago INTEGER DEFAULT 7
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  count_result INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO count_result
  FROM posts p
  WHERE p.location IS NOT NULL
    AND ST_DWithin(
      p.location::geography,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
      radius_meters
    )
    AND p.is_active = true
    AND p.deleted_at IS NULL
    AND p.created_at >= NOW() - (days_ago || ' days')::INTERVAL;

  RETURN COALESCE(count_result, 0);
END;
$$;

-- Count new profiles within a given radius (last N days)
CREATE OR REPLACE FUNCTION count_new_profiles_within_radius(
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  radius_meters INTEGER DEFAULT 10000,
  days_ago INTEGER DEFAULT 30
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  count_result INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO count_result
  FROM profiles p
  WHERE p.location IS NOT NULL
    AND ST_DWithin(
      p.location::geography,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
      radius_meters
    )
    AND p.created_at >= NOW() - (days_ago || ' days')::INTERVAL;

  RETURN COALESCE(count_result, 0);
END;
$$;

-- Grant execute permissions to authenticated users
GRANT EXECUTE ON FUNCTION count_profiles_within_radius TO authenticated;
GRANT EXECUTE ON FUNCTION count_profiles_within_radius TO service_role;
GRANT EXECUTE ON FUNCTION count_posts_within_radius TO authenticated;
GRANT EXECUTE ON FUNCTION count_posts_within_radius TO service_role;
GRANT EXECUTE ON FUNCTION count_new_profiles_within_radius TO authenticated;
GRANT EXECUTE ON FUNCTION count_new_profiles_within_radius TO service_role;

-- Add helpful comments
COMMENT ON FUNCTION count_profiles_within_radius IS 'Count profiles within a given radius (in meters) from a lat/lng point';
COMMENT ON FUNCTION count_posts_within_radius IS 'Count active posts within a given radius created in the last N days';
COMMENT ON FUNCTION count_new_profiles_within_radius IS 'Count new profiles within a given radius created in the last N days';
