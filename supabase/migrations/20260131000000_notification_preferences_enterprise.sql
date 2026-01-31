-- =============================================================================
-- Enterprise Notification Preferences System
-- =============================================================================
-- Granular per-type, per-channel notification control
-- Supports: Push, Email, SMS channels
-- Features: Posts, Forum, Challenges, Comments, Chats, System

-- =============================================================================
-- 1. NOTIFICATION TYPES ENUM
-- =============================================================================

CREATE TYPE notification_category AS ENUM (
  'posts',        -- New listings, post updates
  'forum',        -- Forum posts, replies
  'challenges',   -- Challenge invites, completions, reminders
  'comments',     -- Comments on your posts
  'chats',        -- Direct messages, chat room messages
  'social',       -- Follows, likes, shares
  'system',       -- Account, security, billing
  'marketing'     -- Promotions, newsletters
);

CREATE TYPE notification_channel AS ENUM (
  'push',
  'email',
  'sms'
);

-- =============================================================================
-- 2. NOTIFICATION PREFERENCES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Category + Channel combination
  category notification_category NOT NULL,
  channel notification_channel NOT NULL,

  -- Control
  enabled boolean NOT NULL DEFAULT true,

  -- Frequency control
  frequency text NOT NULL DEFAULT 'instant'
    CHECK (frequency IN ('instant', 'hourly', 'daily', 'weekly', 'never')),

  -- Quiet hours override (null = use global)
  quiet_hours_enabled boolean,
  quiet_hours_start time,
  quiet_hours_end time,

  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One preference per user/category/channel
  UNIQUE(user_id, category, channel)
);

-- Enable RLS
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- Users can manage their own preferences
CREATE POLICY "Users can read own notification preferences"
  ON public.notification_preferences FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notification preferences"
  ON public.notification_preferences FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification preferences"
  ON public.notification_preferences FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.notification_preferences FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX idx_notification_prefs_user ON public.notification_preferences(user_id);
CREATE INDEX idx_notification_prefs_user_category ON public.notification_preferences(user_id, category);

