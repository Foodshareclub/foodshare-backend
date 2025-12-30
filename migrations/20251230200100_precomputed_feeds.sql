-- ============================================================================
-- Precomputed Feed Cells
-- Geographic cell-based caching for popular areas to eliminate real-time computation
-- ============================================================================

-- Drop existing objects if they exist
DROP TABLE IF EXISTS public.precomputed_feed_cells CASCADE;
DROP FUNCTION IF EXISTS public.get_or_compute_feed_cell(double precision, double precision, integer, integer);
DROP FUNCTION IF EXISTS public.compute_feed_for_cell(text, double precision, double precision, integer, integer);
DROP FUNCTION IF EXISTS public.cleanup_expired_feed_cells();
DROP FUNCTION IF EXISTS public.lat_lng_to_geohash(double precision, double precision, integer);

-- ============================================================================
-- Geohash utility function
-- ============================================================================

/**
 * lat_lng_to_geohash - Converts coordinates to geohash for cell identification
 *
 * Uses a simple grid-based approach for performance.
 * Precision 5 = ~5km x 5km cells, 6 = ~1km x 1km cells
 *
 * @param p_lat - Latitude
 * @param p_lng - Longitude
 * @param p_precision - Geohash precision (default 5 for ~5km cells)
 *
 * @returns Text geohash identifier
 */
