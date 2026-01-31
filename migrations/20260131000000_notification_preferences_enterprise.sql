-- ============================================================================
-- Notification Preferences Enterprise System
-- Category-based notification control with multi-channel support
-- ============================================================================

-- ============================================================================
-- notification_digest_queue - Queue for batched/digest notifications
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_digest_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  category text NOT NULL CHECK (category IN ('posts', 'forum', 'challenges', 'comments', 'chats', 'social', 'system', 'marketing')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  frequency text NOT NULL CHECK (frequency IN ('hourly', 'daily', 'weekly')),
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  sent_at timestamptz,
  error_message text
);

-- Indexes for efficient processing
CREATE INDEX IF NOT EXISTS idx_digest_queue_pending
  ON notification_digest_queue(scheduled_for, frequency)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_digest_queue_user
  ON notification_digest_queue(user_id, category, status);

CREATE INDEX IF NOT EXISTS idx_digest_queue_status_scheduled
  ON notification_digest_queue(status, scheduled_for);

COMMENT ON TABLE notification_digest_queue IS 'Queue for digest/batched notifications by frequency';

-- ============================================================================
-- notification_category_preferences - Per-category notification settings
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_category_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('posts', 'forum', 'challenges', 'comments', 'chats', 'social', 'system', 'marketing')),

  -- Channel enablement
  push_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,

  -- Frequency settings per channel
  push_frequency text NOT NULL DEFAULT 'instant' CHECK (push_frequency IN ('instant', 'hourly', 'daily', 'weekly', 'never')),
  email_frequency text NOT NULL DEFAULT 'daily' CHECK (email_frequency IN ('instant', 'hourly', 'daily', 'weekly', 'never')),
  sms_frequency text NOT NULL DEFAULT 'never' CHECK (sms_frequency IN ('instant', 'hourly', 'daily', 'weekly', 'never')),

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  UNIQUE(user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_category_prefs_user ON notification_category_preferences(user_id);

COMMENT ON TABLE notification_category_preferences IS 'Per-category notification preferences with channel and frequency control';

-- ============================================================================
-- notification_global_settings - User-level global notification settings
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notification_global_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,

  -- Master channel switches
  push_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,

  -- Quiet hours
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start time DEFAULT '22:00',
  quiet_hours_end time DEFAULT '08:00',
  timezone text DEFAULT 'UTC',

  -- Do Not Disturb
  dnd_enabled boolean NOT NULL DEFAULT false,
  dnd_until timestamptz,

  -- Digest settings
  daily_digest_enabled boolean NOT NULL DEFAULT true,
  daily_digest_time time DEFAULT '09:00',
  weekly_digest_enabled boolean NOT NULL DEFAULT true,
  weekly_digest_day integer DEFAULT 1, -- Monday

  -- Phone for SMS
  phone_number text,
  phone_verified boolean NOT NULL DEFAULT false,
  phone_verified_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE notification_global_settings IS 'Global notification settings per user (quiet hours, DND, digest times)';

-- ============================================================================
-- RLS Policies
-- ============================================================================

ALTER TABLE notification_digest_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_category_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_global_settings ENABLE ROW LEVEL SECURITY;

-- notification_digest_queue policies
CREATE POLICY "Users can view own digest queue" ON notification_digest_queue
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to digest queue" ON notification_digest_queue
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- notification_category_preferences policies
CREATE POLICY "Users can view own category preferences" ON notification_category_preferences
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own category preferences" ON notification_category_preferences
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own category preferences" ON notification_category_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to category preferences" ON notification_category_preferences
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- notification_global_settings policies
CREATE POLICY "Users can view own global settings" ON notification_global_settings
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own global settings" ON notification_global_settings
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own global settings" ON notification_global_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to global settings" ON notification_global_settings
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- ============================================================================
-- should_send_notification - Check if notification should be sent
-- ============================================================================

/**
 * should_send_notification - Comprehensive preference check for notifications
 *
 * Checks:
 * 1. Global channel enablement
 * 2. Category-specific enablement
 * 3. Frequency (instant vs digest)
 * 4. Quiet hours
 * 5. Do Not Disturb mode
 *
 * @param p_user_id - User to check
 * @param p_category - Notification category
 * @param p_channel - Delivery channel (push/email/sms)
 *
 * @returns jsonb with send decision and scheduling info
 */
CREATE OR REPLACE FUNCTION public.should_send_notification(
  p_user_id uuid,
  p_category text,
  p_channel text DEFAULT 'push'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_global notification_global_settings%ROWTYPE;
  v_cat_pref notification_category_preferences%ROWTYPE;
  v_channel_enabled boolean;
  v_frequency text;
  v_in_quiet_hours boolean := false;
  v_resume_at timestamptz;
  v_now timestamp with time zone := NOW();
  v_user_time time;
BEGIN
  -- Get global settings (or defaults)
  SELECT * INTO v_global
  FROM notification_global_settings
  WHERE user_id = p_user_id;

  -- Check DND first (blocks everything except system)
  IF v_global.dnd_enabled AND p_category != 'system' THEN
    IF v_global.dnd_until IS NULL OR v_global.dnd_until > v_now THEN
      RETURN jsonb_build_object(
        'send', false,
        'reason', 'dnd_enabled',
        'resume_at', v_global.dnd_until
      );
    END IF;
  END IF;

  -- Check global channel switch
  CASE p_channel
    WHEN 'push' THEN v_channel_enabled := COALESCE(v_global.push_enabled, true);
    WHEN 'email' THEN v_channel_enabled := COALESCE(v_global.email_enabled, true);
    WHEN 'sms' THEN v_channel_enabled := COALESCE(v_global.sms_enabled, false);
    ELSE v_channel_enabled := true;
  END CASE;

  IF NOT v_channel_enabled THEN
    RETURN jsonb_build_object(
      'send', false,
      'reason', 'channel_disabled_globally'
    );
  END IF;

  -- Get category preferences (or defaults)
  SELECT * INTO v_cat_pref
  FROM notification_category_preferences
  WHERE user_id = p_user_id AND category = p_category;

  -- Check category channel enablement
  IF v_cat_pref IS NOT NULL THEN
    CASE p_channel
      WHEN 'push' THEN
        v_channel_enabled := v_cat_pref.push_enabled;
        v_frequency := v_cat_pref.push_frequency;
      WHEN 'email' THEN
        v_channel_enabled := v_cat_pref.email_enabled;
        v_frequency := v_cat_pref.email_frequency;
      WHEN 'sms' THEN
        v_channel_enabled := v_cat_pref.sms_enabled;
        v_frequency := v_cat_pref.sms_frequency;
    END CASE;
  ELSE
    -- Use defaults based on category
    v_frequency := CASE
      WHEN p_channel = 'email' THEN 'daily'
      WHEN p_channel = 'sms' THEN 'never'
      ELSE 'instant'
    END;
    v_channel_enabled := CASE
      WHEN p_channel = 'sms' THEN false
      WHEN p_category = 'marketing' THEN false
      ELSE true
    END;
  END IF;

  IF NOT v_channel_enabled THEN
    RETURN jsonb_build_object(
      'send', false,
      'reason', 'category_channel_disabled'
    );
  END IF;

  -- Check frequency
  IF v_frequency = 'never' THEN
    RETURN jsonb_build_object(
      'send', false,
      'reason', 'frequency_never'
    );
  END IF;

  -- Check quiet hours (except for system and critical)
  IF COALESCE(v_global.quiet_hours_enabled, false) AND p_category NOT IN ('system') THEN
    -- Convert current time to user timezone
    v_user_time := (v_now AT TIME ZONE COALESCE(v_global.timezone, 'UTC'))::time;

    -- Check if in quiet hours
    IF v_global.quiet_hours_start > v_global.quiet_hours_end THEN
      -- Spans midnight (e.g., 22:00 to 08:00)
      v_in_quiet_hours := v_user_time >= v_global.quiet_hours_start OR v_user_time < v_global.quiet_hours_end;
    ELSE
      -- Same day (e.g., 01:00 to 06:00)
      v_in_quiet_hours := v_user_time >= v_global.quiet_hours_start AND v_user_time < v_global.quiet_hours_end;
    END IF;

    IF v_in_quiet_hours THEN
      -- Calculate resume time
      IF v_global.quiet_hours_start > v_global.quiet_hours_end THEN
        -- If start > end, quiet hours end is today or tomorrow
        IF v_user_time >= v_global.quiet_hours_end THEN
          -- End time is tomorrow
          v_resume_at := (CURRENT_DATE + INTERVAL '1 day' + v_global.quiet_hours_end) AT TIME ZONE COALESCE(v_global.timezone, 'UTC');
        ELSE
          -- End time is today
          v_resume_at := (CURRENT_DATE + v_global.quiet_hours_end) AT TIME ZONE COALESCE(v_global.timezone, 'UTC');
        END IF;
      ELSE
        v_resume_at := (CURRENT_DATE + v_global.quiet_hours_end) AT TIME ZONE COALESCE(v_global.timezone, 'UTC');
      END IF;

      RETURN jsonb_build_object(
        'send', false,
        'reason', 'quiet_hours',
        'schedule_for', v_resume_at,
        'frequency', v_frequency
      );
    END IF;
  END IF;

  -- If frequency is not instant, return schedule info
  IF v_frequency != 'instant' THEN
    RETURN jsonb_build_object(
      'send', true,
      'frequency', v_frequency,
      'reason', 'digest_frequency'
    );
  END IF;

  -- Send immediately
  RETURN jsonb_build_object(
    'send', true,
    'frequency', 'instant'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.should_send_notification(uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.should_send_notification IS 'Checks all notification preferences for a user/category/channel combination';

-- ============================================================================
-- get_notification_preferences - Get all preferences for a user
-- ============================================================================

/**
 * get_notification_preferences - Returns all notification preferences for settings UI
 *
 * @param p_user_id - User ID
 *
 * @returns jsonb with settings and category preferences
 */
CREATE OR REPLACE FUNCTION public.get_notification_preferences(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_global notification_global_settings%ROWTYPE;
  v_preferences jsonb := '{}';
BEGIN
  -- Get or create default global settings
  SELECT * INTO v_global
  FROM notification_global_settings
  WHERE user_id = p_user_id;

  -- Get category preferences
  SELECT COALESCE(
    jsonb_object_agg(
      category,
      jsonb_build_object(
        'push', jsonb_build_object('enabled', push_enabled, 'frequency', push_frequency),
        'email', jsonb_build_object('enabled', email_enabled, 'frequency', email_frequency),
        'sms', jsonb_build_object('enabled', sms_enabled, 'frequency', sms_frequency)
      )
    ),
    '{}'::jsonb
  ) INTO v_preferences
  FROM notification_category_preferences
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'settings', CASE WHEN v_global IS NULL THEN NULL ELSE jsonb_build_object(
      'push_enabled', v_global.push_enabled,
      'email_enabled', v_global.email_enabled,
      'sms_enabled', v_global.sms_enabled,
      'quiet_hours', jsonb_build_object(
        'enabled', v_global.quiet_hours_enabled,
        'start', v_global.quiet_hours_start,
        'end', v_global.quiet_hours_end,
        'timezone', v_global.timezone
      ),
      'dnd', jsonb_build_object(
        'enabled', v_global.dnd_enabled,
        'until', v_global.dnd_until
      ),
      'digest', jsonb_build_object(
        'daily_enabled', v_global.daily_digest_enabled,
        'daily_time', v_global.daily_digest_time,
        'weekly_enabled', v_global.weekly_digest_enabled,
        'weekly_day', v_global.weekly_digest_day
      ),
      'phone', jsonb_build_object(
        'number', v_global.phone_number,
        'verified', v_global.phone_verified
      )
    ) END,
    'preferences', v_preferences
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_notification_preferences(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_notification_preferences IS 'Returns all notification preferences for settings UI';

-- ============================================================================
-- update_notification_settings - Update global notification settings
-- ============================================================================

/**
 * update_notification_settings - Updates global notification settings
 *
 * @param p_user_id - User ID
 * @param p_settings - Settings to update (partial update supported)
 *
 * @returns jsonb with updated settings
 */
CREATE OR REPLACE FUNCTION public.update_notification_settings(
  p_user_id uuid,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result notification_global_settings%ROWTYPE;
BEGIN
  INSERT INTO notification_global_settings (
    user_id,
    push_enabled,
    email_enabled,
    sms_enabled,
    quiet_hours_enabled,
    quiet_hours_start,
    quiet_hours_end,
    timezone,
    dnd_enabled,
    dnd_until,
    daily_digest_enabled,
    daily_digest_time,
    weekly_digest_enabled,
    weekly_digest_day,
    phone_number
  ) VALUES (
    p_user_id,
    COALESCE((p_settings->>'push_enabled')::boolean, true),
    COALESCE((p_settings->>'email_enabled')::boolean, true),
    COALESCE((p_settings->>'sms_enabled')::boolean, false),
    COALESCE((p_settings->'quiet_hours'->>'enabled')::boolean, false),
    COALESCE((p_settings->'quiet_hours'->>'start')::time, '22:00'::time),
    COALESCE((p_settings->'quiet_hours'->>'end')::time, '08:00'::time),
    COALESCE(p_settings->'quiet_hours'->>'timezone', 'UTC'),
    COALESCE((p_settings->'dnd'->>'enabled')::boolean, false),
    (p_settings->'dnd'->>'until')::timestamptz,
    COALESCE((p_settings->'digest'->>'daily_enabled')::boolean, true),
    COALESCE((p_settings->'digest'->>'daily_time')::time, '09:00'::time),
    COALESCE((p_settings->'digest'->>'weekly_enabled')::boolean, true),
    COALESCE((p_settings->'digest'->>'weekly_day')::integer, 1),
    p_settings->>'phone_number'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    push_enabled = COALESCE((p_settings->>'push_enabled')::boolean, notification_global_settings.push_enabled),
    email_enabled = COALESCE((p_settings->>'email_enabled')::boolean, notification_global_settings.email_enabled),
    sms_enabled = COALESCE((p_settings->>'sms_enabled')::boolean, notification_global_settings.sms_enabled),
    quiet_hours_enabled = COALESCE((p_settings->'quiet_hours'->>'enabled')::boolean, notification_global_settings.quiet_hours_enabled),
    quiet_hours_start = COALESCE((p_settings->'quiet_hours'->>'start')::time, notification_global_settings.quiet_hours_start),
    quiet_hours_end = COALESCE((p_settings->'quiet_hours'->>'end')::time, notification_global_settings.quiet_hours_end),
    timezone = COALESCE(p_settings->'quiet_hours'->>'timezone', notification_global_settings.timezone),
    dnd_enabled = COALESCE((p_settings->'dnd'->>'enabled')::boolean, notification_global_settings.dnd_enabled),
    dnd_until = CASE
      WHEN p_settings->'dnd' ? 'until' THEN (p_settings->'dnd'->>'until')::timestamptz
      ELSE notification_global_settings.dnd_until
    END,
    daily_digest_enabled = COALESCE((p_settings->'digest'->>'daily_enabled')::boolean, notification_global_settings.daily_digest_enabled),
    daily_digest_time = COALESCE((p_settings->'digest'->>'daily_time')::time, notification_global_settings.daily_digest_time),
    weekly_digest_enabled = COALESCE((p_settings->'digest'->>'weekly_enabled')::boolean, notification_global_settings.weekly_digest_enabled),
    weekly_digest_day = COALESCE((p_settings->'digest'->>'weekly_day')::integer, notification_global_settings.weekly_digest_day),
    phone_number = COALESCE(p_settings->>'phone_number', notification_global_settings.phone_number),
    updated_at = NOW()
  RETURNING * INTO v_result;

  RETURN jsonb_build_object(
    'success', true,
    'settings', row_to_json(v_result)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_notification_settings(uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.update_notification_settings IS 'Updates global notification settings';

-- ============================================================================
-- update_notification_preference - Update single category preference
-- ============================================================================

/**
 * update_notification_preference - Updates a single category/channel preference
 *
 * @param p_user_id - User ID
 * @param p_category - Notification category
 * @param p_channel - Channel (push/email/sms)
 * @param p_enabled - Enable/disable (optional)
 * @param p_frequency - Frequency setting (optional)
 *
 * @returns jsonb with result
 */
CREATE OR REPLACE FUNCTION public.update_notification_preference(
  p_user_id uuid,
  p_category text,
  p_channel text,
  p_enabled boolean DEFAULT NULL,
  p_frequency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result notification_category_preferences%ROWTYPE;
BEGIN
  -- Validate inputs
  IF p_category NOT IN ('posts', 'forum', 'challenges', 'comments', 'chats', 'social', 'system', 'marketing') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid category');
  END IF;

  IF p_channel NOT IN ('push', 'email', 'sms') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid channel');
  END IF;

  IF p_frequency IS NOT NULL AND p_frequency NOT IN ('instant', 'hourly', 'daily', 'weekly', 'never') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid frequency');
  END IF;

  -- Upsert preference
  INSERT INTO notification_category_preferences (user_id, category)
  VALUES (p_user_id, p_category)
  ON CONFLICT (user_id, category) DO NOTHING;

  -- Update specific channel
  CASE p_channel
    WHEN 'push' THEN
      UPDATE notification_category_preferences
      SET
        push_enabled = COALESCE(p_enabled, push_enabled),
        push_frequency = COALESCE(p_frequency, push_frequency),
        updated_at = NOW()
      WHERE user_id = p_user_id AND category = p_category
      RETURNING * INTO v_result;
    WHEN 'email' THEN
      UPDATE notification_category_preferences
      SET
        email_enabled = COALESCE(p_enabled, email_enabled),
        email_frequency = COALESCE(p_frequency, email_frequency),
        updated_at = NOW()
      WHERE user_id = p_user_id AND category = p_category
      RETURNING * INTO v_result;
    WHEN 'sms' THEN
      UPDATE notification_category_preferences
      SET
        sms_enabled = COALESCE(p_enabled, sms_enabled),
        sms_frequency = COALESCE(p_frequency, sms_frequency),
        updated_at = NOW()
      WHERE user_id = p_user_id AND category = p_category
      RETURNING * INTO v_result;
  END CASE;

  RETURN jsonb_build_object(
    'success', true,
    'preference', row_to_json(v_result)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_notification_preference(uuid, text, text, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.update_notification_preference IS 'Updates a single category/channel notification preference';

-- ============================================================================
-- get_pending_digest_notifications - Get digest items ready for delivery
-- ============================================================================

/**
 * get_pending_digest_notifications - Fetches pending digest notifications
 *
 * @param p_frequency - Frequency filter (hourly/daily/weekly)
 * @param p_limit - Max items to return
 *
 * @returns Table of pending notifications grouped by user
 */
CREATE OR REPLACE FUNCTION public.get_pending_digest_notifications(
  p_frequency text,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  user_id uuid,
  items jsonb,
  item_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dq.user_id,
    jsonb_agg(
      jsonb_build_object(
        'id', dq.id,
        'type', dq.notification_type,
        'category', dq.category,
        'title', dq.title,
        'body', dq.body,
        'data', dq.data,
        'created_at', dq.created_at
      ) ORDER BY dq.created_at DESC
    ) AS items,
    COUNT(*)::integer AS item_count
  FROM notification_digest_queue dq
  WHERE dq.status = 'pending'
    AND dq.frequency = p_frequency
    AND dq.scheduled_for <= NOW()
  GROUP BY dq.user_id
  ORDER BY COUNT(*) DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_pending_digest_notifications(text, integer) TO service_role;

COMMENT ON FUNCTION public.get_pending_digest_notifications IS 'Fetches pending digest notifications grouped by user';

-- ============================================================================
-- mark_digest_notifications_sent - Mark digest items as sent
-- ============================================================================

/**
 * mark_digest_notifications_sent - Marks digest notifications as sent
 *
 * @param p_notification_ids - Array of notification IDs to mark
 *
 * @returns integer count of updated items
 */
CREATE OR REPLACE FUNCTION public.mark_digest_notifications_sent(p_notification_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE notification_digest_queue
  SET status = 'sent',
      sent_at = NOW()
  WHERE id = ANY(p_notification_ids)
    AND status = 'pending';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_digest_notifications_sent(uuid[]) TO service_role;

COMMENT ON FUNCTION public.mark_digest_notifications_sent IS 'Marks digest notifications as sent after delivery';

-- ============================================================================
-- cleanup_old_digest_queue - Remove old processed entries
-- ============================================================================

/**
 * cleanup_old_digest_queue - Removes old digest queue entries
 *
 * @param p_days_old - Days to retain (default 7)
 *
 * @returns integer count of deleted items
 */
CREATE OR REPLACE FUNCTION public.cleanup_old_digest_queue(p_days_old integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM notification_digest_queue
  WHERE status IN ('sent', 'cancelled', 'failed')
    AND sent_at < NOW() - (p_days_old || ' days')::interval;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_old_digest_queue(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_old_digest_queue IS 'Removes old processed digest queue entries';

-- ============================================================================
-- Cron job setup for digest processing
-- Note: pg_cron extension required - configure in Supabase dashboard
-- ============================================================================

-- These should be set up via Supabase dashboard or config.toml:
--
-- Hourly digest: cron.schedule('notification-digest-hourly', '0 * * * *', $$
--   SELECT net.http_post(
--     url := current_setting('app.supabase_url') || '/functions/v1/send-digest-notifications',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
--     body := '{"frequency": "hourly"}'
--   );
-- $$);
--
-- Daily digest: cron.schedule('notification-digest-daily', '0 9 * * *', $$
--   SELECT net.http_post(
--     url := current_setting('app.supabase_url') || '/functions/v1/send-digest-notifications',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
--     body := '{"frequency": "daily"}'
--   );
-- $$);
--
-- Weekly digest: cron.schedule('notification-digest-weekly', '0 9 * * 1', $$
--   SELECT net.http_post(
--     url := current_setting('app.supabase_url') || '/functions/v1/send-digest-notifications',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
--     body := '{"frequency": "weekly"}'
--   );
-- $$);
--
-- Cleanup: cron.schedule('notification-digest-cleanup', '0 3 * * 0', $$
--   SELECT cleanup_old_digest_queue(7);
-- $$);
