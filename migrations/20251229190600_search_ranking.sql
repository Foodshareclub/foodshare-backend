-- ============================================================================
-- Search with Ranking RPC
-- Server-side food item search with PostgreSQL full-text search and ranking
-- ============================================================================

-- Drop existing functions if exist
DROP FUNCTION IF EXISTS public.search_food_items_ranked(text, double precision, double precision, integer, integer, text[], text);

-- ============================================================================
-- search_food_items_ranked - Full-text search with relevance scoring
-- ============================================================================

/**
 * search_food_items_ranked - Server-side food item search with ranking
 *
 * Uses PostgreSQL full-text search with ts_rank for relevance scoring.
 * Combines text relevance with distance scoring for location-aware results.
 *
 * Scoring breakdown:
 * - Text relevance (ts_rank): 0-60 points
 * - Distance bonus (closer is better): 0-30 points
 * - Freshness bonus (newer is better): 0-10 points
 *
 * @param p_search_query - Search query string
 * @param p_latitude - User's latitude for distance scoring (optional)
 * @param p_longitude - User's longitude for distance scoring (optional)
 * @param p_radius_km - Maximum search radius in km (default 50)
 * @param p_limit - Maximum results to return (default 20)
 * @param p_categories - Filter by category slugs (optional)
 * @param p_post_type - Filter by post type (optional)
 *
 * @returns TABLE with ranked search results
 *
 * Usage:
 *   SELECT * FROM search_food_items_ranked(
 *     'fresh apples organic',
 *     -36.8485, 174.7633,
 *     50, 20,
 *     ARRAY['fruits', 'vegetables'],
 *     'food'
 *   );
 */
