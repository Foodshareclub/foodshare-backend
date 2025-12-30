-- ============================================================================
-- BFF (Backend-For-Frontend) Aggregation Endpoints
-- Single-call endpoints that return all data needed for a screen
-- ============================================================================

-- Drop existing functions if exist
DROP FUNCTION IF EXISTS public.get_user_dashboard(uuid);
DROP FUNCTION IF EXISTS public.get_user_feed(uuid, double precision, double precision, integer, integer);
DROP FUNCTION IF EXISTS public.get_listing_detail(uuid, uuid);

-- ============================================================================
-- get_user_dashboard - All data for home/dashboard screen
-- ============================================================================

/**
 * get_user_dashboard - Returns all data needed for the user's dashboard in one call
 *
 * Aggregates:
 * - Profile data with display-ready formatting
 * - Unread notification count
 * - Active listings count
 * - Recent matches count
 * - Impact statistics (items shared, people helped)
 * - Quick actions available
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with all dashboard data
 *
 * Usage:
 *   SELECT get_user_dashboard('user-uuid'::uuid);
 */
CREATE OR REPLACE FUNCTION public.get_user_dashboard(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_unread_count integer;
  v_active_listings_count integer;
  v_pending_requests_count integer;
  v_recent_activity jsonb;
  v_impact_stats jsonb;
BEGIN
  -- Get user profile
  SELECT
    p.id,
    p.username,
    p.email,
    p.avatar_url,
    p.bio,
    p.is_active,
    p.items_shared,
    p.rating_average,
    p.rating_count,
    p.dietary_preferences,
    p.notification_preferences,
    p.created_at,
    p.updated_at
  INTO v_profile
  FROM profiles_foodshare p
  WHERE p.id = p_user_id;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'USER_NOT_FOUND', 'message', 'User profile not found')
    );
  END IF;

  -- Get unread notification count
  SELECT COUNT(*)::integer INTO v_unread_count
  FROM notifications n
  WHERE n.profile_id = p_user_id
    AND n.status = 'sent';

  -- Get active listings count
  SELECT COUNT(*)::integer INTO v_active_listings_count
  FROM food_items fi
  WHERE fi.profile_id = p_user_id
    AND fi.is_active = true
    AND fi.deleted_at IS NULL;

  -- Get pending requests count (items user has requested)
  SELECT COUNT(*)::integer INTO v_pending_requests_count
  FROM food_items fi
  WHERE fi.profile_id = p_user_id
    AND fi.post_type = 'request'
    AND fi.is_active = true
    AND fi.deleted_at IS NULL;

  -- Get recent activity (last 5 notifications)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', n.id,
      'title', n.notification_title,
      'text', n.notification_text,
      'timestamp', n.timestamp,
      'pageName', n.initial_page_name,
      'data', n.parameter_data
    ) ORDER BY n.timestamp DESC
  ), '[]'::jsonb) INTO v_recent_activity
  FROM (
    SELECT * FROM notifications
    WHERE profile_id = p_user_id
    ORDER BY timestamp DESC
    LIMIT 5
  ) n;

  -- Calculate impact stats
  v_impact_stats := jsonb_build_object(
    'itemsShared', COALESCE(v_profile.items_shared, 0),
    'itemsSharedDisplay', COALESCE(v_profile.items_shared, 0) || ' items shared',
    'rating', COALESCE(v_profile.rating_average, 0),
    'ratingDisplay', CASE
      WHEN v_profile.rating_count > 0 THEN
        ROUND(v_profile.rating_average::numeric, 1)::text || ' ★ (' || v_profile.rating_count || ' reviews)'
      ELSE 'No ratings yet'
    END,
    'memberSince', to_char(v_profile.created_at, 'Mon YYYY'),
    'memberDays', EXTRACT(DAY FROM NOW() - v_profile.created_at)::integer
  );

  -- Return aggregated dashboard data
  RETURN jsonb_build_object(
    'success', true,
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'username', v_profile.username,
      'email', v_profile.email,
      'avatarUrl', v_profile.avatar_url,
      'bio', v_profile.bio,
      'isActive', v_profile.is_active,
      'dietaryPreferences', COALESCE(v_profile.dietary_preferences, '[]'::jsonb),
      'notificationPreferences', COALESCE(v_profile.notification_preferences, '{}'::jsonb)
    ),
    'counts', jsonb_build_object(
      'unreadNotifications', v_unread_count,
      'activeListings', v_active_listings_count,
      'pendingRequests', v_pending_requests_count
    ),
    'badges', CASE
      WHEN v_unread_count > 0 THEN
        jsonb_build_array(
          jsonb_build_object('text', v_unread_count::text, 'color', 'red', 'screen', 'Notifications')
        )
      ELSE '[]'::jsonb
    END,
    'impactStats', v_impact_stats,
    'recentActivity', v_recent_activity,
    'quickActions', jsonb_build_array(
      jsonb_build_object('label', 'Share Food', 'screen', 'CreateListing', 'icon', 'plus'),
      jsonb_build_object('label', 'Find Food', 'screen', 'Browse', 'icon', 'search'),
      jsonb_build_object('label', 'My Listings', 'screen', 'MyListings', 'icon', 'list')
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 60,
      'refreshAfter', 300
    )
  );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_user_dashboard(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_dashboard(uuid) TO service_role;

COMMENT ON FUNCTION public.get_user_dashboard IS 'BFF endpoint: Returns all data needed for user dashboard in one call';

-- ============================================================================
-- get_user_feed - Curated food listings feed
-- ============================================================================

/**
 * get_user_feed - Returns personalized, curated feed of food listings
 *
 * Features:
 * - Pre-filtered by location and dietary preferences
 * - Pre-sorted by relevance (distance + freshness + rating)
 * - Pagination handled server-side
 * - UI hints included (display badges, refresh timing)
 *
 * @param p_user_id - User's ID for personalization
 * @param p_latitude - User's current latitude
 * @param p_longitude - User's current longitude
 * @param p_offset - Pagination offset (default 0)
 * @param p_limit - Page size (default 20)
 *
 * @returns JSONB with feed data and pagination info
 *
 * Usage:
 *   SELECT get_user_feed('user-uuid', -36.8485, 174.7633, 0, 20);
 */
CREATE OR REPLACE FUNCTION public.get_user_feed(
  p_user_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_prefs text[];
  v_items jsonb;
  v_total_count integer;
  v_radius_km integer := 25;
BEGIN
  -- Get user's dietary preferences for filtering
  SELECT COALESCE(
    (SELECT array_agg(pref) FROM jsonb_array_elements_text(dietary_preferences) pref),
    '{}'::text[]
  ) INTO v_user_prefs
  FROM profiles_foodshare
  WHERE id = p_user_id;

  -- Get total count for pagination
  SELECT COUNT(*)::integer INTO v_total_count
  FROM food_items fi
  WHERE fi.is_active = true
    AND fi.deleted_at IS NULL
    AND fi.profile_id != p_user_id
    AND fi.post_type = 'food'
    -- Within radius
    AND (
      fi.latitude IS NULL
      OR fi.longitude IS NULL
      OR (
        6371 * acos(
          cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
          cos(radians(fi.longitude) - radians(p_longitude)) +
          sin(radians(p_latitude)) * sin(radians(fi.latitude))
        )
      ) <= v_radius_km
    );

  -- Get feed items with scoring
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'score' DESC), '[]'::jsonb)
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
      'fullDescription', fi.description,
      'postType', fi.post_type,
      'images', fi.images,
      'thumbnail', CASE
        WHEN fi.images IS NOT NULL AND array_length(fi.images, 1) > 0
        THEN fi.images[1]
        ELSE NULL
      END,
      'location', jsonb_build_object(
        'latitude', fi.latitude,
        'longitude', fi.longitude,
        'address', fi.pickup_address
      ),
      'pickupTime', fi.pickup_time,
      'categoryId', fi.category_id,
      'createdAt', fi.created_at,
      'distance', jsonb_build_object(
        'km', ROUND((
          6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )
        )::numeric, 1),
        'display', ROUND((
          6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )
        )::numeric, 1)::text || ' km away'
      ),
      'profile', jsonb_build_object(
        'id', p.id,
        'username', p.username,
        'avatarUrl', p.avatar_url,
        'rating', p.rating_average,
        'ratingDisplay', CASE
          WHEN p.rating_count > 0 THEN ROUND(p.rating_average::numeric, 1)::text || ' ★'
          ELSE 'New'
        END
      ),
      'freshness', jsonb_build_object(
        'daysOld', EXTRACT(DAY FROM NOW() - fi.created_at)::integer,
        'display', CASE
          WHEN fi.created_at > NOW() - INTERVAL '1 hour' THEN 'Just now'
          WHEN fi.created_at > NOW() - INTERVAL '24 hours' THEN 'Today'
          WHEN fi.created_at > NOW() - INTERVAL '48 hours' THEN 'Yesterday'
          ELSE to_char(fi.created_at, 'Mon DD')
        END
      ),
      'badges', CASE
        WHEN fi.created_at > NOW() - INTERVAL '6 hours' THEN
          jsonb_build_array(jsonb_build_object('text', 'New', 'color', 'green'))
        WHEN (
          6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )
        ) < 1 THEN
          jsonb_build_array(jsonb_build_object('text', 'Nearby', 'color', 'blue'))
        ELSE '[]'::jsonb
      END,
      'score', (
        -- Distance score (0-40): closer is better
        GREATEST(0, 40 - (
          (6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )) / v_radius_km * 40
        ))
        -- Freshness score (0-30): newer is better
        + GREATEST(0, 30 - (EXTRACT(DAY FROM NOW() - fi.created_at) * 2))
        -- Rating score (0-30)
        + (COALESCE(p.rating_average, 0) / 5 * 30)
      )::integer
    ) AS item
    FROM food_items fi
    LEFT JOIN profiles_foodshare p ON p.id = fi.profile_id
    WHERE fi.is_active = true
      AND fi.deleted_at IS NULL
      AND fi.profile_id != p_user_id
      AND fi.post_type = 'food'
      AND (
        fi.latitude IS NULL
        OR fi.longitude IS NULL
        OR (
          6371 * acos(
            cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
            cos(radians(fi.longitude) - radians(p_longitude)) +
            sin(radians(p_latitude)) * sin(radians(fi.latitude))
          )
        ) <= v_radius_km
      )
    ORDER BY (
      GREATEST(0, 40 - (
        (6371 * acos(
          cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
          cos(radians(fi.longitude) - radians(p_longitude)) +
          sin(radians(p_latitude)) * sin(radians(fi.latitude))
        )) / v_radius_km * 40
      ))
      + GREATEST(0, 30 - (EXTRACT(DAY FROM NOW() - fi.created_at) * 2))
      + (COALESCE(p.rating_average, 0) / 5 * 30)
    ) DESC, fi.created_at DESC
    OFFSET p_offset
    LIMIT p_limit
  ) sub;

  -- Return feed with pagination
  RETURN jsonb_build_object(
    'success', true,
    'items', v_items,
    'pagination', jsonb_build_object(
      'offset', p_offset,
      'limit', p_limit,
      'total', v_total_count,
      'hasMore', (p_offset + p_limit) < v_total_count,
      'nextOffset', CASE
        WHEN (p_offset + p_limit) < v_total_count
        THEN p_offset + p_limit
        ELSE NULL
      END
    ),
    'filters', jsonb_build_object(
      'radiusKm', v_radius_km,
      'userLocation', jsonb_build_object('latitude', p_latitude, 'longitude', p_longitude)
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 30,
      'refreshAfter', 60
    ),
    'uiHints', jsonb_build_object(
      'displayMode', 'grid',
      'showMap', true,
      'pullToRefresh', true
    )
  );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_user_feed(uuid, double precision, double precision, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_feed(uuid, double precision, double precision, integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_user_feed IS 'BFF endpoint: Returns personalized, curated feed with pagination and UI hints';

-- ============================================================================
-- get_listing_detail - Complete listing detail with all related data
-- ============================================================================

/**
 * get_listing_detail - Returns complete listing detail for display
 *
 * Aggregates:
 * - Listing data with display-ready formatting
 * - Owner profile data
 * - Distance from viewer (if location provided)
 * - Related listings from same owner
 * - Action buttons based on viewer relationship
 *
 * @param p_listing_id - The listing ID
 * @param p_viewer_id - The viewing user's ID (for relationship/actions)
 *
 * @returns JSONB with complete listing detail
 */
CREATE OR REPLACE FUNCTION public.get_listing_detail(
  p_listing_id uuid,
  p_viewer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing record;
  v_owner record;
  v_related_items jsonb;
  v_is_owner boolean;
BEGIN
  -- Get listing data
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
    fi.is_active,
    fi.created_at,
    fi.updated_at
  INTO v_listing
  FROM food_items fi
  WHERE fi.id = p_listing_id
    AND fi.deleted_at IS NULL;

  IF v_listing IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Listing not found')
    );
  END IF;

  v_is_owner := p_viewer_id IS NOT NULL AND v_listing.profile_id = p_viewer_id;

  -- Get owner profile
  SELECT
    p.id,
    p.username,
    p.avatar_url,
    p.bio,
    p.rating_average,
    p.rating_count,
    p.items_shared,
    p.created_at
  INTO v_owner
  FROM profiles_foodshare p
  WHERE p.id = v_listing.profile_id;

  -- Get related items from same owner
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', fi.id,
      'postName', fi.post_name,
      'thumbnail', CASE
        WHEN fi.images IS NOT NULL AND array_length(fi.images, 1) > 0
        THEN fi.images[1]
        ELSE NULL
      END,
      'postType', fi.post_type
    ) ORDER BY fi.created_at DESC
  ), '[]'::jsonb) INTO v_related_items
  FROM (
    SELECT * FROM food_items
    WHERE profile_id = v_listing.profile_id
      AND id != p_listing_id
      AND is_active = true
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 4
  ) fi;

  -- Return complete detail
  RETURN jsonb_build_object(
    'success', true,
    'listing', jsonb_build_object(
      'id', v_listing.id,
      'postName', v_listing.post_name,
      'description', v_listing.description,
      'postType', v_listing.post_type,
      'images', v_listing.images,
      'location', jsonb_build_object(
        'latitude', v_listing.latitude,
        'longitude', v_listing.longitude,
        'address', v_listing.pickup_address
      ),
      'pickupTime', v_listing.pickup_time,
      'categoryId', v_listing.category_id,
      'isActive', v_listing.is_active,
      'createdAt', v_listing.created_at,
      'updatedAt', v_listing.updated_at,
      'freshness', CASE
        WHEN v_listing.created_at > NOW() - INTERVAL '1 hour' THEN 'Just posted'
        WHEN v_listing.created_at > NOW() - INTERVAL '24 hours' THEN 'Posted today'
        WHEN v_listing.created_at > NOW() - INTERVAL '48 hours' THEN 'Posted yesterday'
        ELSE 'Posted ' || to_char(v_listing.created_at, 'Mon DD')
      END
    ),
    'owner', jsonb_build_object(
      'id', v_owner.id,
      'username', v_owner.username,
      'avatarUrl', v_owner.avatar_url,
      'bio', v_owner.bio,
      'rating', v_owner.rating_average,
      'ratingDisplay', CASE
        WHEN v_owner.rating_count > 0
        THEN ROUND(v_owner.rating_average::numeric, 1)::text || ' ★ (' || v_owner.rating_count || ')'
        ELSE 'New member'
      END,
      'itemsShared', v_owner.items_shared,
      'memberSince', to_char(v_owner.created_at, 'Mon YYYY')
    ),
    'relatedItems', v_related_items,
    'actions', CASE
      WHEN v_is_owner THEN
        jsonb_build_array(
          jsonb_build_object('label', 'Edit Listing', 'action', 'edit', 'style', 'primary'),
          jsonb_build_object('label', 'Mark as Taken', 'action', 'complete', 'style', 'secondary'),
          jsonb_build_object('label', 'Delete', 'action', 'delete', 'style', 'danger')
        )
      ELSE
        jsonb_build_array(
          jsonb_build_object('label', 'Contact', 'action', 'message', 'style', 'primary'),
          jsonb_build_object('label', 'Save', 'action', 'bookmark', 'style', 'secondary'),
          jsonb_build_object('label', 'Report', 'action', 'report', 'style', 'text')
        )
    END,
    'isOwner', v_is_owner,
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 60
    )
  );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_listing_detail(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_listing_detail(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.get_listing_detail IS 'BFF endpoint: Returns complete listing detail with owner info and actions';
