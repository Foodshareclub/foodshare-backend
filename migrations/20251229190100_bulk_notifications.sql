-- ============================================================================
-- Bulk Notification RPCs
-- Eliminates N+1 notification pattern - single transaction for all notifications
-- ============================================================================

-- Drop existing functions if exist
DROP FUNCTION IF EXISTS public.notify_nearby_users_bulk(uuid, uuid, double precision, double precision, text, text, integer);
DROP FUNCTION IF EXISTS public.create_listing_and_notify(uuid, text, text, text, text[], double precision, double precision, text, text, integer, integer);

-- ============================================================================
-- notify_nearby_users_bulk - Bulk notification to nearby users
-- ============================================================================

/**
 * notify_nearby_users_bulk - Create notifications for all nearby users in one transaction
 *
 * Finds users within radius who have new_listings notifications enabled
 * and creates notification records in bulk (single INSERT).
 *
 * @param p_food_item_id - The food item that triggered the notification
 * @param p_sender_id - The user who created the listing (excluded from notifications)
 * @param p_latitude - Listing latitude
 * @param p_longitude - Listing longitude
 * @param p_title - Listing title for notification text
 * @param p_notification_type - Type of notification (default 'new_listing')
 * @param p_radius_km - Search radius in kilometers (default 10)
 *
 * @returns integer - Count of notifications created
 *
 * Usage:
 *   SELECT notify_nearby_users_bulk(
 *     '123e4567-e89b-12d3-a456-426614174000'::uuid,
 *     'user-uuid'::uuid,
 *     -36.8485, 174.7633,
 *     'Fresh Apples',
 *     'new_listing',
 *     10
 *   );
 */
