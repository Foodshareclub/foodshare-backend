-- ============================================================================
-- Notification Optimization
-- Queue-based processing with consolidation, priority, and quiet hours
-- ============================================================================

-- Drop existing objects if they exist
DROP TABLE IF EXISTS public.notification_priority_config CASCADE;
DROP TABLE IF EXISTS public.notification_queue CASCADE;
DROP FUNCTION IF EXISTS public.queue_notification(uuid, text, text, jsonb, integer, text);
DROP FUNCTION IF EXISTS public.process_notification_queue(integer);
DROP FUNCTION IF EXISTS public.check_quiet_hours(uuid);
DROP FUNCTION IF EXISTS public.get_quiet_hours_end(uuid);

-- ============================================================================
-- notification_priority_config - Priority settings per notification type
-- ============================================================================

CREATE TABLE public.notification_priority_config (
  notification_type text PRIMARY KEY,
  base_priority integer NOT NULL DEFAULT 5 CHECK (base_priority >= 1 AND base_priority <= 10),
  bypass_consolidation boolean NOT NULL DEFAULT false,
  bypass_quiet_hours boolean NOT NULL DEFAULT false,
  max_per_hour integer,
  consolidation_window_minutes integer DEFAULT 15,
  ttl_seconds integer DEFAULT 86400
);

-- Insert default configuration
INSERT INTO notification_priority_config (notification_type, base_priority, bypass_consolidation, bypass_quiet_hours, max_per_hour, consolidation_window_minutes)
VALUES
  ('message', 8, false, false, NULL, 5),           -- Messages: high priority, quick consolidation
  ('match_found', 7, false, false, 10, 30),        -- Matches: medium-high, limited
  ('new_listing', 5, false, false, 20, 15),        -- New listings: medium, consolidate
  ('listing_expired', 4, false, false, NULL, 60),  -- Expiry: lower priority
  ('rating_received', 6, false, false, NULL, 30),  -- Ratings: medium priority
  ('system', 10, true, true, NULL, 0),             -- System: bypass all controls
  ('marketing', 3, false, false, 5, 120)           -- Marketing: low priority, heavily limited
ON CONFLICT (notification_type) DO NOTHING;

COMMENT ON TABLE public.notification_priority_config IS 'Priority and consolidation settings per notification type';

-- ============================================================================
-- notification_queue - Pending notifications for batch processing
-- ============================================================================

CREATE TABLE public.notification_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  consolidation_key text,  -- For grouping similar notifications
  title text NOT NULL,
  body text,
  payload jsonb NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),

  -- Scheduling
  scheduled_for timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),

  -- Processing state
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consolidated', 'sent', 'dropped', 'failed')),
  processed_at timestamptz,
  error_message text,

  -- Consolidation tracking
  consolidated_count integer DEFAULT 1,
  consolidated_ids uuid[] DEFAULT '{}'
);

-- Indexes for efficient processing
CREATE INDEX idx_notification_queue_pending ON public.notification_queue(scheduled_for, priority DESC)
  WHERE status = 'pending';
CREATE INDEX idx_notification_queue_user ON public.notification_queue(user_id, notification_type, created_at DESC);
CREATE INDEX idx_notification_queue_consolidation ON public.notification_queue(user_id, consolidation_key, status)
  WHERE status = 'pending';

COMMENT ON TABLE public.notification_queue IS 'Queue for batch notification processing with consolidation';

-- ============================================================================
-- check_quiet_hours - Checks if user is in quiet hours
-- ============================================================================

/**
 * check_quiet_hours - Checks if user has quiet hours enabled and is within them
 *
 * @param p_user_id - The user's ID
 *
 * @returns boolean - true if in quiet hours
 */