-- =============================================================================
-- 3. GLOBAL USER NOTIFICATION SETTINGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Master switches
  push_enabled boolean NOT NULL DEFAULT true,
  email_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,

  -- Phone for SMS (E.164 format)
  phone_number text,
  phone_verified boolean NOT NULL DEFAULT false,

  -- Global quiet hours
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start time NOT NULL DEFAULT '22:00',
  quiet_hours_end time NOT NULL DEFAULT '08:00',

  -- Timezone for quiet hours
  timezone text NOT NULL DEFAULT 'UTC',

  -- Digest preferences
  daily_digest_enabled boolean NOT NULL DEFAULT false,
  daily_digest_time time NOT NULL DEFAULT '09:00',
  weekly_digest_enabled boolean NOT NULL DEFAULT false,
  weekly_digest_day int NOT NULL DEFAULT 1, -- 0=Sunday, 1=Monday

  -- Do not disturb
  dnd_enabled boolean NOT NULL DEFAULT false,
  dnd_until timestamptz,

  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification settings"
  ON public.notification_settings FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own notification settings"
  ON public.notification_settings FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to settings"
  ON public.notification_settings FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- 4. DEFAULT PREFERENCES INITIALIZATION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.init_notification_preferences(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create global settings if not exists
  INSERT INTO notification_settings (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Create default preferences for each category/channel
  INSERT INTO notification_preferences (user_id, category, channel, enabled, frequency)
  VALUES
    -- Posts
    (p_user_id, 'posts', 'push', true, 'instant'),
    (p_user_id, 'posts', 'email', true, 'daily'),
    (p_user_id, 'posts', 'sms', false, 'never'),
    -- Forum
    (p_user_id, 'forum', 'push', true, 'instant'),
    (p_user_id, 'forum', 'email', true, 'daily'),
    (p_user_id, 'forum', 'sms', false, 'never'),
    -- Challenges
    (p_user_id, 'challenges', 'push', true, 'instant'),
    (p_user_id, 'challenges', 'email', true, 'instant'),
    (p_user_id, 'challenges', 'sms', false, 'never'),
    -- Comments
    (p_user_id, 'comments', 'push', true, 'instant'),
    (p_user_id, 'comments', 'email', true, 'hourly'),
    (p_user_id, 'comments', 'sms', false, 'never'),
    -- Chats
    (p_user_id, 'chats', 'push', true, 'instant'),
    (p_user_id, 'chats', 'email', false, 'never'),
    (p_user_id, 'chats', 'sms', false, 'never'),
    -- Social
    (p_user_id, 'social', 'push', true, 'instant'),
    (p_user_id, 'social', 'email', true, 'daily'),
    (p_user_id, 'social', 'sms', false, 'never'),
    -- System
    (p_user_id, 'system', 'push', true, 'instant'),
    (p_user_id, 'system', 'email', true, 'instant'),
    (p_user_id, 'system', 'sms', false, 'never'),
    -- Marketing
    (p_user_id, 'marketing', 'push', false, 'never'),
    (p_user_id, 'marketing', 'email', false, 'weekly'),
    (p_user_id, 'marketing', 'sms', false, 'never')
  ON CONFLICT (user_id, category, channel) DO NOTHING;
END;
$$;

-- =============================================================================
-- 5. CHECK IF NOTIFICATION SHOULD BE SENT
-- =============================================================================

CREATE OR REPLACE FUNCTION public.should_send_notification(
  p_user_id uuid,
  p_category text,
  p_channel text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings notification_settings%ROWTYPE;
  v_pref notification_preferences%ROWTYPE;
  v_result jsonb;
  v_now timestamptz := now();
  v_current_time time := v_now::time;
  v_in_quiet_hours boolean := false;
  v_quiet_end timestamptz;
BEGIN
  -- Get global settings
  SELECT * INTO v_settings
  FROM notification_settings
  WHERE user_id = p_user_id;

  -- If no settings, initialize defaults
  IF v_settings IS NULL THEN
    PERFORM init_notification_preferences(p_user_id);
    SELECT * INTO v_settings FROM notification_settings WHERE user_id = p_user_id;
  END IF;

  -- Check DND mode
  IF v_settings.dnd_enabled AND v_settings.dnd_until > v_now THEN
    RETURN jsonb_build_object(
      'send', false,
      'reason', 'dnd_active',
      'resume_at', v_settings.dnd_until
    );
  END IF;

  -- Check master channel switch
  IF p_channel = 'push' AND NOT v_settings.push_enabled THEN
    RETURN jsonb_build_object('send', false, 'reason', 'push_disabled');
  END IF;
  IF p_channel = 'email' AND NOT v_settings.email_enabled THEN
    RETURN jsonb_build_object('send', false, 'reason', 'email_disabled');
  END IF;
  IF p_channel = 'sms' AND NOT v_settings.sms_enabled THEN
    RETURN jsonb_build_object('send', false, 'reason', 'sms_disabled');
  END IF;

  -- Get category preference
  SELECT * INTO v_pref
  FROM notification_preferences
  WHERE user_id = p_user_id
    AND category = p_category::notification_category
    AND channel = p_channel::notification_channel;

  -- If no preference, allow by default (except marketing)
  IF v_pref IS NULL THEN
    IF p_category = 'marketing' THEN
      RETURN jsonb_build_object('send', false, 'reason', 'marketing_not_opted_in');
    END IF;
    RETURN jsonb_build_object('send', true, 'frequency', 'instant');
  END IF;

  -- Check if category is enabled
  IF NOT v_pref.enabled THEN
    RETURN jsonb_build_object('send', false, 'reason', 'category_disabled');
  END IF;

  -- Check frequency
  IF v_pref.frequency = 'never' THEN
    RETURN jsonb_build_object('send', false, 'reason', 'frequency_never');
  END IF;

  -- Check quiet hours (use preference override or global)
  DECLARE
    v_qh_enabled boolean := COALESCE(v_pref.quiet_hours_enabled, v_settings.quiet_hours_enabled);
    v_qh_start time := COALESCE(v_pref.quiet_hours_start, v_settings.quiet_hours_start);
    v_qh_end time := COALESCE(v_pref.quiet_hours_end, v_settings.quiet_hours_end);
  BEGIN
    IF v_qh_enabled THEN
      -- Handle overnight quiet hours (e.g., 22:00 - 08:00)
      IF v_qh_start > v_qh_end THEN
        v_in_quiet_hours := v_current_time >= v_qh_start OR v_current_time < v_qh_end;
      ELSE
        v_in_quiet_hours := v_current_time >= v_qh_start AND v_current_time < v_qh_end;
      END IF;

      IF v_in_quiet_hours AND p_category != 'system' THEN
        -- Calculate when quiet hours end
        IF v_qh_start > v_qh_end AND v_current_time >= v_qh_start THEN
          v_quiet_end := (v_now::date + 1 + v_qh_end)::timestamptz;
        ELSE
          v_quiet_end := (v_now::date + v_qh_end)::timestamptz;
        END IF;

        RETURN jsonb_build_object(
          'send', false,
          'reason', 'quiet_hours',
          'schedule_for', v_quiet_end,
          'frequency', v_pref.frequency
        );
      END IF;
    END IF;
  END;

  -- All checks passed
  RETURN jsonb_build_object(
    'send', true,
    'frequency', v_pref.frequency
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.should_send_notification TO service_role;
GRANT EXECUTE ON FUNCTION public.init_notification_preferences TO service_role;

-- =============================================================================
-- 6. GET USER NOTIFICATION PREFERENCES (for Settings Screen)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_notification_preferences(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
  v_preferences jsonb;
BEGIN
  -- Initialize if needed
  PERFORM init_notification_preferences(p_user_id);

  -- Get global settings
  SELECT jsonb_build_object(
    'push_enabled', push_enabled,
    'email_enabled', email_enabled,
    'sms_enabled', sms_enabled,
    'phone_number', phone_number,
    'phone_verified', phone_verified,
    'quiet_hours', jsonb_build_object(
      'enabled', quiet_hours_enabled,
      'start', quiet_hours_start,
      'end', quiet_hours_end,
      'timezone', timezone
    ),
    'digest', jsonb_build_object(
      'daily_enabled', daily_digest_enabled,
      'daily_time', daily_digest_time,
      'weekly_enabled', weekly_digest_enabled,
      'weekly_day', weekly_digest_day
    ),
    'dnd', jsonb_build_object(
      'enabled', dnd_enabled,
      'until', dnd_until
    )
  ) INTO v_settings
  FROM notification_settings
  WHERE user_id = p_user_id;

  -- Get category preferences grouped by category
  SELECT jsonb_object_agg(
    category::text,
    channels
  ) INTO v_preferences
  FROM (
    SELECT
      category,
      jsonb_object_agg(
        channel::text,
        jsonb_build_object(
          'enabled', enabled,
          'frequency', frequency
        )
      ) as channels
    FROM notification_preferences
    WHERE user_id = p_user_id
    GROUP BY category
  ) grouped;

  RETURN jsonb_build_object(
    'settings', v_settings,
    'preferences', COALESCE(v_preferences, '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_notification_preferences TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_preferences TO service_role;

-- =============================================================================
-- 7. UPDATE NOTIFICATION PREFERENCES
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_notification_preference(
  p_user_id uuid,
  p_category text,
  p_channel text,
  p_enabled boolean DEFAULT NULL,
  p_frequency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Initialize if needed
  PERFORM init_notification_preferences(p_user_id);

  -- Update preference
  UPDATE notification_preferences
  SET
    enabled = COALESCE(p_enabled, enabled),
    frequency = COALESCE(p_frequency, frequency),
    updated_at = now()
  WHERE user_id = p_user_id
    AND category = p_category::notification_category
    AND channel = p_channel::notification_channel;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'preference_not_found');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_notification_preference TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_notification_preference TO service_role;

-- =============================================================================
-- 8. UPDATE GLOBAL NOTIFICATION SETTINGS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_notification_settings(
  p_user_id uuid,
  p_settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Initialize if needed
  PERFORM init_notification_preferences(p_user_id);

  -- Update settings
  UPDATE notification_settings
  SET
    push_enabled = COALESCE((p_settings->>'push_enabled')::boolean, push_enabled),
    email_enabled = COALESCE((p_settings->>'email_enabled')::boolean, email_enabled),
    sms_enabled = COALESCE((p_settings->>'sms_enabled')::boolean, sms_enabled),
    phone_number = COALESCE(p_settings->>'phone_number', phone_number),
    quiet_hours_enabled = COALESCE((p_settings->'quiet_hours'->>'enabled')::boolean, quiet_hours_enabled),
    quiet_hours_start = COALESCE((p_settings->'quiet_hours'->>'start')::time, quiet_hours_start),
    quiet_hours_end = COALESCE((p_settings->'quiet_hours'->>'end')::time, quiet_hours_end),
    timezone = COALESCE(p_settings->'quiet_hours'->>'timezone', timezone),
    daily_digest_enabled = COALESCE((p_settings->'digest'->>'daily_enabled')::boolean, daily_digest_enabled),
    daily_digest_time = COALESCE((p_settings->'digest'->>'daily_time')::time, daily_digest_time),
    weekly_digest_enabled = COALESCE((p_settings->'digest'->>'weekly_enabled')::boolean, weekly_digest_enabled),
    weekly_digest_day = COALESCE((p_settings->'digest'->>'weekly_day')::int, weekly_digest_day),
    dnd_enabled = COALESCE((p_settings->'dnd'->>'enabled')::boolean, dnd_enabled),
    dnd_until = COALESCE((p_settings->'dnd'->>'until')::timestamptz, dnd_until),
    updated_at = now()
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_notification_settings TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_notification_settings TO service_role;

-- =============================================================================
-- 9. AUTO-INITIALIZE ON USER CREATION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM init_notification_preferences(NEW.id);
  RETURN NEW;
END;
$$;

-- Create trigger if not exists
DROP TRIGGER IF EXISTS on_auth_user_created_notifications ON auth.users;
CREATE TRIGGER on_auth_user_created_notifications
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user_notifications();

-- =============================================================================
-- 10. VERIFY SMS PHONE NUMBER
-- =============================================================================

CREATE OR REPLACE FUNCTION public.verify_phone_for_sms(
  p_user_id uuid,
  p_phone_number text,
  p_verification_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- TODO: Implement actual SMS verification via Twilio/etc
  -- For now, just update the phone number
  UPDATE notification_settings
  SET
    phone_number = p_phone_number,
    phone_verified = true,
    updated_at = now()
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object('success', true, 'phone_verified', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_phone_for_sms TO authenticated;

-- =============================================================================
-- 11. NOTIFICATION DIGEST QUEUE (for hourly/daily/weekly batching)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notification_digest_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Notification content
  notification_type text NOT NULL,
  category notification_category NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb DEFAULT '{}'::jsonb,

  -- Scheduling
  frequency text NOT NULL CHECK (frequency IN ('hourly', 'daily', 'weekly')),
  scheduled_for timestamptz NOT NULL,

  -- Status
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  sent_at timestamptz,
  error_message text,

  -- Metadata
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Index for efficient batch processing
  CONSTRAINT digest_queue_unique_pending UNIQUE (user_id, notification_type, category, frequency, status)
    DEFERRABLE INITIALLY DEFERRED
);

-- Enable RLS
ALTER TABLE public.notification_digest_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to digest queue"
  ON public.notification_digest_queue FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Indexes for batch processing
CREATE INDEX idx_digest_queue_pending ON public.notification_digest_queue(scheduled_for, status)
  WHERE status = 'pending';
CREATE INDEX idx_digest_queue_user ON public.notification_digest_queue(user_id, status);

-- =============================================================================
-- 12. PROCESS DIGEST QUEUE (called by cron)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.process_notification_digest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_frequency text;
  v_notifications jsonb;
  v_count int := 0;
  v_users_processed int := 0;
BEGIN
  -- Process pending digests that are due
  FOR v_user_id, v_frequency IN
    SELECT DISTINCT user_id, frequency
    FROM notification_digest_queue
    WHERE status = 'pending'
      AND scheduled_for <= now()
    ORDER BY user_id
  LOOP
    -- Get all pending notifications for this user/frequency
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', id,
        'type', notification_type,
        'category', category,
        'title', title,
        'body', body,
        'data', data
      )
    ) INTO v_notifications
    FROM notification_digest_queue
    WHERE user_id = v_user_id
      AND frequency = v_frequency
      AND status = 'pending'
      AND scheduled_for <= now();

    -- Mark as sent (actual sending is done by caller)
    UPDATE notification_digest_queue
    SET status = 'sent', sent_at = now()
    WHERE user_id = v_user_id
      AND frequency = v_frequency
      AND status = 'pending'
      AND scheduled_for <= now();

    v_count := v_count + jsonb_array_length(v_notifications);
    v_users_processed := v_users_processed + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_count,
    'users', v_users_processed
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_notification_digest TO service_role;

-- =============================================================================
-- SUMMARY
-- =============================================================================
-- Tables: notification_preferences, notification_settings, notification_digest_queue
-- Functions:
--   - should_send_notification(user_id, category, channel) -> {send, reason, ...}
--   - get_notification_preferences(user_id) -> full settings for UI
--   - update_notification_preference(user_id, category, channel, enabled, frequency)
--   - update_notification_settings(user_id, settings_jsonb)
--   - init_notification_preferences(user_id) -> auto-create defaults
--   - verify_phone_for_sms(user_id, phone, code)
--   - process_notification_digest() -> process pending digests