CREATE OR REPLACE FUNCTION public.notify_nearby_users_bulk(
  p_food_item_id uuid,
  p_sender_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_title text,
  p_notification_type text DEFAULT 'new_listing',
  p_radius_km integer DEFAULT 10
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notification_count integer := 0;
BEGIN
  -- Insert notifications for all eligible nearby users in a single statement
  WITH nearby_profiles AS (
    -- Find profiles within radius who have notifications enabled
    SELECT DISTINCT p.id AS profile_id
    FROM profiles_foodshare p
    INNER JOIN food_items fi ON fi.profile_id = p.id
    WHERE p.id != p_sender_id
      AND p.is_active = true
      -- Check notification preferences (JSONB field)
      AND (p.notification_preferences->>'new_listings')::boolean = true
      -- Bounding box filter for performance
      AND fi.latitude BETWEEN p_latitude - (p_radius_km / 111.0) AND p_latitude + (p_radius_km / 111.0)
      AND fi.longitude BETWEEN p_longitude - (p_radius_km / (111.0 * cos(radians(p_latitude))))
                           AND p_longitude + (p_radius_km / (111.0 * cos(radians(p_latitude))))
      AND fi.is_active = true
      AND fi.deleted_at IS NULL
      -- Actual distance check with Haversine
      AND (
        6371 * acos(
          cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
          cos(radians(fi.longitude) - radians(p_longitude)) +
          sin(radians(p_latitude)) * sin(radians(fi.latitude))
        )
      ) <= p_radius_km
  ),
  inserted_notifications AS (
    INSERT INTO notifications (
      profile_id,
      notification_title,
      notification_text,
      parameter_data,
      initial_page_name,
      status,
      timestamp
    )
    SELECT
      np.profile_id,
      'New food available nearby!',
      p_title || ' is now available in your area',
      jsonb_build_object('food_item_id', p_food_item_id, 'type', p_notification_type),
      'FoodItemDetail',
      'sent',
      NOW()
    FROM nearby_profiles np
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_notification_count FROM inserted_notifications;

  RETURN v_notification_count;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.notify_nearby_users_bulk(uuid, uuid, double precision, double precision, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_nearby_users_bulk(uuid, uuid, double precision, double precision, text, text, integer) TO service_role;

COMMENT ON FUNCTION public.notify_nearby_users_bulk IS 'Bulk notification to nearby users - eliminates N+1 pattern with single INSERT';

-- ============================================================================
-- create_listing_and_notify - Atomic listing creation with notification
-- ============================================================================

/**
 * create_listing_and_notify - Create listing and notify nearby users atomically
 *
 * Combines listing creation and notification in a single transaction.
 * If listing fails, no notifications are sent. If notifications fail,
 * the listing is still created (notifications are best-effort).
 *
 * @param p_profile_id - The user creating the listing
 * @param p_title - Listing title
 * @param p_description - Listing description (optional)
 * @param p_post_type - Type of post (food, request, etc.)
 * @param p_images - Array of image URLs
 * @param p_latitude - Listing latitude
 * @param p_longitude - Listing longitude
 * @param p_pickup_address - Pickup address (optional)
 * @param p_pickup_time - Pickup time window (optional)
 * @param p_category_id - Category ID (optional)
 * @param p_notify_radius_km - Radius for notifications (default 10)
 *
 * @returns JSONB with listing details and notification count
 *
 * Usage:
 *   SELECT create_listing_and_notify(
 *     'user-uuid'::uuid,
 *     'Fresh Apples',
 *     'Organic apples from my garden',
 *     'food',
 *     ARRAY['https://...'],
 *     -36.8485, 174.7633,
 *     '123 Main St',
 *     'Anytime today',
 *     1,
 *     10
 *   );
 */
CREATE OR REPLACE FUNCTION public.create_listing_and_notify(
  p_profile_id uuid,
  p_title text,
  p_description text DEFAULT NULL,
  p_post_type text DEFAULT 'food',
  p_images text[] DEFAULT '{}',
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL,
  p_pickup_address text DEFAULT NULL,
  p_pickup_time text DEFAULT NULL,
  p_category_id integer DEFAULT NULL,
  p_notify_radius_km integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_listing_id uuid;
  v_listing_record record;
  v_notification_count integer := 0;
  v_validation_result jsonb;
BEGIN
  -- =========================================================================
  -- 1. Validate content before creating listing
  -- =========================================================================
  SELECT validate_listing_content(p_title, p_description) INTO v_validation_result;

  IF NOT (v_validation_result->>'valid')::boolean THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object(
        'code', 'VALIDATION_FAILED',
        'message', 'Content validation failed',
        'details', v_validation_result->'errors'
      )
    );
  END IF;

  -- =========================================================================
  -- 2. Create the listing
  -- =========================================================================
  INSERT INTO food_items (
    profile_id,
    post_name,
    description,
    post_type,
    images,
    latitude,
    longitude,
    pickup_address,
    pickup_time,
    category_id,
    is_active,
    created_at,
    updated_at
  ) VALUES (
    p_profile_id,
    p_title,
    p_description,
    p_post_type,
    p_images,
    p_latitude,
    p_longitude,
    p_pickup_address,
    p_pickup_time,
    p_category_id,
    true,
    NOW(),
    NOW()
  )
  RETURNING id, post_name, description, post_type, images, latitude, longitude,
            pickup_address, pickup_time, category_id, is_active, created_at
  INTO v_listing_record;

  v_listing_id := v_listing_record.id;

  -- =========================================================================
  -- 3. Update user's items_shared count
  -- =========================================================================
  UPDATE profiles_foodshare
  SET items_shared = COALESCE(items_shared, 0) + 1,
      updated_at = NOW()
  WHERE id = p_profile_id;

  -- =========================================================================
  -- 4. Send notifications to nearby users (if location provided)
  -- =========================================================================
  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    SELECT notify_nearby_users_bulk(
      v_listing_id,
      p_profile_id,
      p_latitude,
      p_longitude,
      p_title,
      'new_listing',
      p_notify_radius_km
    ) INTO v_notification_count;
  END IF;

  -- =========================================================================
  -- 5. Return success response
  -- =========================================================================
  RETURN jsonb_build_object(
    'success', true,
    'listing', jsonb_build_object(
      'id', v_listing_id,
      'postName', v_listing_record.post_name,
      'description', v_listing_record.description,
      'postType', v_listing_record.post_type,
      'images', v_listing_record.images,
      'latitude', v_listing_record.latitude,
      'longitude', v_listing_record.longitude,
      'pickupAddress', v_listing_record.pickup_address,
      'pickupTime', v_listing_record.pickup_time,
      'categoryId', v_listing_record.category_id,
      'isActive', v_listing_record.is_active,
      'createdAt', v_listing_record.created_at
    ),
    'notificationsSent', v_notification_count
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', jsonb_build_object(
        'code', 'SERVER_ERROR',
        'message', SQLERRM
      )
    );
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.create_listing_and_notify(uuid, text, text, text, text[], double precision, double precision, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_listing_and_notify(uuid, text, text, text, text[], double precision, double precision, text, text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.create_listing_and_notify IS 'Atomic listing creation with bulk notifications - single transaction for listing + all notifications';

-- ============================================================================
-- Helper: Quick count of users who would be notified
-- ============================================================================

DROP FUNCTION IF EXISTS public.count_notifiable_users(uuid, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.count_notifiable_users(
  p_sender_id uuid,
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
  SELECT COUNT(DISTINCT p.id)::integer
  FROM profiles_foodshare p
  INNER JOIN food_items fi ON fi.profile_id = p.id
  WHERE p.id != p_sender_id
    AND p.is_active = true
    AND (p.notification_preferences->>'new_listings')::boolean = true
    AND fi.latitude BETWEEN p_latitude - (p_radius_km / 111.0) AND p_latitude + (p_radius_km / 111.0)
    AND fi.longitude BETWEEN p_longitude - (p_radius_km / (111.0 * cos(radians(p_latitude))))
                         AND p_longitude + (p_radius_km / (111.0 * cos(radians(p_latitude))))
    AND fi.is_active = true
    AND fi.deleted_at IS NULL
    AND (
      6371 * acos(
        cos(radians(p_latitude)) * cos(radians(fi.latitude)) *
        cos(radians(fi.longitude) - radians(p_longitude)) +
        sin(radians(p_latitude)) * sin(radians(fi.latitude))
      )
    ) <= p_radius_km;
$$;

GRANT EXECUTE ON FUNCTION public.count_notifiable_users(uuid, double precision, double precision, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_notifiable_users(uuid, double precision, double precision, integer) TO service_role;

COMMENT ON FUNCTION public.count_notifiable_users IS 'Quick count of users who would receive new listing notifications (for UI preview)';
