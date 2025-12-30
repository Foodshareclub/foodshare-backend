-- ============================================================================
-- User Matching & Compatibility Scoring RPC
-- Moves scoring logic from Edge Function to PostgreSQL for thick server
-- ============================================================================

-- Drop existing function if exists
DROP FUNCTION IF EXISTS public.calculate_user_matches(uuid, double precision, double precision, text[], integer, integer);

/**
 * calculate_user_matches - Server-side user compatibility scoring
 *
 * Finds nearby users with food items and calculates compatibility scores
 * based on dietary preferences, ratings, activity, and distance.
 *
 * Scoring breakdown (0-100 total):
 * - Dietary preferences overlap: 0-30 points
 * - Rating average: 0-30 points
 * - Activity (items shared): 0-20 points
 * - Distance (closer is better): 0-20 points
 *
 * @param p_user_id - The requesting user's ID
 * @param p_latitude - User's current latitude
 * @param p_longitude - User's current longitude
 * @param p_dietary_preferences - Array of dietary preferences to match
 * @param p_radius_km - Search radius in kilometers (default 10)
 * @param p_limit - Maximum number of matches to return (default 20)
 *
 * Usage:
 *   SELECT * FROM calculate_user_matches(
 *     'user-uuid',
 *     -36.8485, 174.7633,
 *     ARRAY['vegetarian', 'organic'],
 *     10, 20
 *   );
 */
