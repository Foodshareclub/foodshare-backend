-- PostGIS Bounding Box RPC Functions
-- Efficient spatial queries for map viewport loading

-- ============================================================================
-- Ensure PostGIS extension is enabled
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================================
-- RPC: Get posts within geographic bounds
-- ============================================================================
-- Uses ST_MakeEnvelope for efficient bounding box queries with spatial index
-- Returns posts within the specified viewport bounds

DROP FUNCTION IF EXISTS get_posts_in_bounds(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION get_posts_in_bounds(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  filter_post_type TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 500
)
RETURNS TABLE (
  id INTEGER,
  post_name TEXT,
  post_type TEXT,
  images TEXT[],
  location_json JSONB,
  longitude DOUBLE PRECISION,
  latitude DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.post_name,
    p.post_type,
    p.images,
    p.location_json,
    ST_X(p.location::geometry) AS longitude,
    ST_Y(p.location::geometry) AS latitude
  FROM posts_with_location p
  WHERE p.is_active = true
    AND p.location IS NOT NULL
    -- Spatial index-friendly bounding box query
    AND p.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    -- Optional post type filter
    AND (filter_post_type IS NULL OR p.post_type = filter_post_type)
  ORDER BY p.created_at DESC
  LIMIT result_limit;
END;
$$;

-- Grant execute to authenticated and anon users
GRANT EXECUTE ON FUNCTION get_posts_in_bounds TO authenticated, anon;

-- ============================================================================
-- RPC: Get posts count in bounds (for showing totals)
-- ============================================================================

DROP FUNCTION IF EXISTS get_posts_count_in_bounds(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT);
CREATE OR REPLACE FUNCTION get_posts_count_in_bounds(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  filter_post_type TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_count INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO total_count
  FROM posts_with_location p
  WHERE p.is_active = true
    AND p.location IS NOT NULL
    AND p.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    AND (filter_post_type IS NULL OR p.post_type = filter_post_type);

  RETURN total_count;
END;
$$;

GRANT EXECUTE ON FUNCTION get_posts_count_in_bounds TO authenticated, anon;

-- ============================================================================
-- Spatial Index (if not exists)
-- ============================================================================
-- Ensure posts_with_location has a spatial index on the location column
-- This is critical for bounding box query performance

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'posts' AND indexname = 'idx_posts_location_gist'
  ) THEN
    -- Note: posts_with_location is a view, index must be on underlying table
    -- If posts table has geography column, create index
    BEGIN
      CREATE INDEX idx_posts_location_gist ON posts USING GIST (location);
      RAISE NOTICE 'Created spatial index idx_posts_location_gist on posts';
    EXCEPTION WHEN undefined_column THEN
      RAISE NOTICE 'Column location not found on posts table - spatial index not created';
    END;
  ELSE
    RAISE NOTICE 'Spatial index idx_posts_location_gist already exists';
  END IF;
END $$;

-- ============================================================================
-- Documentation
-- ============================================================================
COMMENT ON FUNCTION get_posts_in_bounds IS
'Efficiently fetches posts within a geographic bounding box using PostGIS.
Uses ST_MakeEnvelope for spatial index utilization.
Parameters:
  - min_lng: Western boundary (longitude)
  - min_lat: Southern boundary (latitude)
  - max_lng: Eastern boundary (longitude)
  - max_lat: Northern boundary (latitude)
  - filter_post_type: Optional post type filter
  - result_limit: Max results (default 500)
Example: SELECT * FROM get_posts_in_bounds(-0.2, 51.4, 0.1, 51.6, ''food'', 100);';

COMMENT ON FUNCTION get_posts_count_in_bounds IS
'Returns count of posts within a geographic bounding box.
Useful for showing "X items in this area" without loading all data.';
