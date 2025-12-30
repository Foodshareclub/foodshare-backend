-- ============================================================================
-- BFF Notifications Screen
-- Complete notifications screen data in a single call
-- Uses user_notifications table (the actual notification storage)
-- ============================================================================

-- Drop existing functions if they exist
DROP FUNCTION IF EXISTS public.get_notifications_screen(uuid, integer, integer, text);
DROP FUNCTION IF EXISTS public.mark_notification_read(uuid, uuid);
DROP FUNCTION IF EXISTS public.mark_all_notifications_read(uuid);
DROP FUNCTION IF EXISTS public.delete_notification(uuid, uuid);

-- ============================================================================
-- get_notifications_screen - Complete notifications screen data
-- ============================================================================

/**
 * get_notifications_screen - Returns all data for the notifications screen
 *
 * Features:
 * - Paginated notification list
 * - Filter by type (all, unread, messages, listings)
 * - Display-ready formatting (time display, icons)
 * - Action hints for navigation
 * - Bulk action states
 *
 * @param p_user_id - The user's ID
 * @param p_offset - Pagination offset (default 0)
 * @param p_limit - Page size (default 50)
 * @param p_filter - Filter type: 'all', 'unread', 'messages', 'listings' (default 'all')
 *
 * @returns JSONB with notifications and metadata
 */
