-- ============================================================================
-- Aggregation Tables for Platform Analytics and User Behavior
-- Enables ML-ready features and platform-wide metrics
-- ============================================================================

-- Drop existing objects if they exist
DROP TABLE IF EXISTS public.daily_stats CASCADE;
DROP TABLE IF EXISTS public.user_activity_summary CASCADE;
DROP FUNCTION IF EXISTS public.update_daily_stats();
DROP FUNCTION IF EXISTS public.get_platform_stats(integer);

-- ============================================================================
-- daily_stats - Platform-wide daily metrics
-- ============================================================================

/**
 * daily_stats - Aggregated platform metrics per day
 *
 * Stores:
 * - User growth metrics
 * - Listing activity
 * - Engagement metrics
 * - Platform health indicators
 *
 * Populated via scheduled job or trigger
 */
CREATE TABLE public.daily_stats (
  date date PRIMARY KEY,

  -- User metrics
  new_users integer NOT NULL DEFAULT 0,
  active_users integer NOT NULL DEFAULT 0,
  returning_users integer NOT NULL DEFAULT 0,

  -- Listing metrics
  new_listings integer NOT NULL DEFAULT 0,
  completed_shares integer NOT NULL DEFAULT 0,
  expired_listings integer NOT NULL DEFAULT 0,

  -- Engagement metrics
  messages_sent integer NOT NULL DEFAULT 0,
  notifications_sent integer NOT NULL DEFAULT 0,
  searches_performed integer NOT NULL DEFAULT 0,

  -- Geographic spread
  active_cities jsonb DEFAULT '[]'::jsonb,
  top_categories jsonb DEFAULT '[]'::jsonb,

  -- Computed at
  computed_at timestamptz NOT NULL DEFAULT NOW()
);

-- Index for recent stats queries
CREATE INDEX idx_daily_stats_date ON public.daily_stats(date DESC);

COMMENT ON TABLE public.daily_stats IS 'Platform-wide daily aggregated metrics';

-- ============================================================================
-- user_activity_summary - Per-user behavior for recommendations
-- ============================================================================

/**
 * user_activity_summary - User behavior tracking for ML features
 *
 * Stores:
 * - Category preferences (view counts)
 * - Search history (recent terms)
 * - Location patterns
 * - Activity timing
 *
 * Updated in real-time via triggers or function calls
 */
