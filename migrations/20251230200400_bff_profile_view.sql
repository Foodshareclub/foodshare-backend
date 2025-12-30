-- ============================================================================
-- BFF Profile View Screen
-- Complete profile data with context-aware actions
-- ============================================================================

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS public.get_profile_view(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_my_profile(uuid);

-- ============================================================================
-- get_profile_view - Complete profile screen for viewing any user
-- ============================================================================

/**
 * get_profile_view - Returns complete profile data for display
 *
 * Features:
 * - Profile data with display-ready formatting
 * - User's listings (recent 10)
 * - Rating breakdown
 * - Context-aware actions (edit/settings for own, message/report for others)
 * - Relationship status if applicable
 *
 * @param p_profile_id - The profile to view
 * @param p_viewer_id - The viewing user's ID (optional, for relationship/actions)
 *
 * @returns JSONB with complete profile data
 */
CREATE OR REPLACE FUNCTION public.get_profile_view(
  p_profile_id uuid,
  p_viewer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_listings jsonb;
  v_is_own_profile boolean;
  v_listing_stats record;
  v_shared_rooms integer;
BEGIN
  v_is_own_profile := p_viewer_id IS NOT NULL AND p_profile_id = p_viewer_id;

  -- Get profile data
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
    p.created_at,
    p.updated_at
  INTO v_profile
  FROM profiles p
  WHERE p.id = p_profile_id
    AND p.deleted_at IS NULL;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Profile not found')
    );
  END IF;

  -- Get listing stats
  SELECT
    COUNT(*) FILTER (WHERE is_active = true AND deleted_at IS NULL) AS active_count,
    COUNT(*) FILTER (WHERE is_active = false AND deleted_at IS NULL) AS completed_count,
    COUNT(*) FILTER (WHERE post_type = 'food' AND deleted_at IS NULL) AS food_count,
    COUNT(*) FILTER (WHERE post_type = 'request' AND deleted_at IS NULL) AS request_count
  INTO v_listing_stats
  FROM posts
  WHERE profile_id = p_profile_id;

  -- Get recent listings
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', fi.id,
      'postName', fi.post_name,
      'thumbnail', CASE
        WHEN fi.images IS NOT NULL AND array_length(fi.images, 1) > 0
        THEN fi.images[1]
        ELSE NULL
      END,
      'postType', fi.post_type,
      'isActive', fi.is_active,
      'createdAt', fi.created_at,
      'freshness', CASE
        WHEN fi.created_at > NOW() - INTERVAL '24 hours' THEN 'Today'
        WHEN fi.created_at > NOW() - INTERVAL '7 days' THEN
          EXTRACT(DAY FROM NOW() - fi.created_at)::integer || 'd ago'
        ELSE to_char(fi.created_at, 'Mon DD')
      END
    ) ORDER BY fi.created_at DESC
  ), '[]'::jsonb) INTO v_listings
  FROM (
    SELECT * FROM posts
    WHERE profile_id = p_profile_id
      AND deleted_at IS NULL
      AND (v_is_own_profile OR is_active = true)  -- Show inactive only for own profile
    ORDER BY created_at DESC
    LIMIT 10
  ) fi;

  -- Count shared rooms (conversations) if viewer provided
  IF p_viewer_id IS NOT NULL AND NOT v_is_own_profile THEN
    SELECT COUNT(*) INTO v_shared_rooms
    FROM rooms
    WHERE (sharer = p_profile_id AND requester = p_viewer_id)
       OR (requester = p_profile_id AND sharer = p_viewer_id);
  END IF;

  -- Return complete profile view
  RETURN jsonb_build_object(
    'success', true,
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'username', v_profile.username,
      'avatarUrl', v_profile.avatar_url,
      'bio', v_profile.bio,
      'isActive', v_profile.is_active,
      'memberSince', to_char(v_profile.created_at, 'Mon YYYY'),
      'memberDays', EXTRACT(DAY FROM NOW() - v_profile.created_at)::integer,
      'dietaryPreferences', COALESCE(v_profile.dietary_preferences, '[]'::jsonb)
    ),
    'stats', jsonb_build_object(
      'itemsShared', COALESCE(v_profile.items_shared, 0),
      'itemsSharedDisplay', COALESCE(v_profile.items_shared, 0) || ' items shared',
      'rating', COALESCE(v_profile.rating_average, 0),
      'ratingCount', COALESCE(v_profile.rating_count, 0),
      'ratingDisplay', CASE
        WHEN v_profile.rating_count > 0 THEN
          ROUND(v_profile.rating_average::numeric, 1)::text || ' ★ (' || v_profile.rating_count || ' reviews)'
        ELSE 'New member'
      END,
      'ratingStars', CASE
        WHEN v_profile.rating_count > 0 THEN
          jsonb_build_object(
            'full', FLOOR(v_profile.rating_average)::integer,
            'half', CASE WHEN (v_profile.rating_average - FLOOR(v_profile.rating_average)) >= 0.5 THEN 1 ELSE 0 END,
            'empty', 5 - CEIL(v_profile.rating_average)::integer
          )
        ELSE NULL
      END
    ),
    'listingStats', jsonb_build_object(
      'active', v_listing_stats.active_count,
      'completed', v_listing_stats.completed_count,
      'food', v_listing_stats.food_count,
      'requests', v_listing_stats.request_count
    ),
    'listings', v_listings,
    'listingsHasMore', jsonb_array_length(v_listings) = 10,
    'isOwnProfile', v_is_own_profile,
    'relationship', CASE
      WHEN v_is_own_profile THEN NULL
      WHEN v_shared_rooms > 0 THEN jsonb_build_object(
        'hasConversation', true,
        'conversationCount', v_shared_rooms
      )
      ELSE jsonb_build_object('hasConversation', false)
    END,
    'actions', CASE
      WHEN v_is_own_profile THEN jsonb_build_array(
        jsonb_build_object('label', 'Edit Profile', 'action', 'edit_profile', 'icon', 'edit', 'style', 'primary'),
        jsonb_build_object('label', 'Settings', 'action', 'settings', 'icon', 'settings', 'style', 'secondary'),
        jsonb_build_object('label', 'Share Profile', 'action', 'share', 'icon', 'share', 'style', 'text')
      )
      ELSE jsonb_build_array(
        jsonb_build_object('label', 'Message', 'action', 'message', 'icon', 'message-circle', 'style', 'primary'),
        jsonb_build_object('label', 'View Listings', 'action', 'view_listings', 'icon', 'list', 'style', 'secondary'),
        jsonb_build_object('label', 'Report', 'action', 'report', 'icon', 'flag', 'style', 'danger')
      )
    END,
    'tabs', jsonb_build_array(
      jsonb_build_object('id', 'listings', 'label', 'Listings', 'count', v_listing_stats.active_count),
      jsonb_build_object('id', 'completed', 'label', 'Completed', 'count', v_listing_stats.completed_count)
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 60,
      'refreshAfter', 300
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_profile_view(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_profile_view(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.get_profile_view IS 'BFF endpoint: Returns complete profile view with context-aware actions';

-- ============================================================================
-- get_my_profile - Optimized endpoint for viewing own profile
-- ============================================================================

/**
 * get_my_profile - Returns own profile data with edit capabilities
 *
 * Includes additional data only relevant for own profile:
 * - Email (hidden for others)
 * - Private stats
 * - Editable fields marked
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with complete own profile data
 */
CREATE OR REPLACE FUNCTION public.get_my_profile(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_listing_stats record;
  v_recent_activity jsonb;
  v_unread_count integer;
BEGIN
  -- Get profile data
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
  FROM profiles p
  WHERE p.id = p_user_id
    AND p.deleted_at IS NULL;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Profile not found')
    );
  END IF;

  -- Get listing stats
  SELECT
    COUNT(*) FILTER (WHERE is_active = true AND deleted_at IS NULL AND post_type = 'food') AS active_food,
    COUNT(*) FILTER (WHERE is_active = true AND deleted_at IS NULL AND post_type = 'request') AS active_requests,
    COUNT(*) FILTER (WHERE is_active = false AND deleted_at IS NULL) AS completed,
    COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total
  INTO v_listing_stats
  FROM posts
  WHERE profile_id = p_user_id;

  -- Get unread counts
  SELECT COUNT(*) INTO v_unread_count
  FROM notifications
  WHERE profile_id = p_user_id AND read_at IS NULL;

  -- Get recent activity summary
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'type', 'notification',
      'title', n.notification_title,
      'timestamp', n.timestamp,
      'isRead', n.read_at IS NOT NULL
    ) ORDER BY n.timestamp DESC
  ), '[]'::jsonb) INTO v_recent_activity
  FROM (
    SELECT * FROM notifications
    WHERE profile_id = p_user_id
    ORDER BY timestamp DESC
    LIMIT 3
  ) n;

  -- Return profile with editable fields
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
      'notificationPreferences', COALESCE(v_profile.notification_preferences, '{}'::jsonb),
      'createdAt', v_profile.created_at,
      'updatedAt', v_profile.updated_at
    ),
    'editableFields', jsonb_build_array(
      jsonb_build_object('field', 'username', 'type', 'text', 'label', 'Username', 'maxLength', 30),
      jsonb_build_object('field', 'bio', 'type', 'textarea', 'label', 'Bio', 'maxLength', 500),
      jsonb_build_object('field', 'avatarUrl', 'type', 'image', 'label', 'Profile Photo'),
      jsonb_build_object('field', 'dietaryPreferences', 'type', 'multiselect', 'label', 'Dietary Preferences',
        'options', jsonb_build_array('vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'halal', 'kosher'))
    ),
    'stats', jsonb_build_object(
      'itemsShared', COALESCE(v_profile.items_shared, 0),
      'rating', COALESCE(v_profile.rating_average, 0),
      'ratingCount', COALESCE(v_profile.rating_count, 0),
      'ratingDisplay', CASE
        WHEN v_profile.rating_count > 0 THEN
          ROUND(v_profile.rating_average::numeric, 1)::text || ' ★'
        ELSE 'No ratings'
      END,
      'memberSince', to_char(v_profile.created_at, 'Mon YYYY'),
      'memberDays', EXTRACT(DAY FROM NOW() - v_profile.created_at)::integer
    ),
    'listingStats', jsonb_build_object(
      'activeFood', v_listing_stats.active_food,
      'activeRequests', v_listing_stats.active_requests,
      'completed', v_listing_stats.completed,
      'total', v_listing_stats.total
    ),
    'badges', CASE
      WHEN v_unread_count > 0 THEN
        jsonb_build_array(
          jsonb_build_object('text', v_unread_count::text, 'color', 'red', 'screen', 'Notifications')
        )
      ELSE '[]'::jsonb
    END,
    'recentActivity', v_recent_activity,
    'quickLinks', jsonb_build_array(
      jsonb_build_object('label', 'My Listings', 'screen', 'MyListings', 'icon', 'list', 'badge', v_listing_stats.active_food + v_listing_stats.active_requests),
      jsonb_build_object('label', 'Notifications', 'screen', 'Notifications', 'icon', 'bell', 'badge', v_unread_count),
      jsonb_build_object('label', 'Settings', 'screen', 'Settings', 'icon', 'settings'),
      jsonb_build_object('label', 'Help', 'screen', 'Help', 'icon', 'help-circle')
    ),
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 60,
      'refreshAfter', 300
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_profile(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_profile(uuid) TO service_role;

COMMENT ON FUNCTION public.get_my_profile IS 'BFF endpoint: Returns own profile with editable field definitions';

-- ============================================================================
-- update_my_profile - Updates own profile
-- ============================================================================

/**
 * update_my_profile - Updates profile fields
 *
 * @param p_user_id - The user's ID
 * @param p_updates - JSONB with fields to update
 *
 * @returns JSONB with updated profile
 */
CREATE OR REPLACE FUNCTION public.update_my_profile(
  p_user_id uuid,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
BEGIN
  -- Update allowed fields only
  UPDATE profiles SET
    username = COALESCE(p_updates->>'username', username),
    bio = COALESCE(p_updates->>'bio', bio),
    avatar_url = COALESCE(p_updates->>'avatarUrl', avatar_url),
    dietary_preferences = COALESCE(p_updates->'dietaryPreferences', dietary_preferences),
    updated_at = NOW()
  WHERE id = p_user_id
    AND deleted_at IS NULL
  RETURNING * INTO v_profile;

  IF v_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Profile not found')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'username', v_profile.username,
      'bio', v_profile.bio,
      'avatarUrl', v_profile.avatar_url,
      'dietaryPreferences', v_profile.dietary_preferences,
      'updatedAt', v_profile.updated_at
    ),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_profile(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_profile(uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.update_my_profile IS 'Updates user profile fields';