CREATE OR REPLACE FUNCTION public.lat_lng_to_geohash(
  p_lat double precision,
  p_lng double precision,
  p_precision integer DEFAULT 5
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_lat_bin text := '';
  v_lng_bin text := '';
  v_combined text := '';
  v_hash text := '';
  v_base32 text := '0123456789bcdefghjkmnpqrstuvwxyz';
  v_lat_min double precision := -90;
  v_lat_max double precision := 90;
  v_lng_min double precision := -180;
  v_lng_max double precision := 180;
  v_lat_mid double precision;
  v_lng_mid double precision;
  v_bits integer;
  v_char_idx integer;
  i integer;
  j integer;
BEGIN
  -- Calculate required bits (5 bits per character)
  v_bits := p_precision * 5;

  -- Generate latitude and longitude bit strings
  FOR i IN 1..v_bits LOOP
    -- Longitude bit (even positions)
    v_lng_mid := (v_lng_min + v_lng_max) / 2;
    IF p_lng >= v_lng_mid THEN
      v_lng_bin := v_lng_bin || '1';
      v_lng_min := v_lng_mid;
    ELSE
      v_lng_bin := v_lng_bin || '0';
      v_lng_max := v_lng_mid;
    END IF;

    -- Latitude bit (odd positions)
    v_lat_mid := (v_lat_min + v_lat_max) / 2;
    IF p_lat >= v_lat_mid THEN
      v_lat_bin := v_lat_bin || '1';
      v_lat_min := v_lat_mid;
    ELSE
      v_lat_bin := v_lat_bin || '0';
      v_lat_max := v_lat_mid;
    END IF;
  END LOOP;

  -- Interleave longitude and latitude bits
  FOR i IN 1..v_bits LOOP
    v_combined := v_combined || substring(v_lng_bin, i, 1) || substring(v_lat_bin, i, 1);
  END LOOP;

  -- Convert to base32
  FOR i IN 0..(p_precision - 1) LOOP
    v_char_idx := 0;
    FOR j IN 1..5 LOOP
      v_char_idx := v_char_idx * 2;
      IF substring(v_combined, i * 5 + j, 1) = '1' THEN
        v_char_idx := v_char_idx + 1;
      END IF;
    END LOOP;
    v_hash := v_hash || substring(v_base32, v_char_idx + 1, 1);
  END LOOP;

  RETURN v_hash;
END;
$$;

COMMENT ON FUNCTION public.lat_lng_to_geohash IS 'Converts lat/lng to geohash for cell-based caching';

-- ============================================================================
-- Precomputed feed cells table
-- ============================================================================

CREATE TABLE public.precomputed_feed_cells (
  cell_id text PRIMARY KEY,
  center_lat double precision NOT NULL,
  center_lng double precision NOT NULL,
  radius_km integer NOT NULL DEFAULT 10,

  -- Cached feed data
  feed_data jsonb NOT NULL,
  item_count integer NOT NULL DEFAULT 0,

  -- Timing
  computed_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz NOT NULL DEFAULT NOW(),

  -- Metadata
  computation_time_ms integer,
  version integer NOT NULL DEFAULT 1
);

-- Indexes for efficient lookup and cleanup
CREATE INDEX idx_feed_cells_expires ON public.precomputed_feed_cells(expires_at);
CREATE INDEX idx_feed_cells_access ON public.precomputed_feed_cells(access_count DESC, last_accessed_at DESC);

-- ============================================================================
-- compute_feed_for_cell - Computes feed data for a geographic cell
-- Uses PostGIS location column from posts table
-- ============================================================================

/**
 * compute_feed_for_cell - Generates feed content for caching
 *
 * @param p_cell_id - The cell identifier
 * @param p_lat - Center latitude
 * @param p_lng - Center longitude
 * @param p_radius_km - Search radius in km
 * @param p_limit - Max items to cache
 *
 * @returns JSONB with feed items
 */
CREATE OR REPLACE FUNCTION public.compute_feed_for_cell(
  p_cell_id text,
  p_lat double precision,
  p_lng double precision,
  p_radius_km integer DEFAULT 10,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items jsonb;
  v_start_time timestamptz := clock_timestamp();
  v_computation_ms integer;
  v_search_point geography;
BEGIN
  -- Create search point for distance calculations
  v_search_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'score')::integer DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', po.id,
      'postName', po.post_name,
      'description', CASE
        WHEN length(po.post_description) > 100
        THEN substring(po.post_description, 1, 100) || '...'
        ELSE po.post_description
      END,
      'postType', po.post_type,
      'thumbnail', CASE
        WHEN po.images IS NOT NULL AND array_length(po.images, 1) > 0
        THEN po.images[1]
        ELSE NULL
      END,
      'images', po.images,
      'location', jsonb_build_object(
        'latitude', ST_Y(po.location::geometry),
        'longitude', ST_X(po.location::geometry),
        'address', po.post_address
      ),
      'categoryId', po.category_id,
      'createdAt', po.created_at,
      'distanceKm', ROUND((ST_Distance(po.location, v_search_point) / 1000)::numeric, 1),
      'profile', jsonb_build_object(
        'id', p.id,
        'nickname', p.nickname,
        'avatarUrl', p.avatar_url,
        'rating', COALESCE(ps.rating_average, 0)
      ),
      'freshnessDays', EXTRACT(DAY FROM NOW() - po.created_at)::integer,
      'score', (
        -- Distance score (0-40) - closer = higher score
        GREATEST(0, 40 - ((ST_Distance(po.location, v_search_point) / 1000) / p_radius_km * 40))
        -- Freshness score (0-30) - newer = higher score
        + GREATEST(0, 30 - (EXTRACT(DAY FROM NOW() - po.created_at) * 2))
        -- Rating score (0-30)
        + (COALESCE(ps.rating_average, 0) / 5 * 30)
      )::integer
    ) AS item
    FROM posts po
    LEFT JOIN profiles p ON p.id = po.profile_id
    LEFT JOIN profile_stats ps ON ps.profile_id = po.profile_id
    WHERE po.is_active = true
      AND po.post_type = 'food'
      AND po.location IS NOT NULL
      -- PostGIS distance filter (radius in meters)
      AND ST_DWithin(po.location, v_search_point, p_radius_km * 1000)
    ORDER BY (
      GREATEST(0, 40 - ((ST_Distance(po.location, v_search_point) / 1000) / p_radius_km * 40))
      + GREATEST(0, 30 - (EXTRACT(DAY FROM NOW() - po.created_at) * 2))
      + (COALESCE(ps.rating_average, 0) / 5 * 30)
    ) DESC
    LIMIT p_limit
  ) sub;

  -- Calculate computation time
  v_computation_ms := EXTRACT(MILLISECONDS FROM (clock_timestamp() - v_start_time))::integer;

  -- Upsert the cached result
  INSERT INTO precomputed_feed_cells (
    cell_id, center_lat, center_lng, radius_km,
    feed_data, item_count, computed_at, expires_at,
    computation_time_ms, access_count, last_accessed_at
  ) VALUES (
    p_cell_id, p_lat, p_lng, p_radius_km,
    v_items, jsonb_array_length(v_items), NOW(), NOW() + INTERVAL '5 minutes',
    v_computation_ms, 1, NOW()
  )
  ON CONFLICT (cell_id) DO UPDATE SET
    feed_data = EXCLUDED.feed_data,
    item_count = EXCLUDED.item_count,
    computed_at = EXCLUDED.computed_at,
    expires_at = EXCLUDED.expires_at,
    computation_time_ms = EXCLUDED.computation_time_ms,
    version = precomputed_feed_cells.version + 1;

  RETURN v_items;
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_feed_for_cell(text, double precision, double precision, integer, integer) TO service_role;

-- ============================================================================
-- get_or_compute_feed_cell - Returns cached feed or computes if expired
-- ============================================================================