CREATE OR REPLACE FUNCTION public.search_food_items_ranked(
  p_search_query text,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_radius_km integer DEFAULT 50,
  p_limit integer DEFAULT 20,
  p_categories text[] DEFAULT NULL,
  p_post_type text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  post_name text,
  description text,
  post_type text,
  images text[],
  latitude double precision,
  longitude double precision,
  pickup_address text,
  pickup_time text,
  category_id integer,
  profile_id uuid,
  profile_username text,
  profile_avatar_url text,
  created_at timestamptz,
  distance_km numeric,
  relevance_score integer,
  text_rank numeric,
  distance_score integer,
  freshness_score integer,
  snippet text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ts_query tsquery;
  v_has_location boolean;
BEGIN
  -- Handle empty search query
  IF p_search_query IS NULL OR trim(p_search_query) = '' THEN
    RETURN;
  END IF;

  -- Parse search query into tsquery
  -- Use plainto_tsquery for simple phrase search, websearch_to_tsquery for advanced
  BEGIN
    v_ts_query := websearch_to_tsquery('english', p_search_query);
  EXCEPTION WHEN OTHERS THEN
    -- Fallback to plain text query if websearch syntax fails
    v_ts_query := plainto_tsquery('english', p_search_query);
  END;

  v_has_location := p_latitude IS NOT NULL AND p_longitude IS NOT NULL;

  RETURN QUERY
  WITH search_results AS (
    SELECT
      fi.id,
      fi.post_name,
      fi.description,
      fi.post_type,
      fi.images,
      fi.latitude,
      fi.longitude,
      fi.pickup_address,
      fi.pickup_time,
      fi.category_id,
      fi.profile_id,
      fi.created_at,

      -- Text relevance score using ts_rank
      ts_rank(
        setweight(to_tsvector('english', COALESCE(fi.post_name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(fi.description, '')), 'B'),
        v_ts_query
      ) AS text_rank_raw,

      -- Distance calculation (only if location provided)
      CASE
        WHEN v_has_location AND fi.latitude IS NOT NULL AND fi.longitude IS NOT NULL THEN
          (
            6371 * acos(
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            )
          )
        ELSE NULL
      END AS distance_km_raw,

      -- Freshness: days since creation (for scoring)
      EXTRACT(DAY FROM NOW() - fi.created_at) AS days_old

    FROM food_items fi
    WHERE fi.is_active = true
      AND fi.deleted_at IS NULL
      -- Full-text search match
      AND (
        to_tsvector('english', COALESCE(fi.post_name, '')) ||
        to_tsvector('english', COALESCE(fi.description, ''))
      ) @@ v_ts_query
      -- Category filter (if provided)
      AND (
        p_categories IS NULL
        OR fi.category_id IN (
          SELECT c.id FROM categories c WHERE c.slug = ANY(p_categories)
        )
      )
      -- Post type filter (if provided)
      AND (p_post_type IS NULL OR fi.post_type = p_post_type)
      -- Distance filter (if location provided)
      AND (
        NOT v_has_location
        OR fi.latitude IS NULL
        OR fi.longitude IS NULL
        OR (
          6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )
        ) <= p_radius_km
      )
  ),
  scored_results AS (
    SELECT
      sr.*,
      -- Text score: normalize to 0-60 range
      LEAST((sr.text_rank_raw * 100)::integer, 60) AS text_score,
      -- Distance score: 30 points for 0km, 0 points for >= radius
      CASE
        WHEN sr.distance_km_raw IS NULL THEN 0
        ELSE GREATEST(0, 30 - (sr.distance_km_raw / p_radius_km * 30))::integer
      END AS dist_score,
      -- Freshness score: 10 points for today, 0 points for >= 30 days old
      GREATEST(0, 10 - (sr.days_old / 3))::integer AS fresh_score
    FROM search_results sr
  )
  SELECT
    sr.id,
    sr.post_name,
    sr.description,
    sr.post_type,
    sr.images,
    sr.latitude,
    sr.longitude,
    sr.pickup_address,
    sr.pickup_time,
    sr.category_id,
    sr.profile_id,
    p.username AS profile_username,
    p.avatar_url AS profile_avatar_url,
    sr.created_at,
    ROUND(sr.distance_km_raw::numeric, 2) AS distance_km,
    (sr.text_score + sr.dist_score + sr.fresh_score)::integer AS relevance_score,
    ROUND(sr.text_rank_raw::numeric, 4) AS text_rank,
    sr.dist_score,
    sr.fresh_score,
    -- Generate search snippet with highlighting
    ts_headline(
      'english',
      COALESCE(sr.description, sr.post_name),
      v_ts_query,
      'MaxWords=30, MinWords=15, StartSel=<<, StopSel=>>'
    ) AS snippet
  FROM scored_results sr
  LEFT JOIN profiles_foodshare p ON p.id = sr.profile_id
  ORDER BY (sr.text_score + sr.dist_score + sr.fresh_score) DESC, sr.created_at DESC
  LIMIT p_limit;

END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.search_food_items_ranked(text, double precision, double precision, integer, integer, text[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_food_items_ranked(text, double precision, double precision, integer, integer, text[], text) TO service_role;

COMMENT ON FUNCTION public.search_food_items_ranked IS 'Full-text search for food items with relevance, distance, and freshness scoring';

-- ============================================================================
-- search_suggestions - Autocomplete suggestions based on popular searches
-- ============================================================================

DROP FUNCTION IF EXISTS public.search_suggestions(text, integer);

CREATE OR REPLACE FUNCTION public.search_suggestions(
  p_prefix text,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(
  suggestion text,
  count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Get suggestions from existing food item names
  SELECT
    fi.post_name AS suggestion,
    COUNT(*) AS count
  FROM food_items fi
  WHERE fi.is_active = true
    AND fi.deleted_at IS NULL
    AND fi.post_name ILIKE p_prefix || '%'
  GROUP BY fi.post_name
  ORDER BY count DESC, fi.post_name
  LIMIT p_limit;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.search_suggestions(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggestions(text, integer) TO service_role;

COMMENT ON FUNCTION public.search_suggestions IS 'Autocomplete suggestions based on existing food item names';

-- ============================================================================
-- Index for full-text search performance
-- ============================================================================

-- Create GIN index for full-text search if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'food_items' AND indexname = 'idx_food_items_fts'
  ) THEN
    CREATE INDEX idx_food_items_fts ON food_items USING GIN (
      (
        setweight(to_tsvector('english', COALESCE(post_name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(description, '')), 'B')
      )
    );
  END IF;
END
$$;

-- Partial index for active items only
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'food_items' AND indexname = 'idx_food_items_active_fts'
  ) THEN
    CREATE INDEX idx_food_items_active_fts ON food_items USING GIN (
      (
        setweight(to_tsvector('english', COALESCE(post_name, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(description, '')), 'B')
      )
    )
    WHERE is_active = true AND deleted_at IS NULL;
  END IF;
END
$$;