CREATE OR REPLACE FUNCTION public.check_quiet_hours(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefs jsonb;
  v_enabled boolean;
  v_start time;
  v_end time;
  v_now time;
BEGIN
  SELECT notification_preferences INTO v_prefs
  FROM profiles
  WHERE id = p_user_id;

  v_enabled := COALESCE((v_prefs->>'quiet_hours_enabled')::boolean, false);

  IF NOT v_enabled THEN
    RETURN false;
  END IF;

  v_start := COALESCE(v_prefs->>'quiet_hours_start', '22:00')::time;
  v_end := COALESCE(v_prefs->>'quiet_hours_end', '08:00')::time;
  v_now := LOCALTIME;

  -- Handle time range spanning midnight
  IF v_start > v_end THEN
    -- e.g., 22:00 to 08:00
    RETURN v_now >= v_start OR v_now < v_end;
  ELSE
    -- e.g., 01:00 to 06:00
    RETURN v_now >= v_start AND v_now < v_end;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_quiet_hours(uuid) TO service_role;

COMMENT ON FUNCTION public.check_quiet_hours IS 'Checks if user is currently in quiet hours';

-- ============================================================================
-- get_quiet_hours_end - Gets when quiet hours end for a user
-- ============================================================================

/**
 * get_quiet_hours_end - Returns timestamp when quiet hours end
 *
 * @param p_user_id - The user's ID
 *
 * @returns timestamptz - When quiet hours end
 */
CREATE OR REPLACE FUNCTION public.get_quiet_hours_end(p_user_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefs jsonb;
  v_end time;
  v_end_timestamp timestamptz;
BEGIN
  SELECT notification_preferences INTO v_prefs
  FROM profiles
  WHERE id = p_user_id;

  v_end := COALESCE(v_prefs->>'quiet_hours_end', '08:00')::time;

  -- Calculate next occurrence of end time
  v_end_timestamp := CURRENT_DATE + v_end;

  -- If end time has passed today, it's tomorrow
  IF v_end_timestamp <= NOW() THEN
    v_end_timestamp := v_end_timestamp + INTERVAL '1 day';
  END IF;

  RETURN v_end_timestamp;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_quiet_hours_end(uuid) TO service_role;

-- ============================================================================
-- queue_notification - Adds notification to queue
-- ============================================================================

/**
 * queue_notification - Queues a notification for processing
 *
 * Features:
 * - Applies priority configuration
 * - Sets consolidation key
 * - Respects rate limits
 *
 * @param p_user_id - The user's ID
 * @param p_type - Notification type
 * @param p_title - Notification title
 * @param p_payload - Notification data
 * @param p_priority - Override priority (optional)
 * @param p_consolidation_key - Custom consolidation key (optional)
 *
 * @returns JSONB with queue result
 */
CREATE OR REPLACE FUNCTION public.queue_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_payload jsonb DEFAULT '{}',
  p_priority integer DEFAULT NULL,
  p_consolidation_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config record;
  v_priority integer;
  v_consolidation_key text;
  v_scheduled_for timestamptz := NOW();
  v_hour_count integer;
  v_queue_id uuid;
BEGIN
  -- Get priority configuration
  SELECT * INTO v_config
  FROM notification_priority_config
  WHERE notification_type = p_type;

  -- Set priority
  v_priority := COALESCE(p_priority, v_config.base_priority, 5);

  -- Set consolidation key
  v_consolidation_key := COALESCE(
    p_consolidation_key,
    p_type || ':' || p_user_id::text || ':' || to_char(NOW(), 'YYYY-MM-DD-HH24')
  );

  -- Check rate limit
  IF v_config.max_per_hour IS NOT NULL THEN
    SELECT COUNT(*) INTO v_hour_count
    FROM notification_queue
    WHERE user_id = p_user_id
      AND notification_type = p_type
      AND created_at > NOW() - INTERVAL '1 hour'
      AND status IN ('pending', 'sent');

    IF v_hour_count >= v_config.max_per_hour THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'RATE_LIMITED',
        'message', 'Maximum notifications per hour exceeded'
      );
    END IF;
  END IF;

  -- Check quiet hours (unless bypassed)
  IF NOT COALESCE(v_config.bypass_quiet_hours, false) THEN
    IF check_quiet_hours(p_user_id) THEN
      v_scheduled_for := get_quiet_hours_end(p_user_id);
    END IF;
  END IF;

  -- Insert into queue
  INSERT INTO notification_queue (
    user_id, notification_type, consolidation_key,
    title, body, payload, priority, scheduled_for
  ) VALUES (
    p_user_id, p_type, v_consolidation_key,
    p_title, p_payload->>'body', p_payload, v_priority, v_scheduled_for
  )
  RETURNING id INTO v_queue_id;

  RETURN jsonb_build_object(
    'success', true,
    'queueId', v_queue_id,
    'scheduledFor', v_scheduled_for,
    'priority', v_priority,
    'willConsolidate', NOT COALESCE(v_config.bypass_consolidation, false)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_notification(uuid, text, text, jsonb, integer, text) TO service_role;

COMMENT ON FUNCTION public.queue_notification IS 'Queues notification with priority and consolidation';

-- ============================================================================
-- process_notification_queue - Processes pending notifications
-- ============================================================================

/**
 * process_notification_queue - Processes and consolidates pending notifications
 *
 * Should be called by a cron job every 1-5 minutes.
 *
 * Features:
 * - Consolidates similar notifications
 * - Respects quiet hours
 * - Creates final notifications in notifications table
 *
 * @param p_batch_size - Max notifications to process
 *
 * @returns JSONB with processing stats
 */
CREATE OR REPLACE FUNCTION public.process_notification_queue(p_batch_size integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed integer := 0;
  v_consolidated integer := 0;
  v_sent integer := 0;
  v_skipped integer := 0;
  v_group record;
  v_config record;
  v_notification_id uuid;
  v_consolidated_title text;
  v_consolidated_body text;
BEGIN
  -- Process notifications grouped by consolidation key
  FOR v_group IN
    SELECT
      user_id,
      consolidation_key,
      notification_type,
      array_agg(id ORDER BY created_at) AS queue_ids,
      array_agg(title ORDER BY created_at) AS titles,
      array_agg(payload ORDER BY created_at) AS payloads,
      COUNT(*) AS count,
      MAX(priority) AS max_priority,
      MIN(scheduled_for) AS first_scheduled
    FROM notification_queue
    WHERE status = 'pending'
      AND scheduled_for <= NOW()
    GROUP BY user_id, consolidation_key, notification_type
    ORDER BY MAX(priority) DESC, MIN(scheduled_for)
    LIMIT p_batch_size
  LOOP
    v_processed := v_processed + v_group.count;

    -- Get config for this type
    SELECT * INTO v_config
    FROM notification_priority_config
    WHERE notification_type = v_group.notification_type;

    -- Recheck quiet hours (might have changed)
    IF NOT COALESCE(v_config.bypass_quiet_hours, false) AND check_quiet_hours(v_group.user_id) THEN
      -- Reschedule for after quiet hours
      UPDATE notification_queue
      SET scheduled_for = get_quiet_hours_end(v_group.user_id)
      WHERE id = ANY(v_group.queue_ids);

      v_skipped := v_skipped + v_group.count;
      CONTINUE;
    END IF;

    -- Consolidate if multiple and allowed
    IF v_group.count > 1 AND NOT COALESCE(v_config.bypass_consolidation, false) THEN
      -- Create consolidated notification
      v_consolidated_title := CASE v_group.notification_type
        WHEN 'new_listing' THEN v_group.count || ' new listings nearby'
        WHEN 'message' THEN v_group.count || ' new messages'
        WHEN 'match_found' THEN v_group.count || ' new matches'
        ELSE v_group.count || ' new notifications'
      END;

      v_consolidated_body := 'Tap to view all';

      INSERT INTO notifications (
        profile_id,
        notification_title,
        notification_text,
        parameter_data,
        initial_page_name,
        status
      ) VALUES (
        v_group.user_id,
        v_consolidated_title,
        v_consolidated_body,
        jsonb_build_object(
          'type', 'consolidated',
          'originalType', v_group.notification_type,
          'count', v_group.count,
          'items', v_group.payloads
        ),
        CASE v_group.notification_type
          WHEN 'message' THEN 'Messages'
          WHEN 'new_listing' THEN 'Browse'
          ELSE 'Notifications'
        END,
        'pending'
      )
      RETURNING id INTO v_notification_id;

      -- Mark queue items as consolidated
      UPDATE notification_queue
      SET status = 'consolidated',
          processed_at = NOW(),
          consolidated_count = v_group.count
      WHERE id = ANY(v_group.queue_ids);

      v_consolidated := v_consolidated + 1;
      v_sent := v_sent + 1;
    ELSE
      -- Send individual notification(s)
      FOR i IN 1..array_length(v_group.queue_ids, 1) LOOP
        INSERT INTO notifications (
          profile_id,
          notification_title,
          notification_text,
          parameter_data,
          initial_page_name,
          status
        ) VALUES (
          v_group.user_id,
          v_group.titles[i],
          (v_group.payloads[i])->>'body',
          v_group.payloads[i],
          COALESCE((v_group.payloads[i])->>'screen', 'Notifications'),
          'pending'
        );

        -- Mark as sent
        UPDATE notification_queue
        SET status = 'sent',
            processed_at = NOW()
        WHERE id = v_group.queue_ids[i];

        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'stats', jsonb_build_object(
      'processed', v_processed,
      'consolidated', v_consolidated,
      'sent', v_sent,
      'skipped', v_skipped
    ),
    'meta', jsonb_build_object('timestamp', NOW())
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_notification_queue(integer) TO service_role;

COMMENT ON FUNCTION public.process_notification_queue IS 'Processes and consolidates queued notifications';

-- ============================================================================
-- cleanup_notification_queue - Removes old processed entries
-- ============================================================================

/**
 * cleanup_notification_queue - Cleans up old queue entries
 *
 * @param p_days_old - Delete entries older than this (default 7)
 *
 * @returns integer - Count of deleted entries
 */
CREATE OR REPLACE FUNCTION public.cleanup_notification_queue(p_days_old integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM notification_queue
  WHERE status IN ('sent', 'consolidated', 'dropped')
    AND processed_at < NOW() - (p_days_old || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_notification_queue(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_notification_queue IS 'Removes old processed notification queue entries';
