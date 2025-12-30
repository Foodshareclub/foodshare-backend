-- ============================================================================
-- Personalization & ML Infrastructure
-- User behavior tracking, personalized ranking, and trending algorithms
-- ============================================================================

-- Drop existing objects if they exist
DROP TABLE IF EXISTS public.user_events CASCADE;
DROP FUNCTION IF EXISTS public.track_user_event(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.get_personalized_feed(uuid, double precision, double precision, integer, integer);
DROP FUNCTION IF EXISTS public.get_trending_items(double precision, double precision, integer, integer);

-- ============================================================================
-- user_events - Event tracking for ML features (partitioned)
-- ============================================================================

CREATE TABLE public.user_events (
  id uuid DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for current and next months
CREATE TABLE public.user_events_2025_12 PARTITION OF public.user_events
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE public.user_events_2026_01 PARTITION OF public.user_events
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE public.user_events_2026_02 PARTITION OF public.user_events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- Indexes for efficient querying
CREATE INDEX idx_user_events_user_type ON public.user_events(user_id, event_type, created_at DESC);
CREATE INDEX idx_user_events_type ON public.user_events(event_type, created_at DESC);

COMMENT ON TABLE public.user_events IS 'User event tracking for ML and personalization (partitioned by month)';

-- ============================================================================
-- track_user_event - Records user events
-- ============================================================================

/**
 * track_user_event - Records a user event for analytics and personalization
 *
 * Event types:
 * - listing_view: User viewed a listing
 * - listing_save: User saved a listing
 * - search: User performed a search
 * - share_complete: User completed a share
 * - message_sent: User sent a message
 * - feed_view: User viewed feed
 * - profile_view: User viewed a profile
 *
 * @param p_user_id - The user's ID
 * @param p_event_type - Type of event
 * @param p_data - Event-specific data
 *
 * @returns JSONB with event ID
 */
CREATE OR REPLACE FUNCTION public.track_user_event(
  p_user_id uuid,
  p_event_type text,
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
  v_category_id text;
BEGIN
  -- Insert event
  INSERT INTO user_events (user_id, event_type, event_data)
  VALUES (p_user_id, p_event_type, p_data)
  RETURNING id INTO v_event_id;

  -- Update user_activity_summary (created in aggregation_tables migration)
  -- This is a fire-and-forget update, errors are ignored
  BEGIN
    -- Ensure user exists in activity summary
    INSERT INTO user_activity_summary (user_id, first_activity_at, last_activity_at)
    VALUES (p_user_id, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      last_activity_at = NOW(),
      updated_at = NOW();

    -- Update specific metrics based on event type
    CASE p_event_type
      WHEN 'listing_view' THEN
        UPDATE user_activity_summary SET
          listings_viewed = listings_viewed + 1
        WHERE user_id = p_user_id;

        -- Track category preference
        v_category_id := p_data->>'category_id';
        IF v_category_id IS NOT NULL THEN
          UPDATE user_activity_summary SET
            categories_viewed = jsonb_set(
              COALESCE(categories_viewed, '{}'::jsonb),
              ARRAY[v_category_id],
              to_jsonb(COALESCE((categories_viewed->>v_category_id)::integer, 0) + 1)
            )
          WHERE user_id = p_user_id;
        END IF;

      WHEN 'listing_save' THEN
        UPDATE user_activity_summary SET
          listings_saved = listings_saved + 1
        WHERE user_id = p_user_id;

      WHEN 'search' THEN
        UPDATE user_activity_summary SET
          search_count = search_count + 1,
          search_terms = (
            SELECT array_agg(term)
            FROM (
              SELECT unnest(ARRAY[p_data->>'term'] || COALESCE(search_terms, '{}')) AS term
              LIMIT 20
            ) sub
            WHERE term IS NOT NULL AND term != ''
          )
        WHERE user_id = p_user_id;

      WHEN 'message_sent' THEN
        UPDATE user_activity_summary SET
          messages_initiated = messages_initiated + 1
        WHERE user_id = p_user_id;

      WHEN 'share_complete' THEN
        UPDATE user_activity_summary SET
          shares_completed = shares_completed + 1
        WHERE user_id = p_user_id;

      ELSE
        NULL; -- Unknown event type, just log it
    END CASE;

    -- Update peak activity hours
    UPDATE user_activity_summary SET
      peak_activity_hours = jsonb_set(
        COALESCE(peak_activity_hours, '{}'::jsonb),
        ARRAY[EXTRACT(HOUR FROM NOW())::text],
        to_jsonb(COALESCE((peak_activity_hours->>EXTRACT(HOUR FROM NOW())::text)::integer, 0) + 1)
      )
    WHERE user_id = p_user_id;

  EXCEPTION WHEN OTHERS THEN
    -- Ignore errors in activity summary update
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'eventId', v_event_id,
    'eventType', p_event_type
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.track_user_event(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.track_user_event(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.track_user_event IS 'Records user events for analytics and personalization';

-- ============================================================================
-- get_personalized_feed - ML-ready personalized feed
-- ============================================================================

/**
 * get_personalized_feed - Returns personalized feed with ML-ready scoring
 *
 * Scoring factors:
 * - Distance (0-30 pts): Closer is better
 * - Freshness (0-25 pts): Newer is better
 * - Category preference (0-25 pts): Based on user view history
 * - Engagement (0-20 pts): Based on views and likes
 *
 * @param p_user_id - The user's ID
 * @param p_latitude - User's latitude
 * @param p_longitude - User's longitude
 * @param p_offset - Pagination offset
 * @param p_limit - Page size
 *
 * @returns JSONB with personalized feed
 */
CREATE OR REPLACE FUNCTION public.get_personalized_feed(
  p_user_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category_weights jsonb;
  v_items jsonb;
  v_total_count integer;
  v_radius_km integer := 25;
BEGIN
  -- Get user's category preferences
  SELECT COALESCE(categories_viewed, '{}'::jsonb)
  INTO v_category_weights
  FROM user_activity_summary
  WHERE user_id = p_user_id;

  v_category_weights := COALESCE(v_category_weights, '{}'::jsonb);

  -- Count total items
  SELECT COUNT(*) INTO v_total_count
  FROM posts fi
  WHERE fi.is_active = true
    AND fi.deleted_at IS NULL
    AND fi.profile_id != p_user_id
    AND fi.post_type = 'food'
    AND fi.latitude IS NOT NULL
    AND fi.longitude IS NOT NULL
    -- Bounding box filter
    AND fi.latitude BETWEEN (p_latitude - (v_radius_km / 111.0)) AND (p_latitude + (v_radius_km / 111.0))
    AND fi.longitude BETWEEN (p_longitude - (v_radius_km / (111.0 * cos(radians(p_latitude)))))
                         AND (p_longitude + (v_radius_km / (111.0 * cos(radians(p_latitude)))));

  -- Get scored items
  SELECT COALESCE(jsonb_agg(item ORDER BY (item->>'totalScore')::integer DESC), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT jsonb_build_object(
      'id', fi.id,
      'postName', fi.post_name,
      'description', CASE
        WHEN length(fi.description) > 100
        THEN substring(fi.description, 1, 100) || '...'
        ELSE fi.description
      END,
      'thumbnail', fi.images[1],
      'images', fi.images,
      'postType', fi.post_type,
      'categoryId', fi.category_id,
      'location', jsonb_build_object(
        'lat', fi.latitude,
        'lng', fi.longitude,
        'address', fi.pickup_address
      ),
      'distance', jsonb_build_object(
        'km', ROUND((
          6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            ))
          )
        )::numeric, 1),
        'display', ROUND((
          6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            ))
          )
        )::numeric, 1)::text || ' km'
      ),
      'profile', jsonb_build_object(
        'id', p.id,
        'username', p.username,
        'avatar', p.avatar_url,
        'rating', ROUND(COALESCE(p.rating_average, 0)::numeric, 1)
      ),
      'createdAt', fi.created_at,
      'badges', CASE
        WHEN fi.created_at > NOW() - INTERVAL '6 hours' THEN
          jsonb_build_array(jsonb_build_object('text', 'New', 'color', 'green'))
        WHEN (
          6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            ))
          )
        ) < 1 THEN
          jsonb_build_array(jsonb_build_object('text', 'Nearby', 'color', 'blue'))
        ELSE '[]'::jsonb
      END,
      -- Score breakdown for transparency
      'scoreBreakdown', jsonb_build_object(
        'distance', GREATEST(0, 30 - (
          (6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            ))
          )) / v_radius_km * 30
        ))::integer,
        'freshness', GREATEST(0, 25 - (EXTRACT(DAY FROM NOW() - fi.created_at) * 2))::integer,
        'category', LEAST(25, COALESCE((v_category_weights->>fi.category_id::text)::integer, 0) * 5),
        'engagement', LEAST(20, (COALESCE(fi.post_views, 0) + COALESCE(fi.post_like_counter, 0) * 3) / 10)::integer
      ),
      'totalScore', (
        GREATEST(0, 30 - ((6371 * acos(LEAST(1.0, GREATEST(-1.0,
          cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
          cos(radians(fi.longitude) - radians(p_longitude)) +
          sin(radians(p_latitude)) * sin(radians(fi.latitude))
        )))) / v_radius_km * 30))
        + GREATEST(0, 25 - (EXTRACT(DAY FROM NOW() - fi.created_at) * 2))
        + LEAST(25, COALESCE((v_category_weights->>fi.category_id::text)::integer, 0) * 5)
        + LEAST(20, (COALESCE(fi.post_views, 0) + COALESCE(fi.post_like_counter, 0) * 3) / 10)
      )::integer
    ) AS item
    FROM posts fi
    JOIN profiles p ON p.id = fi.profile_id
    WHERE fi.is_active = true
      AND fi.deleted_at IS NULL
      AND fi.profile_id != p_user_id
      AND fi.post_type = 'food'
      AND fi.latitude IS NOT NULL
      AND fi.longitude IS NOT NULL
      -- Bounding box filter
      AND fi.latitude BETWEEN (p_latitude - (v_radius_km / 111.0)) AND (p_latitude + (v_radius_km / 111.0))
      AND fi.longitude BETWEEN (p_longitude - (v_radius_km / (111.0 * cos(radians(p_latitude)))))
                           AND (p_longitude + (v_radius_km / (111.0 * cos(radians(p_latitude)))))
    ORDER BY (
      GREATEST(0, 30 - ((6371 * acos(LEAST(1.0, GREATEST(-1.0,
        cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
        cos(radians(fi.longitude) - radians(p_longitude)) +
        sin(radians(p_latitude)) * sin(radians(fi.latitude))
      )))) / v_radius_km * 30))
      + GREATEST(0, 25 - (EXTRACT(DAY FROM NOW() - fi.created_at) * 2))
      + LEAST(25, COALESCE((v_category_weights->>fi.category_id::text)::integer, 0) * 5)
      + LEAST(20, (COALESCE(fi.post_views, 0) + COALESCE(fi.post_like_counter, 0) * 3) / 10)
    ) DESC
    OFFSET p_offset
    LIMIT p_limit
  ) sub;

  -- Track feed view event
  PERFORM track_user_event(p_user_id, 'feed_view', jsonb_build_object(
    'itemCount', jsonb_array_length(v_items),
    'lat', p_latitude,
    'lng', p_longitude
  ));

  RETURN jsonb_build_object(
    'success', true,
    'items', v_items,
    'pagination', jsonb_build_object(
      'offset', p_offset,
      'limit', p_limit,
      'total', v_total_count,
      'hasMore', (p_offset + p_limit) < v_total_count
    ),
    'meta', jsonb_build_object(
      'algorithm', 'personalized_v1',
      'timestamp', NOW(),
      'cacheTTL', 60,
      'hasPreferences', jsonb_typeof(v_category_weights) = 'object' AND v_category_weights != '{}'::jsonb
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_personalized_feed(uuid, double precision, double precision, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_personalized_feed(uuid, double precision, double precision, integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_personalized_feed IS 'Returns personalized feed with ML-ready scoring';

-- ============================================================================
-- get_trending_items - Trending items algorithm
-- ============================================================================

/**
 * get_trending_items - Returns trending items with decay factor
 *
 * Trending score = engagement / age^decay
 * Higher engagement + newer = higher trending score
 *
 * @param p_latitude - Center latitude (optional, for local trending)
 * @param p_longitude - Center longitude (optional)
 * @param p_hours - Time window in hours (default 24)
 * @param p_limit - Max items to return
 *
 * @returns JSONB with trending items
 */
CREATE OR REPLACE FUNCTION public.get_trending_items(
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_hours integer DEFAULT 24,
  p_limit integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items jsonb;
  v_radius_km integer := 50;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'postName', t.post_name,
      'thumbnail', t.images[1],
      'description', CASE
        WHEN length(t.description) > 80
        THEN substring(t.description, 1, 80) || '...'
        ELSE t.description
      END,
      'profile', jsonb_build_object(
        'username', t.username,
        'avatar', t.avatar_url
      ),
      'stats', jsonb_build_object(
        'views', t.post_views,
        'likes', t.post_like_counter,
        'hoursAgo', EXTRACT(HOUR FROM NOW() - t.created_at)::integer
      ),
      'trendingScore', ROUND(t.trending_score::numeric, 2),
      'badge', jsonb_build_object('text', 'Trending', 'color', 'orange')
    ) ORDER BY t.trending_score DESC
  ), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      fi.id,
      fi.post_name,
      fi.description,
      fi.images,
      fi.post_views,
      fi.post_like_counter,
      fi.created_at,
      p.username,
      p.avatar_url,
      -- Trending score = engagement / age^decay
      (
        (COALESCE(fi.post_views, 0) + COALESCE(fi.post_like_counter, 0) * 5)::float
        / POWER(GREATEST(1, EXTRACT(HOUR FROM NOW() - fi.created_at)), 1.5)
      ) AS trending_score
    FROM posts fi
    JOIN profiles p ON p.id = fi.profile_id
    WHERE fi.is_active = true
      AND fi.deleted_at IS NULL
      AND fi.post_type = 'food'
      AND fi.created_at > NOW() - (p_hours || ' hours')::interval
      -- Location filter if provided
      AND (
        p_latitude IS NULL
        OR p_longitude IS NULL
        OR (
          fi.latitude IS NOT NULL
          AND fi.longitude IS NOT NULL
          AND (6371 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
              cos(radians(fi.longitude) - radians(p_longitude)) +
              sin(radians(p_latitude)) * sin(radians(fi.latitude))
            ))
          )) <= v_radius_km
        )
      )
    ORDER BY (
      (COALESCE(fi.post_views, 0) + COALESCE(fi.post_like_counter, 0) * 5)::float
      / POWER(GREATEST(1, EXTRACT(HOUR FROM NOW() - fi.created_at)), 1.5)
    ) DESC
    LIMIT p_limit
  ) t;

  RETURN jsonb_build_object(
    'success', true,
    'items', v_items,
    'meta', jsonb_build_object(
      'algorithm', 'trending_v1',
      'timeWindow', p_hours || ' hours',
      'location', CASE
        WHEN p_latitude IS NOT NULL THEN 'local'
        ELSE 'global'
      END,
      'timestamp', NOW(),
      'cacheTTL', 300
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trending_items(double precision, double precision, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trending_items(double precision, double precision, integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_trending_items IS 'Returns trending items with decay-based scoring';

-- ============================================================================
-- cleanup_old_events - Removes old event data
-- ============================================================================

/**
 * cleanup_old_events - Removes events older than specified days
 *
 * @param p_days - Delete events older than this (default 90)
 *
 * @returns integer - Count of deleted events
 */
CREATE OR REPLACE FUNCTION public.cleanup_old_events(p_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM user_events
  WHERE created_at < NOW() - (p_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_events(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_old_events IS 'Removes old user events for data retention';