CREATE OR REPLACE FUNCTION public.get_notifications_screen(
  p_user_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 50,
  p_filter text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notifications jsonb;
  v_unread_count integer;
  v_total_count integer;
  v_filter_counts jsonb;
BEGIN
  -- Validate filter
  IF p_filter NOT IN ('all', 'unread', 'messages', 'listings', 'system') THEN
    p_filter := 'all';
  END IF;

  -- Get counts for filter tabs (using user_notifications table)
  SELECT jsonb_build_object(
    'all', COUNT(*),
    'unread', COUNT(*) FILTER (WHERE is_read = false),
    'messages', COUNT(*) FILTER (WHERE type = 'new_message'),
    'listings', COUNT(*) FILTER (WHERE type IN ('post_claimed', 'post_arranged', 'post_expiring', 'nearby_post'))
  ) INTO v_filter_counts
  FROM user_notifications
  WHERE recipient_id = p_user_id;

  v_unread_count := (v_filter_counts->>'unread')::integer;

  -- Get total count for current filter
  SELECT COUNT(*) INTO v_total_count
  FROM user_notifications n
  WHERE n.recipient_id = p_user_id
    AND (
      p_filter = 'all'
      OR (p_filter = 'unread' AND n.is_read = false)
      OR (p_filter = 'messages' AND n.type = 'new_message')
      OR (p_filter = 'listings' AND n.type IN ('post_claimed', 'post_arranged', 'post_expiring', 'nearby_post'))
      OR (p_filter = 'system' AND n.type IN ('welcome', 'system'))
    );

  -- Get filtered notifications with display formatting
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', n.id,
      'title', n.title,
      'body', n.body,
      'timestamp', n.created_at,
      'timeDisplay', CASE
        WHEN n.created_at > NOW() - INTERVAL '1 minute' THEN 'Just now'
        WHEN n.created_at > NOW() - INTERVAL '1 hour' THEN
          EXTRACT(MINUTE FROM NOW() - n.created_at)::integer || 'm ago'
        WHEN n.created_at > NOW() - INTERVAL '24 hours' THEN
          EXTRACT(HOUR FROM NOW() - n.created_at)::integer || 'h ago'
        WHEN n.created_at > NOW() - INTERVAL '48 hours' THEN 'Yesterday'
        WHEN n.created_at > NOW() - INTERVAL '7 days' THEN
          EXTRACT(DAY FROM NOW() - n.created_at)::integer || 'd ago'
        ELSE to_char(n.created_at, 'Mon DD')
      END,
      'isRead', n.is_read,
      'readAt', n.read_at,
      'type', n.type,
      'icon', CASE n.type
        WHEN 'new_message' THEN 'message-circle'
        WHEN 'post_claimed' THEN 'check-circle'
        WHEN 'post_arranged' THEN 'handshake'
        WHEN 'review_received' THEN 'star'
        WHEN 'review_reminder' THEN 'star'
        WHEN 'post_expiring' THEN 'clock'
        WHEN 'nearby_post' THEN 'map-pin'
        WHEN 'welcome' THEN 'heart'
        ELSE 'bell'
      END,
      'action', jsonb_build_object(
        'screen', CASE n.type
          WHEN 'new_message' THEN 'Chat'
          WHEN 'post_claimed' THEN 'FoodItemDetail'
          WHEN 'post_arranged' THEN 'FoodItemDetail'
          WHEN 'review_received' THEN 'Reviews'
          WHEN 'review_reminder' THEN 'Reviews'
          WHEN 'post_expiring' THEN 'FoodItemDetail'
          WHEN 'nearby_post' THEN 'FoodItemDetail'
          ELSE 'Notifications'
        END,
        'params', COALESCE(n.data, '{}'::jsonb),
        'postId', n.post_id,
        'roomId', n.room_id
      ),
      'actor', CASE WHEN n.actor_id IS NOT NULL THEN (
        SELECT jsonb_build_object(
          'id', p.id,
          'nickname', p.nickname,
          'avatarUrl', p.avatar_url
        )
        FROM profiles p
        WHERE p.id = n.actor_id
      ) ELSE NULL END,
      'swipeActions', jsonb_build_array(
        jsonb_build_object(
          'label', CASE WHEN n.is_read = false THEN 'Mark Read' ELSE 'Mark Unread' END,
          'action', CASE WHEN n.is_read = false THEN 'mark_read' ELSE 'mark_unread' END,
          'color', 'blue'
        ),
        jsonb_build_object('label', 'Delete', 'action', 'delete', 'color', 'red')
      )
    ) ORDER BY n.created_at DESC
  ), '[]'::jsonb) INTO v_notifications
  FROM (
    SELECT *
    FROM user_notifications
    WHERE recipient_id = p_user_id
      AND (
        p_filter = 'all'
        OR (p_filter = 'unread' AND is_read = false)
        OR (p_filter = 'messages' AND type = 'new_message')
        OR (p_filter = 'listings' AND type IN ('post_claimed', 'post_arranged', 'post_expiring', 'nearby_post'))
        OR (p_filter = 'system' AND type IN ('welcome', 'system'))
      )
    ORDER BY created_at DESC
    OFFSET p_offset
    LIMIT p_limit
  ) n;

  -- Return complete screen data
  RETURN jsonb_build_object(
    'success', true,
    'notifications', v_notifications,
    'counts', jsonb_build_object(
      'unread', v_unread_count,
      'total', v_total_count,
      'filtered', jsonb_array_length(v_notifications)
    ),
    'filterCounts', v_filter_counts,
    'filters', jsonb_build_array(
      jsonb_build_object('id', 'all', 'label', 'All', 'count', (v_filter_counts->>'all')::integer, 'isActive', p_filter = 'all'),
      jsonb_build_object('id', 'unread', 'label', 'Unread', 'count', (v_filter_counts->>'unread')::integer, 'isActive', p_filter = 'unread'),
      jsonb_build_object('id', 'messages', 'label', 'Messages', 'count', (v_filter_counts->>'messages')::integer, 'isActive', p_filter = 'messages'),
      jsonb_build_object('id', 'listings', 'label', 'Listings', 'count', (v_filter_counts->>'listings')::integer, 'isActive', p_filter = 'listings')
    ),
    'pagination', jsonb_build_object(
      'offset', p_offset,
      'limit', p_limit,
      'total', v_total_count,
      'hasMore', (p_offset + p_limit) < v_total_count,
      'nextOffset', CASE WHEN (p_offset + p_limit) < v_total_count THEN p_offset + p_limit ELSE NULL END
    ),
    'actions', jsonb_build_array(
      jsonb_build_object(
        'label', 'Mark All Read',
        'action', 'mark_all_read',
        'enabled', v_unread_count > 0,
        'icon', 'check-all'
      )
    ),
    'emptyState', CASE
      WHEN v_total_count = 0 THEN jsonb_build_object(
        'title', CASE p_filter
          WHEN 'unread' THEN 'All caught up!'
          WHEN 'messages' THEN 'No message notifications'
          WHEN 'listings' THEN 'No listing notifications'
          ELSE 'No notifications yet'
        END,
        'message', CASE p_filter
          WHEN 'unread' THEN 'You have no unread notifications'
          WHEN 'messages' THEN 'Message notifications will appear here'
          WHEN 'listings' THEN 'Listing notifications will appear here'
          ELSE 'When you get notifications, they will appear here'
        END,
        'icon', 'bell-off'
      )
      ELSE NULL
    END,
    'meta', jsonb_build_object(
      'timestamp', NOW(),
      'cacheTTL', 30,
      'refreshAfter', 60
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_notifications_screen(uuid, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_notifications_screen(uuid, integer, integer, text) TO service_role;

COMMENT ON FUNCTION public.get_notifications_screen IS 'BFF endpoint: Returns complete notifications screen data';

-- ============================================================================
-- mark_notification_read - Marks a single notification as read
-- ============================================================================

/**
 * mark_notification_read - Marks a notification as read
 *
 * @param p_user_id - The user's ID (for ownership verification)
 * @param p_notification_id - The notification ID (uuid)
 *
 * @returns JSONB with success status
 */
CREATE OR REPLACE FUNCTION public.mark_notification_read(
  p_user_id uuid,
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affected integer;
BEGIN
  UPDATE user_notifications
  SET is_read = true,
      read_at = NOW(),
      updated_at = NOW()
  WHERE id = p_notification_id
    AND recipient_id = p_user_id
    AND is_read = false;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected = 0 THEN
    -- Check if notification exists
    IF NOT EXISTS (SELECT 1 FROM user_notifications WHERE id = p_notification_id AND recipient_id = p_user_id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
    END IF;
    -- Already read
    RETURN jsonb_build_object('success', true, 'alreadyRead', true);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'notificationId', p_notification_id,
    'readAt', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid, uuid) TO service_role;

-- ============================================================================
-- mark_all_notifications_read - Marks all notifications as read
-- ============================================================================

/**
 * mark_all_notifications_read - Marks all user's notifications as read
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with count of marked notifications
 */
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affected integer;
BEGIN
  UPDATE user_notifications
  SET is_read = true,
      read_at = NOW(),
      updated_at = NOW()
  WHERE recipient_id = p_user_id
    AND is_read = false;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'markedCount', v_affected,
    'readAt', NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(uuid) TO service_role;

-- ============================================================================
-- delete_notification - Deletes a notification
-- ============================================================================

/**
 * delete_notification - Deletes a notification
 *
 * @param p_user_id - The user's ID (for ownership verification)
 * @param p_notification_id - The notification ID (uuid)
 *
 * @returns JSONB with success status
 */
CREATE OR REPLACE FUNCTION public.delete_notification(
  p_user_id uuid,
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affected integer;
BEGIN
  DELETE FROM user_notifications
  WHERE id = p_notification_id
    AND recipient_id = p_user_id;

  GET DIAGNOSTICS v_affected = ROW_COUNT;

  IF v_affected = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'deletedId', p_notification_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_notification(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_notification(uuid, uuid) TO service_role;

-- ============================================================================
-- get_notification_summary - Quick badge counts for app header
-- ============================================================================

/**
 * get_notification_summary - Returns quick counts for header badges
 *
 * Lightweight function for frequent polling.
 *
 * @param p_user_id - The user's ID
 *
 * @returns JSONB with unread counts
 */
CREATE OR REPLACE FUNCTION public.get_notification_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unread_notifications integer;
  v_unread_messages integer;
BEGIN
  -- Get unread notification count
  SELECT COUNT(*) INTO v_unread_notifications
  FROM user_notifications
  WHERE recipient_id = p_user_id
    AND is_read = false;

  -- Get unread message count (from rooms)
  SELECT COUNT(*) INTO v_unread_messages
  FROM rooms
  WHERE (sharer = p_user_id OR requester = p_user_id)
    AND last_message_sent_by IS DISTINCT FROM p_user_id
    AND (last_message_seen_by IS NULL OR last_message_seen_by IS DISTINCT FROM p_user_id)
    AND last_message IS NOT NULL
    AND last_message != '';

  RETURN jsonb_build_object(
    'success', true,
    'notifications', v_unread_notifications,
    'messages', v_unread_messages,
    'total', v_unread_notifications + v_unread_messages,
    'badge', CASE
      WHEN (v_unread_notifications + v_unread_messages) > 99 THEN '99+'
      WHEN (v_unread_notifications + v_unread_messages) > 0 THEN (v_unread_notifications + v_unread_messages)::text
      ELSE NULL
    END,
    'meta', jsonb_build_object('timestamp', NOW(), 'cacheTTL', 30)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_notification_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_summary(uuid) TO service_role;

COMMENT ON FUNCTION public.get_notification_summary IS 'Lightweight notification counts for header badges';
