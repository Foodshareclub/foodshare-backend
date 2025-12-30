-- Spatial Clustering RPC Functions
-- Aggregates posts into clusters at different zoom levels for efficient map rendering

-- ============================================================================
-- RPC: Get clustered posts for map display
-- ============================================================================
-- Returns either individual posts or clusters depending on zoom level
-- Uses ST_ClusterDBSCAN for density-based clustering

CREATE OR REPLACE FUNCTION get_clustered_posts(
  min_lng DOUBLE PRECISION,
  min_lat DOUBLE PRECISION,
  max_lng DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  zoom_level INTEGER DEFAULT 10,
  filter_post_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  cluster_id INTEGER,
  is_cluster BOOLEAN,
  post_count INTEGER,
  center_lng DOUBLE PRECISION,
  center_lat DOUBLE PRECISION,
  -- Individual post data (when is_cluster = false)
  post_id INTEGER,
  post_name TEXT,
  post_type TEXT,
  images TEXT[],
  location_json JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Clustering distance based on zoom level
  -- Higher zoom = smaller clusters = smaller eps
  eps_distance DOUBLE PRECISION;
  min_points INTEGER;
BEGIN
  -- Calculate clustering parameters based on zoom level
  -- At zoom 5: ~100km clusters, At zoom 15: ~100m clusters
  eps_distance := 0.1 / POWER(2, zoom_level - 5);
  min_points := CASE
    WHEN zoom_level <= 8 THEN 3   -- Low zoom: need 3+ for cluster
    WHEN zoom_level <= 12 THEN 2  -- Medium zoom: need 2+ for cluster
    ELSE 1                         -- High zoom: show individuals
  END;

  -- For high zoom levels (14+), return individual posts without clustering
  IF zoom_level >= 14 THEN
    RETURN QUERY
    SELECT
      0 AS cluster_id,
      FALSE AS is_cluster,
      1 AS post_count,
      ST_X(p.location::geometry) AS center_lng,
      ST_Y(p.location::geometry) AS center_lat,
      p.id AS post_id,
      p.post_name,
      p.post_type,
      p.images,
      p.location_json
    FROM posts_with_location p
    WHERE p.is_active = true
      AND p.location IS NOT NULL
      AND p.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
      AND (filter_post_type IS NULL OR p.post_type = filter_post_type)
    ORDER BY p.created_at DESC
    LIMIT 500;
    RETURN;
  END IF;

  -- For lower zoom levels, use DBSCAN clustering
  RETURN QUERY
  WITH bounded_posts AS (
    SELECT
      p.id,
      p.post_name,
      p.post_type,
      p.images,
      p.location,
      p.location_json,
      ST_X(p.location::geometry) AS lng,
      ST_Y(p.location::geometry) AS lat
    FROM posts_with_location p
    WHERE p.is_active = true
      AND p.location IS NOT NULL
      AND p.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
      AND (filter_post_type IS NULL OR p.post_type = filter_post_type)
  ),
  clustered AS (
    SELECT
      bp.*,
      ST_ClusterDBSCAN(bp.location::geometry, eps_distance, min_points) OVER () AS cid
    FROM bounded_posts bp
  ),
  cluster_stats AS (
    SELECT
      c.cid,
      COUNT(*) AS cnt,
      AVG(c.lng) AS avg_lng,
      AVG(c.lat) AS avg_lat,
      MIN(c.id) AS representative_id
    FROM clustered c
    WHERE c.cid IS NOT NULL
    GROUP BY c.cid
    HAVING COUNT(*) >= min_points
  ),
  -- Points that didn't cluster (noise points)
  unclustered AS (
    SELECT c.*
    FROM clustered c
    WHERE c.cid IS NULL
       OR c.cid NOT IN (SELECT cs.cid FROM cluster_stats cs)
  )
  -- Return clusters
  SELECT
    cs.cid::INTEGER AS cluster_id,
    TRUE AS is_cluster,
    cs.cnt::INTEGER AS post_count,
    cs.avg_lng AS center_lng,
    cs.avg_lat AS center_lat,
    NULL::INTEGER AS post_id,
    NULL::TEXT AS post_name,
    NULL::TEXT AS post_type,
    NULL::TEXT[] AS images,
    NULL::JSONB AS location_json
  FROM cluster_stats cs

  UNION ALL

  -- Return unclustered individual posts
  SELECT
    0 AS cluster_id,
    FALSE AS is_cluster,
    1 AS post_count,
    uc.lng AS center_lng,
    uc.lat AS center_lat,
    uc.id AS post_id,
    uc.post_name,
    uc.post_type,
    uc.images,
    uc.location_json
  FROM unclustered uc

  ORDER BY is_cluster DESC, post_count DESC
  LIMIT 500;
END;
$$;

-- Grant execute to authenticated and anon users
GRANT EXECUTE ON FUNCTION get_clustered_posts TO authenticated, anon;

-- ============================================================================
-- RPC: Get cluster expansion (posts within a cluster)
-- ============================================================================
-- When user clicks a cluster, fetch the individual posts within it

CREATE OR REPLACE FUNCTION get_cluster_posts(
  center_lng DOUBLE PRECISION,
  center_lat DOUBLE PRECISION,
  radius_meters DOUBLE PRECISION DEFAULT 1000,
  filter_post_type TEXT DEFAULT NULL,
  result_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  id INTEGER,
  post_name TEXT,
  post_type TEXT,
  images TEXT[],
  location_json JSONB,
  distance_meters DOUBLE PRECISION
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
    ST_Distance(
      p.location::geography,
      ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography
    ) AS distance_meters
  FROM posts_with_location p
  WHERE p.is_active = true
    AND p.location IS NOT NULL
    AND ST_DWithin(
      p.location::geography,
      ST_SetSRID(ST_MakePoint(center_lng, center_lat), 4326)::geography,
      radius_meters
    )
    AND (filter_post_type IS NULL OR p.post_type = filter_post_type)
  ORDER BY distance_meters
  LIMIT result_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION get_cluster_posts TO authenticated, anon;

-- ============================================================================
-- Documentation
-- ============================================================================
COMMENT ON FUNCTION get_clustered_posts IS
'Returns posts clustered based on zoom level for efficient map rendering.
At high zoom (14+): Individual posts are returned.
At lower zoom: Posts are grouped using ST_ClusterDBSCAN.
Parameters:
  - min_lng, min_lat, max_lng, max_lat: Bounding box
  - zoom_level: Map zoom (1-20), affects clustering granularity
  - filter_post_type: Optional post type filter
Returns:
  - Clusters: is_cluster=true with post_count and center coordinates
  - Individual posts: is_cluster=false with full post data';

COMMENT ON FUNCTION get_cluster_posts IS
'Fetches individual posts within a specified radius of a center point.
Used when expanding a cluster on the map.
Parameters:
  - center_lng, center_lat: Center point coordinates
  - radius_meters: Search radius (default 1000m)
  - filter_post_type: Optional post type filter
  - result_limit: Max results (default 50)';