/**
 * get_or_compute_feed_cell - Cache-first feed retrieval
 *
 * Returns cached feed data if available and fresh.
 * Automatically recomputes if expired or not found.
 *
 * @param p_lat - User's latitude
 * @param p_lng - User's longitude
 * @param p_radius_km - Search radius (default 10)
 * @param p_limit - Max items (default 50)
 *
 * @returns JSONB with feed data and cache metadata
 */
CREATE OR REPLACE FUNCTION public.get_or_compute_feed_cell(
  p_lat double precision,
  p_lng double precision,
  p_radius_km integer DEFAULT 10,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cell_id text;
  v_cached record;
  v_items jsonb;
  v_from_cache boolean := false;
BEGIN
  -- Compute cell ID based on location
  v_cell_id := lat_lng_to_geohash(p_lat, p_lng, 5) || '_' || p_radius_km::text;

  -- Check for cached data
  SELECT * INTO v_cached
  FROM precomputed_feed_cells
  WHERE cell_id = v_cell_id
    AND expires_at > NOW();

  IF v_cached IS NOT NULL THEN
    -- Update access stats
    UPDATE precomputed_feed_cells
    SET access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE cell_id = v_cell_id;

    v_items := v_cached.feed_data;
    v_from_cache := true;
  ELSE
    -- Compute fresh feed
    v_items := compute_feed_for_cell(v_cell_id, p_lat, p_lng, p_radius_km, p_limit);
    v_from_cache := false;

    -- Get updated cached record for metadata
    SELECT * INTO v_cached
    FROM precomputed_feed_cells
    WHERE cell_id = v_cell_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'items', v_items,
    'itemCount', jsonb_array_length(v_items),
    'cache', jsonb_build_object(
      'cellId', v_cell_id,
      'fromCache', v_from_cache,
      'computedAt', v_cached.computed_at,
      'expiresAt', v_cached.expires_at,
      'accessCount', v_cached.access_count,
      'computationTimeMs', v_cached.computation_time_ms
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'centerLat', p_lat,
      'centerLng', p_lng,
      'radiusKm', p_radius_km
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_compute_feed_cell(double precision, double precision, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_compute_feed_cell(double precision, double precision, integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_or_compute_feed_cell IS 'Cache-first feed retrieval with automatic recomputation';

-- ============================================================================
-- cleanup_expired_feed_cells - Removes stale cached cells
-- ============================================================================

/**
 * cleanup_expired_feed_cells - Cleans up expired and unused cached cells
 *
 * Should be run periodically (e.g., hourly) to prevent table bloat.
 *
 * @returns Integer count of deleted rows
 */
CREATE OR REPLACE FUNCTION public.cleanup_expired_feed_cells()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  -- Delete expired cells that haven't been accessed recently
  DELETE FROM precomputed_feed_cells
  WHERE expires_at < NOW() - INTERVAL '1 hour'
    OR (expires_at < NOW() AND access_count < 5);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_feed_cells() TO service_role;

COMMENT ON FUNCTION public.cleanup_expired_feed_cells IS 'Cleans up expired feed cache cells';

-- ============================================================================
-- get_feed_cache_stats - Returns cache statistics
-- ============================================================================

/**
 * get_feed_cache_stats - Returns statistics about the feed cache
 *
 * Useful for monitoring cache effectiveness.
 *
 * @returns JSONB with cache statistics
 */
CREATE OR REPLACE FUNCTION public.get_feed_cache_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stats record;
BEGIN
  SELECT
    COUNT(*) AS total_cells,
    COUNT(*) FILTER (WHERE expires_at > NOW()) AS active_cells,
    COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired_cells,
    SUM(access_count) AS total_accesses,
    AVG(access_count)::numeric(10,2) AS avg_accesses_per_cell,
    AVG(computation_time_ms)::numeric(10,2) AS avg_computation_ms,
    MAX(access_count) AS max_accesses,
    SUM(item_count) AS total_cached_items
  INTO v_stats
  FROM precomputed_feed_cells;

  RETURN jsonb_build_object(
    'totalCells', COALESCE(v_stats.total_cells, 0),
    'activeCells', COALESCE(v_stats.active_cells, 0),
    'expiredCells', COALESCE(v_stats.expired_cells, 0),
    'totalAccesses', COALESCE(v_stats.total_accesses, 0),
    'avgAccessesPerCell', COALESCE(v_stats.avg_accesses_per_cell, 0),
    'avgComputationMs', COALESCE(v_stats.avg_computation_ms, 0),
    'maxAccesses', COALESCE(v_stats.max_accesses, 0),
    'totalCachedItems', COALESCE(v_stats.total_cached_items, 0),
    'timestamp', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_feed_cache_stats() TO service_role;

COMMENT ON FUNCTION public.get_feed_cache_stats IS 'Returns feed cache statistics for monitoring';