CREATE TABLE public.user_activity_summary (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,

  -- Category preferences (category_id -> view_count)
  categories_viewed jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Search behavior
  search_terms text[] NOT NULL DEFAULT '{}',
  search_count integer NOT NULL DEFAULT 0,

  -- Location patterns (array of {lat, lng, count})
  locations_searched jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Activity timing (hour of day -> count)
  peak_activity_hours jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Interaction stats
  listings_viewed integer NOT NULL DEFAULT 0,
  listings_saved integer NOT NULL DEFAULT 0,
  messages_initiated integer NOT NULL DEFAULT 0,
  shares_completed integer NOT NULL DEFAULT 0,

  -- Timestamps
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Indexes for activity-based queries
CREATE INDEX idx_user_activity_last ON public.user_activity_summary(last_activity_at DESC);
CREATE INDEX idx_user_activity_updated ON public.user_activity_summary(updated_at);

COMMENT ON TABLE public.user_activity_summary IS 'Per-user activity tracking for personalization';

-- ============================================================================
-- track_user_activity - Records user activity events
-- ============================================================================

/**
 * track_user_activity - Records a user activity event
 *
 * Updates the user_activity_summary with new activity data.
 * Designed for fire-and-forget usage from Edge Functions.
 *
 * @param p_user_id - The user's ID
 * @param p_activity_type - Type of activity (view, search, save, message, share)
 * @param p_data - Activity-specific data (category_id, search_term, etc.)
 *
 * @returns void
 */
CREATE OR REPLACE FUNCTION public.track_user_activity(
  p_user_id uuid,
  p_activity_type text,
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_hour integer := EXTRACT(HOUR FROM NOW())::integer;
  v_category_id text;
  v_search_term text;
BEGIN
  -- Ensure user exists in activity summary
  INSERT INTO user_activity_summary (user_id, first_activity_at, last_activity_at)
  VALUES (p_user_id, NOW(), NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    last_activity_at = NOW(),
    updated_at = NOW();

  -- Process based on activity type
  CASE p_activity_type
    WHEN 'view' THEN
      -- Increment listings viewed
      UPDATE user_activity_summary SET
        listings_viewed = listings_viewed + 1
      WHERE user_id = p_user_id;

      -- Track category if provided
      v_category_id := p_data->>'category_id';
      IF v_category_id IS NOT NULL THEN
        UPDATE user_activity_summary SET
          categories_viewed = jsonb_set(
            categories_viewed,
            ARRAY[v_category_id],
            to_jsonb(COALESCE((categories_viewed->>v_category_id)::integer, 0) + 1)
          )
        WHERE user_id = p_user_id;
      END IF;

    WHEN 'search' THEN
      v_search_term := p_data->>'term';
      IF v_search_term IS NOT NULL AND v_search_term != '' THEN
        UPDATE user_activity_summary SET
          search_count = search_count + 1,
          -- Keep only last 20 search terms
          search_terms = (
            SELECT array_agg(term)
            FROM (
              SELECT unnest(ARRAY[v_search_term] || search_terms) AS term
              LIMIT 20
            ) sub
          )
        WHERE user_id = p_user_id;
      END IF;

      -- Track searched location if provided
      IF p_data ? 'lat' AND p_data ? 'lng' THEN
        UPDATE user_activity_summary SET
          locations_searched = (
            SELECT jsonb_agg(loc)
            FROM (
              SELECT jsonb_build_object(
                'lat', p_data->>'lat',
                'lng', p_data->>'lng',
                'count', 1
              ) AS loc
              UNION ALL
              SELECT value AS loc
              FROM jsonb_array_elements(locations_searched)
              LIMIT 10
            ) sub
          )
        WHERE user_id = p_user_id;
      END IF;

    WHEN 'save' THEN
      UPDATE user_activity_summary SET
        listings_saved = listings_saved + 1
      WHERE user_id = p_user_id;

    WHEN 'message' THEN
      UPDATE user_activity_summary SET
        messages_initiated = messages_initiated + 1
      WHERE user_id = p_user_id;

    WHEN 'share_complete' THEN
      UPDATE user_activity_summary SET
        shares_completed = shares_completed + 1
      WHERE user_id = p_user_id;

    ELSE
      -- Unknown activity type - just update timestamp
      NULL;
  END CASE;

  -- Update peak activity hours
  UPDATE user_activity_summary SET
    peak_activity_hours = jsonb_set(
      peak_activity_hours,
      ARRAY[v_current_hour::text],
      to_jsonb(COALESCE((peak_activity_hours->>v_current_hour::text)::integer, 0) + 1)
    )
  WHERE user_id = p_user_id;

END;
$$;

GRANT EXECUTE ON FUNCTION public.track_user_activity(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.track_user_activity(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.track_user_activity IS 'Records user activity for personalization';

-- ============================================================================
-- get_user_preferences - Returns user preferences for personalization
-- ============================================================================

/**
 * get_user_preferences - Returns user's activity-based preferences
 *
 * Useful for feed personalization and recommendations.
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with preference data
 */
CREATE OR REPLACE FUNCTION public.get_user_preferences(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activity record;
  v_top_categories jsonb;
  v_peak_hours integer[];
BEGIN
  SELECT * INTO v_activity
  FROM user_activity_summary
  WHERE user_id = p_user_id;

  IF v_activity IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'isNewUser', true,
      'preferences', jsonb_build_object()
    );
  END IF;

  -- Get top 5 categories by view count
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('categoryId', key, 'viewCount', value::integer)
    ORDER BY value::integer DESC
  ), '[]'::jsonb) INTO v_top_categories
  FROM (
    SELECT key, value
    FROM jsonb_each_text(v_activity.categories_viewed)
    ORDER BY value::integer DESC
    LIMIT 5
  ) sub;

  -- Get peak activity hours (top 3)
  SELECT ARRAY(
    SELECT key::integer
    FROM jsonb_each_text(v_activity.peak_activity_hours)
    ORDER BY value::integer DESC
    LIMIT 3
  ) INTO v_peak_hours;

  RETURN jsonb_build_object(
    'success', true,
    'isNewUser', false,
    'preferences', jsonb_build_object(
      'topCategories', v_top_categories,
      'recentSearches', v_activity.search_terms[1:5],
      'peakHours', v_peak_hours,
      'engagementLevel', CASE
        WHEN v_activity.listings_viewed > 100 THEN 'high'
        WHEN v_activity.listings_viewed > 20 THEN 'medium'
        ELSE 'low'
      END
    ),
    'stats', jsonb_build_object(
      'listingsViewed', v_activity.listings_viewed,
      'listingsSaved', v_activity.listings_saved,
      'messagesInitiated', v_activity.messages_initiated,
      'sharesCompleted', v_activity.shares_completed,
      'searchCount', v_activity.search_count
    ),
    'activity', jsonb_build_object(
      'firstActivityAt', v_activity.first_activity_at,
      'lastActivityAt', v_activity.last_activity_at,
      'daysSinceFirstActivity', EXTRACT(DAY FROM NOW() - v_activity.first_activity_at)::integer
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_preferences(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_preferences(uuid) TO service_role;

COMMENT ON FUNCTION public.get_user_preferences IS 'Returns user preferences for personalization';

-- ============================================================================
-- update_daily_stats - Computes daily stats for a given date
-- ============================================================================

/**
 * update_daily_stats - Computes/updates daily platform stats
 *
 * Should be run at end of day or periodically for live stats.
 *
 * @param p_date - The date to compute stats for (default: today)
 *
 * @returns void
 */
CREATE OR REPLACE FUNCTION public.update_daily_stats(p_date date DEFAULT CURRENT_DATE)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_users integer;
  v_active_users integer;
  v_new_listings integer;
  v_completed_shares integer;
  v_messages_sent integer;
  v_notifications_sent integer;
BEGIN
  -- Count new users (using created_time from profiles)
  SELECT COUNT(*) INTO v_new_users
  FROM profiles
  WHERE DATE(created_time) = p_date
    AND is_active = true;

  -- Count active users (any activity)
  SELECT COUNT(DISTINCT user_id) INTO v_active_users
  FROM user_activity_summary
  WHERE DATE(last_activity_at) = p_date;

  -- Count new listings
  SELECT COUNT(*) INTO v_new_listings
  FROM posts
  WHERE DATE(created_at) = p_date;

  -- Count completed shares (posts marked as inactive with is_arranged = true)
  SELECT COUNT(*) INTO v_completed_shares
  FROM posts
  WHERE DATE(updated_at) = p_date
    AND is_active = false
    AND is_arranged = true;

  -- Count notifications sent (using user_notifications table)
  SELECT COUNT(*) INTO v_notifications_sent
  FROM user_notifications
  WHERE DATE(created_at) = p_date;

  -- Upsert daily stats
  INSERT INTO daily_stats (
    date, new_users, active_users, new_listings,
    completed_shares, notifications_sent, computed_at
  ) VALUES (
    p_date, v_new_users, v_active_users, v_new_listings,
    v_completed_shares, v_notifications_sent, NOW()
  )
  ON CONFLICT (date) DO UPDATE SET
    new_users = EXCLUDED.new_users,
    active_users = EXCLUDED.active_users,
    new_listings = EXCLUDED.new_listings,
    completed_shares = EXCLUDED.completed_shares,
    notifications_sent = EXCLUDED.notifications_sent,
    computed_at = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_daily_stats(date) TO service_role;

COMMENT ON FUNCTION public.update_daily_stats IS 'Computes daily platform statistics';

-- ============================================================================
-- get_platform_stats - Returns platform statistics for dashboards
-- ============================================================================

/**
 * get_platform_stats - Returns platform statistics
 *
 * @param p_days - Number of days to include (default 30)
 *
 * @returns JSONB with platform statistics
 */
CREATE OR REPLACE FUNCTION public.get_platform_stats(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_daily_stats jsonb;
  v_totals record;
BEGIN
  -- Get daily stats
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'date', date,
      'newUsers', new_users,
      'activeUsers', active_users,
      'newListings', new_listings,
      'completedShares', completed_shares,
      'notificationsSent', notifications_sent
    ) ORDER BY date DESC
  ), '[]'::jsonb) INTO v_daily_stats
  FROM daily_stats
  WHERE date >= CURRENT_DATE - p_days;

  -- Get totals
  SELECT
    COALESCE(SUM(new_users), 0) AS total_new_users,
    COALESCE(AVG(active_users), 0)::integer AS avg_active_users,
    COALESCE(SUM(new_listings), 0) AS total_new_listings,
    COALESCE(SUM(completed_shares), 0) AS total_completed_shares
  INTO v_totals
  FROM daily_stats
  WHERE date >= CURRENT_DATE - p_days;

  -- Get current platform totals
  RETURN jsonb_build_object(
    'success', true,
    'period', jsonb_build_object(
      'days', p_days,
      'from', CURRENT_DATE - p_days,
      'to', CURRENT_DATE
    ),
    'totals', jsonb_build_object(
      'newUsers', v_totals.total_new_users,
      'avgActiveUsers', v_totals.avg_active_users,
      'newListings', v_totals.total_new_listings,
      'completedShares', v_totals.total_completed_shares
    ),
    'dailyStats', v_daily_stats,
    'currentTotals', (
      SELECT jsonb_build_object(
        'totalUsers', COUNT(*) FILTER (WHERE is_active = true),
        'totalListings', (SELECT COUNT(*) FROM posts),
        'activeListings', (SELECT COUNT(*) FROM posts WHERE is_active = true)
      )
      FROM profiles
    ),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_platform_stats(integer) TO service_role;

COMMENT ON FUNCTION public.get_platform_stats IS 'Returns platform statistics for admin dashboards';

-- ============================================================================
-- Initialize: Compute stats for last 7 days
-- ============================================================================

DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT generate_series(CURRENT_DATE - 7, CURRENT_DATE, '1 day'::interval)::date
  LOOP
    PERFORM update_daily_stats(d);
  END LOOP;
END;
$$;