CREATE OR REPLACE FUNCTION public.calculate_user_matches(
  p_user_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_dietary_preferences text[] DEFAULT '{}',
  p_radius_km integer DEFAULT 10,
  p_limit integer DEFAULT 20
)
RETURNS TABLE(
  user_id uuid,
  username text,
  avatar_url text,
  distance_km numeric,
  compatibility_score integer,
  distance_score integer,
  activity_score integer,
  rating_score integer,
  prefs_score integer,
  shared_items_count bigint,
  rating_average numeric,
  common_preferences text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_prefs_count integer;
BEGIN
  -- Get count of user's dietary preferences for scoring
  v_user_prefs_count := COALESCE(array_length(p_dietary_preferences, 1), 0);

  RETURN QUERY
  WITH nearby_items AS (
    -- Find food items within radius
    SELECT
      fi.profile_id AS item_user_id,
      fi.id AS item_id,
      -- Calculate distance using Haversine formula
      (
        6371 * acos(
          cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
          cos(radians(fi.longitude) - radians(p_longitude)) +
          sin(radians(p_latitude)) * sin(radians(fi.latitude))
        )
      ) AS item_distance_km
    FROM food_items fi
    WHERE fi.profile_id != p_user_id
      AND fi.is_active = true
      AND fi.deleted_at IS NULL
      -- Bounding box filter for performance (roughly p_radius_km degrees)
      AND fi.latitude BETWEEN p_latitude - (p_radius_km / 111.0) AND p_latitude + (p_radius_km / 111.0)
      AND fi.longitude BETWEEN p_longitude - (p_radius_km / (111.0 * cos(radians(p_latitude))))
                           AND p_longitude + (p_radius_km / (111.0 * cos(radians(p_latitude))))
    HAVING (
      6371 * acos(
        cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
        cos(radians(fi.longitude) - radians(p_longitude)) +
        sin(radians(p_latitude)) * sin(radians(fi.latitude))
      )
    ) <= p_radius_km
  ),
  user_items_agg AS (
    -- Aggregate items per user
    SELECT
      ni.item_user_id,
      COUNT(*) AS item_count,
      AVG(ni.item_distance_km) AS avg_distance
    FROM nearby_items ni
    GROUP BY ni.item_user_id
  ),
  user_scores AS (
    -- Calculate scores for each user
    SELECT
      p.id AS scored_user_id,
      p.username,
      p.avatar_url,
      ROUND(COALESCE(uia.avg_distance, 0)::numeric, 2) AS user_distance_km,
      COALESCE(uia.item_count, 0) AS items_count,
      COALESCE(p.rating_average, 0)::numeric AS user_rating_avg,
      COALESCE(p.items_shared, 0) AS user_items_shared,
      p.dietary_preferences AS user_dietary_prefs,

      -- Calculate preference overlap
      CASE
        WHEN v_user_prefs_count > 0 AND p.dietary_preferences IS NOT NULL THEN
          ARRAY(
            SELECT unnest(p_dietary_preferences)
            INTERSECT
            SELECT unnest(p.dietary_preferences)
          )
        ELSE ARRAY[]::text[]
      END AS common_prefs,

      -- Distance score: max(0, 20 - (distance * 2))
      GREATEST(0, 20 - (COALESCE(uia.avg_distance, 0) * 2))::integer AS dist_score,

      -- Activity score: min((items_shared / 10) * 20, 20)
      LEAST((COALESCE(p.items_shared, 0)::numeric / 10) * 20, 20)::integer AS act_score,

      -- Rating score: (rating / 5) * 30
      (COALESCE(p.rating_average, 0) / 5 * 30)::integer AS rate_score

    FROM profiles_foodshare p
    INNER JOIN user_items_agg uia ON uia.item_user_id = p.id
    WHERE p.id != p_user_id
      AND p.is_active = true
  )
  SELECT
    us.scored_user_id,
    us.username,
    us.avatar_url,
    us.user_distance_km,
    -- Total compatibility score
    (
      -- Prefs score: (common / total) * 30
      CASE
        WHEN v_user_prefs_count > 0 THEN
          (array_length(us.common_prefs, 1)::numeric / v_user_prefs_count * 30)::integer
        ELSE 0
      END
      + us.dist_score
      + us.act_score
      + us.rate_score
    )::integer AS total_compatibility_score,
    us.dist_score,
    us.act_score,
    us.rate_score,
    CASE
      WHEN v_user_prefs_count > 0 THEN
        (array_length(us.common_prefs, 1)::numeric / v_user_prefs_count * 30)::integer
      ELSE 0
    END AS pref_score,
    us.items_count,
    us.user_rating_avg,
    us.common_prefs
  FROM user_scores us
  ORDER BY (
    CASE
      WHEN v_user_prefs_count > 0 THEN
        (array_length(us.common_prefs, 1)::numeric / v_user_prefs_count * 30)::integer
      ELSE 0
    END
    + us.dist_score
    + us.act_score
    + us.rate_score
  ) DESC
  LIMIT p_limit;

END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.calculate_user_matches(uuid, double precision, double precision, text[], integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_user_matches(uuid, double precision, double precision, text[], integer, integer) TO service_role;

COMMENT ON FUNCTION public.calculate_user_matches IS 'Calculates user compatibility scores based on dietary preferences, ratings, activity, and distance';

-- ============================================================================
-- Helper function to get match count without full results
-- ============================================================================

DROP FUNCTION IF EXISTS public.count_nearby_matches(uuid, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.count_nearby_matches(
  p_user_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_radius_km integer DEFAULT 10
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT fi.profile_id)::integer
  FROM food_items fi
  WHERE fi.profile_id != p_user_id
    AND fi.is_active = true
    AND fi.deleted_at IS NULL
    AND fi.latitude BETWEEN p_latitude - (p_radius_km / 111.0) AND p_latitude + (p_radius_km / 111.0)
    AND fi.longitude BETWEEN p_longitude - (p_radius_km / (111.0 * cos(radians(p_latitude))))
                         AND p_longitude + (p_radius_km / (111.0 * cos(radians(p_latitude))))
    AND (
      6371 * acos(
        cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
        cos(radians(fi.longitude) - radians(p_longitude)) +
        sin(radians(p_latitude)) * sin(radians(fi.latitude))
      )
    ) <= p_radius_km;
$$;

GRANT EXECUTE ON FUNCTION public.count_nearby_matches(uuid, double precision, double precision, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_nearby_matches(uuid, double precision, double precision, integer) TO service_role;

COMMENT ON FUNCTION public.count_nearby_matches IS 'Quick count of nearby users with food items (for UI badges)';
